import { Telegraf } from 'telegraf'
import { parse115ShareLinks } from './shareLinks.js'

export class TelegramService {
  constructor({ repo, taskRunner }) {
    this.repo = repo
    this.taskRunner = taskRunner
    this.bot = null
  }

  async restart() {
    await this.stop()
    const settings = this.repo.getSettings()
    if (!settings.telegramBotToken) return false
    this.bot = new Telegraf(settings.telegramBotToken)
    this.bot.on('message', async (ctx) => {
      const chatId = String(ctx.chat?.id || '')
      const allowed = String(this.repo.getSettings().telegramChatId || '').trim()
      if (allowed && chatId !== allowed) return
      const text = ctx.message?.text || ctx.message?.caption || ''
      await this.handleText(text, { chatId, messageId: String(ctx.message?.message_id || '') })
    })
    await this.bot.launch()
    return true
  }

  async stop() {
    if (this.bot) {
      this.bot.stop('restart')
      this.bot = null
    }
  }

  async handleText(text, source = {}) {
    const links = parse115ShareLinks(text)
    for (const link of links) {
      const existing = this.repo.findTask(link.shareCode, link.receiveCode)
      if (existing?.status === 'success') {
        this.repo.addEvent(existing.id, 'info', '重复分享已跳过')
        continue
      }
      const task = existing || this.repo.upsertTask({ ...link, source: 'telegram', telegramChatId: source.chatId, telegramMessageId: source.messageId })
      this.taskRunner.run(task.id).catch((error) => this.repo.addEvent(task.id, 'error', error.message))
    }
    return links.length
  }

  async notify(message) {
    const settings = this.repo.getSettings()
    if (!this.bot || !settings.telegramNotifyChatId) return
    await this.bot.telegram.sendMessage(settings.telegramNotifyChatId, message)
  }
}

