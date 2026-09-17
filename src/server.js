import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import crypto from 'node:crypto'
import axios from 'axios'
import Fastify from 'fastify'
import cookie from '@fastify/cookie'
import { z } from 'zod'

import { ADMIN_PASSWORD, DATA_DIR, PORT, ensureDataDirs } from './config.js'
import { openDb, createRepository } from './db.js'
import { Service115 } from './service115.js'
import { Organizer115 } from './organizer115.js'
import { TaskRunner } from './taskRunner.js'
import { TaskWorker } from './taskWorker.js'
import { TelegramService } from './telegram.js'
import { parse115ShareLinks } from './shareLinks.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const publicDir = join(__dirname, '..', 'public')

ensureDataDirs()
const db = openDb()
const repo = createRepository(db)
const receiver = new Service115()
const organizer = new Organizer115()
let telegram
const taskRunner = new TaskRunner({ repo, receiver, organizer })
telegram = new TelegramService({ repo })
const taskWorker = new TaskWorker({ repo, runner: taskRunner, notifier: async (message, options) => telegram.notify(message, options) })

const sessions = new Set()
const oauth115 = { running: false, qrcode: '', status: 'idle', error: '', account: null }

function maskSettings(settings) {
  return {
    ...settings,
    cookie115: settings.cookie115 ? '已配置' : '',
    telegramBotToken: settings.telegramBotToken ? '已配置' : '',
    hasCookie115: Boolean(settings.cookie115),
    hasTelegramBotToken: Boolean(settings.telegramBotToken),
  }
}

function requireAuth(req, reply, done) {
  const token = req.cookies?.session
  if (!token || !sessions.has(token)) {
    reply.code(401).send({ ok: false, error: 'unauthorized' })
    return
  }
  done()
}

async function buildServer() {
  const app = Fastify({ logger: true })
  await app.register(cookie)

  app.get('/', async (_req, reply) => {
    reply.type('text/html; charset=utf-8')
    return readFile(join(publicDir, 'index.html'), 'utf8')
  })

  app.get('/app.js', async (_req, reply) => {
    reply.type('application/javascript; charset=utf-8')
    return readFile(join(publicDir, 'app.js'), 'utf8')
  })

  app.post('/api/admin/login', async (req, reply) => {
    const body = z.object({ password: z.string() }).parse(req.body || {})
    if (body.password !== ADMIN_PASSWORD) return reply.code(401).send({ ok: false, error: '密码错误' })
    const session = crypto.randomBytes(24).toString('hex')
    sessions.add(session)
    reply.setCookie('session', session, { path: '/', httpOnly: true, sameSite: 'lax' })
    return { ok: true }
  })

  app.get('/api/settings', { preHandler: requireAuth }, async () => {
    return { ok: true, dataDir: DATA_DIR, settings: maskSettings(repo.getSettings()), accounts: await organizer.listAccounts() }
  })

  app.put('/api/settings', { preHandler: requireAuth }, async (req) => {
    const body = z.object({
      cookie115: z.string().optional(),
      telegramBotToken: z.string().optional(),
      telegramChatId: z.string().optional(),
      telegramNotifyChatId: z.string().optional(),
      targetRootCid: z.string().optional(),
      clearCookie115: z.boolean().optional(),
      clearTelegramBotToken: z.boolean().optional(),
    }).parse(req.body || {})
    const current = repo.getSettings()
    const next = { ...current }
    for (const [key, value] of Object.entries(body)) {
      if (key === 'clearCookie115' || key === 'clearTelegramBotToken') continue
      if (value === undefined) continue
      if ((key === 'cookie115' || key === 'telegramBotToken') && (!value.trim() || value.trim() === '已配置')) continue
      next[key] = value
    }
    if (body.clearCookie115) next.cookie115 = ''
    if (body.clearTelegramBotToken) next.telegramBotToken = ''
    repo.putSettings(next)
    if (next.telegramBotToken !== current.telegramBotToken || (next.telegramBotToken && !telegram.bot)) await telegram.restart()
    return { ok: true, settings: maskSettings(repo.getSettings()) }
  })

  app.post('/api/settings/test-115-cookie', { preHandler: requireAuth }, async () => {
    const settings = repo.getSettings()
    const info = await receiver.getUserInfo(settings.cookie115 || '')
    return { ok: true, info }
  })

  app.post('/api/settings/test-telegram', { preHandler: requireAuth }, async () => {
    const token = repo.getSettings().telegramBotToken
    if (!token) throw new Error('未配置 Telegram Bot Token')
    const res = await axios.get(`https://api.telegram.org/bot${token}/getMe`, { timeout: 8000 })
    if (!res.data?.ok) throw new Error(res.data?.description || 'Telegram Bot 测试失败')
    return { ok: true, bot: res.data.result }
  })

  app.post('/api/settings/115-oauth/start', { preHandler: requireAuth }, async () => {
    if (oauth115.running) return { ok: true, ...oauth115 }
    Object.assign(oauth115, { running: true, qrcode: '', status: 'waiting', error: '', account: null })
    organizer.startQrLogin({
      onQrCode: async (qrcode) => { oauth115.qrcode = qrcode },
      timeoutMs: 120000,
    }).then((account) => {
      Object.assign(oauth115, { running: false, status: 'success', account })
    }).catch((error) => {
      Object.assign(oauth115, { running: false, status: 'failed', error: error.message })
    })
    for (let i = 0; i < 50; i++) {
      if (oauth115.qrcode || oauth115.error) break
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    return { ok: true, ...oauth115 }
  })

  app.get('/api/settings/115-oauth/status', { preHandler: requireAuth }, async () => {
    return { ok: true, ...oauth115, accounts: await organizer.listAccounts() }
  })

  app.post('/api/settings/test-115-oauth', { preHandler: requireAuth }, async () => {
    const token = await organizer.getToken()
    const list = await organizer.list('0')
    return { ok: true, user: token.user_id || token.accountId || '115', rootItems: list.length }
  })

  app.get('/api/tasks', { preHandler: requireAuth }, async (req) => {
    const limit = Math.min(Number(req.query?.limit || 100), 500)
    return { ok: true, tasks: repo.listTasks(limit), events: repo.listEvents(null, 30) }
  })

  app.get('/api/tasks/:id', { preHandler: requireAuth }, async (req) => {
    const id = Number(req.params.id)
    return { ok: true, task: repo.getTask(id), files: repo.listTaskFiles(id), events: repo.listEvents(id, 100) }
  })

  app.post('/api/tasks/manual', { preHandler: requireAuth }, async (req) => {
    const body = z.object({ text: z.string().min(1) }).parse(req.body || {})
    const links = parse115ShareLinks(body.text)
    const tasks = []
    for (const link of links) {
      const task = repo.upsertTask({ ...link, source: 'manual' })
      tasks.push(task)
    }
    return { ok: true, count: tasks.length, tasks }
  })

  app.post('/api/tasks/:id/retry', { preHandler: requireAuth }, async (req) => {
    const id = Number(req.params.id)
    const task = repo.getTask(id)
    if (!task) return { ok: false, error: '任务不存在' }
    return { ok: true, task: repo.retryTask(id) }
  })

  app.setErrorHandler((error, _req, reply) => {
    app.log.error(error)
    reply.code(error.statusCode || 500).send({ ok: false, error: error.message || 'server error' })
  })

  return app
}

const app = await buildServer()
await app.listen({ port: PORT, host: '0.0.0.0' })
taskWorker.start()
await telegram.restart().catch((error) => app.log.warn(error, 'telegram start failed'))

/** 停止接收新请求、工作器和外部服务，再关闭数据库。 */
async function shutdown() {
  await app.close()
  await taskWorker.stop()
  await telegram.stop()
  db.close()
}

process.once('SIGINT', async () => { await shutdown(); process.exit(0) })
process.once('SIGTERM', async () => { await shutdown(); process.exit(0) })
