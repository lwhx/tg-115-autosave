import { Telegraf } from 'telegraf'
import { parse115ShareLinks } from './shareLinks.js'

export class TelegramService {
  constructor({ repo }) {
    this.repo = repo
    this.bot = null
    this.session = null
    this.lifecycle = Promise.resolve()
  }

  restart() {
    const operation = this.lifecycle.catch(() => {}).then(() => this.startBot())
    this.lifecycle = operation
    return operation
  }

  async startBot() {
    await this.stopBot()
    const settings = this.repo.getSettings()
    if (!settings.telegramBotToken) return false
    const session = { bot: null, stopping: false, finished: false, promise: null, controller: new AbortController(), wakeRetry: null }
    this.session = session
    // 启动重试和轮询都属于后台会话，不能阻塞设置保存或 Web 服务启动。
    session.promise = this.runSession(session, settings.telegramBotToken).catch((error) => {
      if (!session.stopping) this.reportError(error)
    }).finally(() => {
      session.finished = true
      if (this.session === session) {
        this.session = null
        this.bot = null
      }
    })
    return true
  }

  createBot(token, session) {
    const bot = new Telegraf(token)
    const callApi = bot.telegram.callApi.bind(bot.telegram)
    // launch 的初始化请求没有轮询器可供 stop() 停止，单独加上取消和超时。
    bot.telegram.callApi = (method, payload, options = {}) => {
      if (method !== 'getMe' && method !== 'deleteWebhook') return callApi(method, payload, options)
      const signals = [session.controller.signal, AbortSignal.timeout(30000)]
      if (options.signal) signals.push(options.signal)
      return callApi(method, payload, { ...options, signal: AbortSignal.any(signals) })
    }
    bot.on(['message', 'channel_post'], async (ctx) => {
      const message = ctx.message || ctx.channelPost
      const chatId = String(ctx.chat?.id || '')
      const allowed = String(this.repo.getSettings().telegramChatId || '').trim()
      if (allowed && chatId !== allowed) return
      const text = message?.text || message?.caption || ''
      await this.handleText(text, { chatId, messageId: String(message?.message_id || '') })
    })
    bot.catch((error) => this.reportError(error))
    return bot
  }

  async runSession(session, token) {
    let failures = 0
    while (!session.stopping) {
      const bot = this.createBot(token, session)
      session.bot = bot
      this.bot = bot
      const startedAt = Date.now()
      let failure
      try {
        await bot.launch({ allowedUpdates: ['message', 'channel_post'] }, () => {
          if (session.stopping) throw new Error('Telegram startup cancelled')
        })
        if (!session.stopping) failure = new Error('Telegram polling ended unexpectedly')
      } catch (error) {
        failure = error
      } finally {
        session.bot = null
        if (this.bot === bot) this.bot = null
      }
      if (session.stopping) return
      const status = Number(failure?.response?.error_code || failure?.status || failure?.code)
      // 无效凭据/参数或并行轮询冲突需要用户处理，不能无限重复请求。
      if (status >= 400 && status < 500 && status !== 429) {
        this.reportError(failure)
        return
      }
      if (Date.now() - startedAt > 60000) failures = 0
      const backoff = Math.min(60000, 1000 * 2 ** Math.min(failures++, 6))
      const retryAfter = Number(failure?.response?.parameters?.retry_after) * 1000 || 0
      const delay = Math.max(backoff, retryAfter)
      this.reportError(new Error(`${failure?.message || String(failure)}；${Math.ceil(delay / 1000)} 秒后重试`))
      await new Promise((resolve) => {
        const timer = setTimeout(wake, delay)
        function wake() {
          clearTimeout(timer)
          session.wakeRetry = null
          resolve()
        }
        session.wakeRetry = wake
        if (session.stopping) wake()
      })
    }
  }

  reportError(error) {
    try { this.repo.addEvent(null, 'error', `Telegram：${error.message || String(error)}`) }
    catch { console.error('Telegram service failed to record an error') }
  }

  stop() {
    const operation = this.lifecycle.catch(() => {}).then(() => this.stopBot())
    this.lifecycle = operation
    return operation
  }

  async stopBot() {
    const session = this.session
    if (!session) return
    session.stopping = true
    session.controller.abort()
    session.wakeRetry?.()
    const stopPolling = () => {
      if (session.finished || !session.bot) return
      try { session.bot.stop('restart') }
      catch (error) {
        // getMe/deleteWebhook 尚未完成时，Telegraf 没有可停止的轮询器。
        if (error.message !== 'Bot is not running!') this.reportError(error)
      }
    }
    stopPolling()
    const timer = setInterval(stopPolling, 50)
    try { await session.promise }
    finally { clearInterval(timer) }
    if (this.session === session) {
      this.session = null
      this.bot = null
    }
  }

  async handleText(text, source = {}) {
    const links = parse115ShareLinks(text)
    for (const link of links) {
      const existing = this.repo.findTask(link.shareCode, link.receiveCode)
      if (existing?.status === 'completed') {
        this.repo.addEvent(existing.id, 'info', '重复分享已跳过')
        continue
      }
      if (!existing) this.repo.upsertTask({ ...link, source: 'telegram', telegramChatId: source.chatId, telegramMessageId: source.messageId })
    }
    return links.length
  }

  /**
   * 发送持久化队列中的通知。
   * @param {string} message 通知内容。
   * @returns {Promise<void>} 发送完成。
   * @throws {Error} Telegram 未配置或发送失败。
   */
  async notify(message, { signal } = {}) {
    const settings = this.repo.getSettings()
    if (!settings.telegramBotToken || !settings.telegramNotifyChatId) throw new Error('未配置 Telegram 通知')
    if (!this.bot) throw new Error('Telegram Bot 尚未启动')
    const timeout = AbortSignal.timeout(30000)
    await this.bot.telegram.callApi('sendMessage', { chat_id: settings.telegramNotifyChatId, text: message }, {
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    })
  }
}
