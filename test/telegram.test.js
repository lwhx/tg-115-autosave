import assert from 'node:assert/strict'
import test from 'node:test'
import { TelegramService } from '../src/telegram.js'

/** 创建内存 Telegram 仓库。 */
function repository(settings = {}) {
  const tasks = []
  const events = []
  return {
    tasks, events,
    getSettings() { return settings },
    findTask(shareCode, receiveCode) { return tasks.find((task) => task.share_code === shareCode && task.receive_code === receiveCode) },
    upsertTask(input) { const task = { id: tasks.length + 1, share_code: input.shareCode, receive_code: input.receiveCode, ...input }; tasks.push(task); return task },
    addEvent(...args) { events.push(args) },
  }
}

test('handleText 入队新分享并跳过已完成重复分享', async () => {
  const repo = repository()
  const service = new TelegramService({ repo })
  assert.equal(await service.handleText('https://115.com/s/abc?password=zz99', { chatId: '1', messageId: '2' }), 1)
  assert.equal(repo.tasks[0].source, 'telegram')
  assert.equal(repo.tasks[0].telegramChatId, '1')
  repo.tasks[0].status = 'completed'
  await service.handleText('https://115.com/s/abc?password=zz99')
  assert.equal(repo.tasks.length, 1)
  assert.equal(repo.events[0][2], '重复分享已跳过')
})

test('notify 校验配置和 bot，并通过 callApi 发送消息', async () => {
  const service = new TelegramService({ repo: repository({ telegramBotToken: 'token', telegramNotifyChatId: 'chat' }) })
  await assert.rejects(() => service.notify('消息'), /尚未启动/)
  let request
  service.bot = { telegram: { async callApi(...args) { request = args } } }
  await service.notify('消息')
  assert.equal(request[0], 'sendMessage')
  assert.deepEqual(request[1], { chat_id: 'chat', text: '消息' })
  const missing = new TelegramService({ repo: repository({}) })
  await assert.rejects(() => missing.notify('消息'), /未配置/)
})

test('无 Token 时不启动后台会话', async () => {
  const service = new TelegramService({ repo: repository({}) })
  assert.equal(await service.startBot(), false)
  assert.equal(service.session, null)
})

test('runSession 遇到 4xx 不重试，429 按 retry_after 退避并可停止', async () => {
  const repo = repository()
  const service = new TelegramService({ repo })
  let launches = 0
  service.createBot = () => ({ async launch() { launches += 1; const error = new Error('bad'); error.response = { error_code: 401 }; throw error } })
  const first = { stopping: false, controller: new AbortController(), bot: null }
  await service.runSession(first, 'token')
  assert.equal(launches, 1)

  launches = 0
  service.createBot = () => ({ async launch() {
    launches += 1
    const error = new Error('limited')
    error.response = { error_code: 429, parameters: { retry_after: 0.001 } }
    throw error
  } })
  const second = { stopping: false, controller: new AbortController(), bot: null, wakeRetry: null }
  const running = service.runSession(second, 'token')
  while (!second.wakeRetry) await new Promise((resolve) => setImmediate(resolve))
  second.stopping = true
  second.wakeRetry()
  await running
  assert.equal(launches, 1)
})
