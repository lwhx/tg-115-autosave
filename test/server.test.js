import assert from 'node:assert/strict'
import test from 'node:test'
import { buildServer } from '../src/server.js'

/** 创建 API 测试依赖。 */
function fixture() {
  let settings = { cookie115: 'cookie-secret', telegramBotToken: 'bot-secret' }
  const tasks = []
  let lastLimit
  const repo = {
    getSettings() { return { ...settings } }, putSettings(value) { settings = { ...value }; return settings },
    listTasks(limit) { lastLimit = limit; return tasks.slice(0, limit) }, listEvents() { return [] },
    getTask(id) { return tasks.find((task) => task.id === id) || null }, listTaskFiles() { return [] },
    upsertTask(input) { const existing = tasks.find((task) => task.share_code === input.shareCode); if (existing) return existing; const task = { id: tasks.length + 1, share_code: input.shareCode, status: 'queued', ...input }; tasks.push(task); return task },
    retryTask(id) { const task = this.getTask(id); if (task.status === 'running') { const error = new Error('任务正在执行'); error.statusCode = 409; throw error } task.status = 'queued'; return task },
  }
  const organizer = { async listAccounts() { return [] }, async getToken() { return {} }, async list() { return [] } }
  const telegram = { bot: {}, restarts: 0, async restart() { this.restarts += 1 } }
  return { repo, organizer, telegram, tasks, getSettings: () => settings, getLastLimit: () => lastLimit }
}

/** 登录并返回 Cookie。 */
async function login(app, password = 'pw') {
  const response = await app.inject({ method: 'POST', url: '/api/admin/login', payload: { password } })
  return { response, cookie: response.headers['set-cookie']?.split(';')[0] }
}

test('API 登录认证、设置掩码与密钥保留和清除', async (context) => {
  const item = fixture()
  const app = await buildServer({ ...item, adminPassword: 'pw' })
  context.after(() => app.close())
  assert.equal((await app.inject('/api/settings')).statusCode, 401)
  assert.equal((await login(app, 'wrong')).response.statusCode, 401)
  const { cookie } = await login(app)
  const settingsResponse = await app.inject({ url: '/api/settings', headers: { cookie } })
  assert.equal(settingsResponse.json().settings.cookie115, '已配置')
  assert.equal(JSON.stringify(settingsResponse.json()).includes('cookie-secret'), false)
  await app.inject({ method: 'PUT', url: '/api/settings', headers: { cookie }, payload: { cookie115: '已配置', telegramBotToken: '', targetRootCid: '9' } })
  assert.equal(item.getSettings().cookie115, 'cookie-secret')
  assert.equal(item.getSettings().telegramBotToken, 'bot-secret')
  await app.inject({ method: 'PUT', url: '/api/settings', headers: { cookie }, payload: { clearCookie115: true, clearTelegramBotToken: true } })
  assert.equal(item.getSettings().cookie115, '')
  assert.equal(item.getSettings().telegramBotToken, '')
})

test('API 手动任务、列表限制和重试成功/冲突', async (context) => {
  const item = fixture()
  const app = await buildServer({ ...item, adminPassword: 'pw' })
  context.after(() => app.close())
  const { cookie } = await login(app)
  const manual = await app.inject({ method: 'POST', url: '/api/tasks/manual', headers: { cookie }, payload: { text: 'https://115.com/s/abc' } })
  assert.equal(manual.json().count, 1)
  await app.inject({ url: '/api/tasks?limit=9999', headers: { cookie } })
  assert.equal(item.getLastLimit(), 500)
  const retry = await app.inject({ method: 'POST', url: '/api/tasks/1/retry', headers: { cookie } })
  assert.equal(retry.statusCode, 200)
  item.tasks[0].status = 'running'
  const conflict = await app.inject({ method: 'POST', url: '/api/tasks/1/retry', headers: { cookie } })
  assert.equal(conflict.statusCode, 409)
  assert.equal(conflict.json().ok, false)
})

test('API 校验错误返回结构化响应且非法列表限制回退默认值', async (context) => {
  const item = fixture()
  const app = await buildServer({ ...item, adminPassword: 'pw' })
  context.after(() => app.close())
  const { cookie } = await login(app)
  const invalid = await app.inject({ method: 'POST', url: '/api/tasks/manual', headers: { cookie }, payload: {} })
  assert.equal(invalid.statusCode, 500)
  assert.equal(invalid.json().ok, false)
  await app.inject({ url: '/api/tasks?limit=bad', headers: { cookie } })
  assert.equal(item.getLastLimit(), 100)
})
