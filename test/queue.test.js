import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import crypto from 'node:crypto'
import Database from 'better-sqlite3'
import { openDb, createRepository } from '../src/db.js'
import { TaskRunner } from '../src/taskRunner.js'
import { TaskWorker } from '../src/taskWorker.js'
import { TaskError } from '../src/taskError.js'

/** 测试结束后需要关闭的数据库。 */
const databases = []

afterEach(() => {
  while (databases.length) databases.pop().close()
})

/**
 * 创建内存仓库。
 * @returns {{db: Database.Database, repo: object}} 数据库与仓库。
 */
function createTestRepository() {
  const db = openDb(':memory:')
  databases.push(db)
  return { db, repo: createRepository(db) }
}

test('旧数据库可增量迁移且保留数据', () => {
  const directory = mkdtempSync(join(tmpdir(), 'autosave-migration-'))
  const path = join(directory, 'legacy.db')
  const legacy = new Database(path)
  legacy.exec(`
    CREATE TABLE tasks (id INTEGER PRIMARY KEY, share_code TEXT NOT NULL, receive_code TEXT NOT NULL DEFAULT '', raw_url TEXT NOT NULL DEFAULT '', title TEXT NOT NULL DEFAULT '', status TEXT NOT NULL, source TEXT NOT NULL DEFAULT '', telegram_chat_id TEXT NOT NULL DEFAULT '', telegram_message_id TEXT NOT NULL DEFAULT '', target_cid TEXT NOT NULL DEFAULT '', target_path TEXT NOT NULL DEFAULT '', error TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(share_code, receive_code));
    INSERT INTO tasks VALUES (1, 'abc', '', '', '', 'pending', '', '', '', '', '', '', '2020-01-01', '2020-01-01');
  `)
  legacy.close()
  const migrated = openDb(path)
  const columns = new Set(migrated.prepare('PRAGMA table_info(tasks)').all().map((column) => column.name))
  assert.equal(columns.has('stage'), true)
  assert.equal(migrated.prepare('SELECT status, stage FROM tasks WHERE id = 1').get().status, 'queued')
  assert.equal(migrated.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'notifications'").get().name, 'notifications')
  migrated.close()
  rmSync(directory, { recursive: true, force: true })
})

test('原子领取与过期租约恢复不会重复领取且每次领取计数一次', () => {
  const { repo } = createTestRepository()
  const task = repo.upsertTask({ shareCode: 'atomic' })
  assert.equal(repo.claimNextTask('worker-a', 60000).attempt_count, 1)
  assert.equal(repo.claimNextTask('worker-b', 60000), null)
  repo.updateTask(task.id, { lease_expires_at: '2000-01-01T00:00:00.000Z' })
  assert.equal(repo.recoverExpiredTaskLeases(), 1)
  assert.equal(repo.claimNextTask('worker-b', 60000).attempt_count, 2)
})

test('任务失败调度不重复增加次数且最后一次执行失败进入终态', () => {
  const { repo } = createTestRepository()
  const task = repo.upsertTask({ shareCode: 'attempts' })
  repo.updateTask(task.id, { max_attempts: 2 })
  const first = repo.claimNextTask('worker-a', 60000)
  assert.equal(first.attempt_count, 1)
  const waiting = repo.scheduleTaskRetry(task.id, 'worker-a', new TaskError('TEMPORARY', '暂时失败', { retryable: true }), 1000)
  assert.equal(waiting.attempt_count, 1)
  assert.equal(waiting.status, 'retry_wait')
  repo.updateTask(task.id, { next_run_at: '2000-01-01T00:00:00.000Z' })
  const second = repo.claimNextTask('worker-b', 60000)
  assert.equal(second.attempt_count, 2)
  const failed = repo.scheduleTaskRetry(task.id, 'worker-b', new TaskError('TEMPORARY', '仍然失败', { retryable: true }), 1000)
  assert.equal(failed.attempt_count, 2)
  assert.equal(failed.status, 'failed')
  assert.equal(repo.claimNextTask('worker-c', 60000), null)
})

test('重试延迟按实际执行次数计算', () => {
  const worker = new TaskWorker({ repo: {}, runner: {}, random: () => 0.5 })
  assert.equal(worker.retryDelay(0), 1000)
  assert.equal(worker.retryDelay(1), 2000)
})

test('普通重试保留阶段并清理次数错误和租约', () => {
  const { repo } = createTestRepository()
  const task = repo.upsertTask({ shareCode: 'retry' })
  repo.updateTask(task.id, { stage: 'directory_ready', status: 'failed', attempt_count: 4, error: '失败', lease_owner: 'old' })
  const retried = repo.retryTask(task.id)
  assert.equal(retried.stage, 'directory_ready')
  assert.equal(retried.status, 'queued')
  assert.equal(retried.attempt_count, 0)
  assert.equal(retried.error, '')
  assert.equal(retried.lease_owner, '')
})

test('通知按任务和类型去重并可完成', () => {
  const { repo } = createTestRepository()
  const task = repo.upsertTask({ shareCode: 'notification' })
  repo.enqueueNotification(task.id, 'completed', '第一次')
  repo.enqueueNotification(task.id, 'completed', '第二次')
  assert.equal(repo.listNotifications(task.id).length, 1)
  const item = repo.claimNextNotification('notifier')
  assert.equal(repo.completeNotification(item.id, 'notifier'), true)
  assert.equal(repo.listNotifications(task.id)[0].status, 'sent')
})

test('通知仅允许抢占租约已过期的 sending 记录', () => {
  const { db, repo } = createTestRepository()
  const task = repo.upsertTask({ shareCode: 'notification-lease' })
  const item = repo.enqueueNotification(task.id, 'completed', '消息')
  assert.equal(repo.claimNextNotification('notifier-a', 60000).id, item.id)
  assert.equal(repo.claimNextNotification('notifier-b', 60000), null)
  db.prepare("UPDATE notifications SET lease_expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(item.id)
  assert.equal(repo.claimNextNotification('notifier-b', 60000).lease_owner, 'notifier-b')
})

test('阶段与关键任务写入拒绝非租约所有者覆盖', () => {
  const { repo } = createTestRepository()
  const task = repo.upsertTask({ shareCode: 'lease-write' })
  repo.claimNextTask('worker-a', 60000)
  assert.equal(repo.updateStage(task.id, 'worker-b', 'share_resolved', { title: '错误覆盖' }), null)
  assert.equal(repo.updateTaskWithLease(task.id, 'worker-b', { folder_date: '2099-01-01' }), null)
  assert.equal(repo.getTask(task.id).stage, 'queued')
  assert.equal(repo.getTask(task.id).folder_date, '')
  assert.equal(repo.updateStage(task.id, 'worker-a', 'share_resolved', { title: '正确写入' }).stage, 'share_resolved')
})

test('TaskRunner 外部操作后失去租约时抛出结构化停止错误', async () => {
  const { repo } = createTestRepository()
  repo.putSettings({ cookie115: 'cookie' })
  const task = repo.upsertTask({ shareCode: 'lease-lost' })
  repo.claimNextTask('worker-a', 60000)
  let replaced = false
  const originalReplace = repo.replaceTaskFiles.bind(repo)
  repo.replaceTaskFiles = (...args) => { replaced = true; return originalReplace(...args) }
  const receiver = {
    async getShareInfo() {
      repo.updateTask(task.id, { lease_owner: 'worker-b' })
      return { shareTitle: '测试', fileIds: ['f1'], files: [{ shareFileId: 'f1', name: 'video.mp4' }] }
    },
  }
  const runner = new TaskRunner({ repo, receiver, organizer: {} })
  await assert.rejects(() => runner.execute(task.id, 'worker-a'), (error) => error.code === 'LEASE_LOST')
  assert.equal(replaced, false)
})

test('TaskRunner 从 files_confirmed 阶段恢复且不重复转存', async () => {
  const { repo } = createTestRepository()
  repo.putSettings({ cookie115: 'cookie' })
  const task = repo.upsertTask({ shareCode: 'resume' })
  repo.claimNextTask('worker', 60000)
  repo.updateStage(task.id, 'worker', 'files_confirmed', { title: '测试', target_path: '目标' })
  repo.replaceTaskFiles(task.id, [{ savedFileId: 'f1', name: 'video.mp4', type: 'file' }])
  let saveCount = 0
  const receiver = {
    async saveFiles() { saveCount += 1; return { success: true } },
    async getShareInfo() { throw new Error('不应重新解析') },
  }
  const organizer = {
    async renameFile(fileId, newName) { return { fileId, newName, status: 'success' } },
  }
  const runner = new TaskRunner({ repo, receiver, organizer })
  const completed = await runner.execute(task.id, 'worker')
  assert.equal(completed.stage, 'completed')
  assert.equal(completed.status, 'completed')
  assert.equal(saveCount, 0)
  assert.equal(repo.listNotifications(task.id).length, 1)
})

test('TaskRunner 完成 queued 到 completed 全流程并仅补转缺失文件', async () => {
  const { repo } = createTestRepository()
  repo.putSettings({ cookie115: 'cookie', targetRootCid: 'root' })
  const task = repo.upsertTask({ shareCode: 'full-flow' })
  repo.claimNextTask('worker', 60000)
  const saved = [{ fileId: 'saved-1', name: '正常.mp4', type: 'file', size: 1 }, { fileId: 'saved-2', name: '[广告]电影.mkv', type: 'file', size: 2 }]
  let saveIds
  const receiver = {
    async getShareInfo() { return { shareTitle: '影视', fileIds: ['share-1', 'share-2'], files: [{ shareFileId: 'share-1', name: '正常.mp4', type: 'file', size: 1 }, { shareFileId: 'share-2', name: '[广告]电影.mkv', type: 'file', size: 2 }] } },
    async saveFiles(_cookie, _cid, _code, _password, ids) { saveIds = ids; return { success: true } },
  }
  const organizer = {
    async ensureFolder(_parent, name) { return { fileId: name } },
    async list() { return [] },
    async waitForFiles() { return saved },
    async renameFile(fileId, newName) { return { fileId, newName, status: 'success' } },
  }
  const completed = await new TaskRunner({ repo, receiver, organizer, transferRetryWindowMs: 0 }).execute(task.id, 'worker')
  assert.equal(completed.status, 'completed')
  assert.deepEqual(saveIds, ['share-1', 'share-2'])
  assert.deepEqual(repo.listTaskFiles(task.id).map((file) => file.saved_file_id), ['saved-1', 'saved-2'])
  assert.equal(repo.listTaskFiles(task.id)[1].name, '电影.mkv')
})

test('TaskRunner 拒绝清单指纹不一致、目录冲突和额外文件', async () => {
  const cases = [
    { code: 'MANIFEST_MISMATCH', count: 2, hash: 'invalid', list: [] },
    { code: 'DIRECTORY_CONFLICT', count: 1, hash: crypto.createHash('sha256').update('one').digest('hex'), list: [{ fileId: 'x', name: 'a', type: 'file' }] },
    { code: 'CONTENT_MISMATCH', count: 1, hash: crypto.createHash('sha256').update('one').digest('hex'), requestedAt: new Date().toISOString(), list: [{ fileId: 'x', name: 'extra', type: 'file' }] },
  ]
  for (const item of cases) {
    const { repo } = createTestRepository()
    repo.putSettings({ cookie115: 'cookie' })
    const task = repo.upsertTask({ shareCode: `mismatch-${item.code}` })
    repo.claimNextTask('worker', 60000)
    repo.updateStage(task.id, 'worker', 'transfer_requesting', { target_cid: 'target', expected_file_count: item.count, expected_fingerprint: item.hash, transfer_requested_at: item.requestedAt || '', directory_isolated: 1 })
    repo.replaceTaskFiles(task.id, [{ shareFileId: 'one', name: 'a', type: 'file' }])
    const runner = new TaskRunner({ repo, receiver: {}, organizer: { async list() { return item.list } } })
    await assert.rejects(() => runner.execute(task.id, 'worker'), (error) => error.code === item.code)
  }
})

test('TaskRunner 部分存在时仅补转缺失文件', async () => {
  const { repo } = createTestRepository()
  repo.putSettings({ cookie115: 'cookie' })
  const task = repo.upsertTask({ shareCode: 'partial' })
  repo.claimNextTask('worker', 60000)
  const fingerprint = crypto.createHash('sha256').update('one,two').digest('hex')
  repo.updateStage(task.id, 'worker', 'transfer_requested', { target_cid: 'target', expected_file_count: 2, expected_fingerprint: fingerprint, transfer_requested_at: '2000-01-01T00:00:00.000Z', directory_isolated: 1 })
  repo.replaceTaskFiles(task.id, [{ shareFileId: 'one', name: 'a', type: 'file' }, { shareFileId: 'two', name: 'b', type: 'file' }])
  let ids
  const saved = [{ fileId: 'saved-a', name: 'a', type: 'file' }, { fileId: 'saved-b', name: 'b', type: 'file' }]
  const runner = new TaskRunner({
    repo, transferRetryWindowMs: 0,
    receiver: { async saveFiles(_cookie, _target, _share, _receive, value) { ids = value; return { success: true } } },
    organizer: { async list() { return [saved[0]] }, async waitForFiles() { return saved }, async renameFile(fileId, newName) { return { fileId, newName, status: 'success' } } },
  })
  assert.equal((await runner.execute(task.id, 'worker')).status, 'completed')
  assert.deepEqual(ids, ['two'])
})

test('TaskRunner 确认窗口内不重复发起转存并携带 retryAt', async () => {
  const { repo } = createTestRepository()
  repo.putSettings({ cookie115: 'cookie' })
  const task = repo.upsertTask({ shareCode: 'confirm-window' })
  repo.claimNextTask('worker', 60000)
  const fingerprint = crypto.createHash('sha256').update('one').digest('hex')
  repo.updateStage(task.id, 'worker', 'transfer_requested', { target_cid: 'target', expected_file_count: 1, expected_fingerprint: fingerprint, transfer_requested_at: new Date().toISOString(), directory_isolated: 1 })
  repo.replaceTaskFiles(task.id, [{ shareFileId: 'one', name: 'a', type: 'file' }])
  let saves = 0
  const runner = new TaskRunner({ repo, receiver: { async saveFiles() { saves += 1 } }, organizer: { async list() { return [] } }, transferRetryWindowMs: 60000 })
  await assert.rejects(() => runner.execute(task.id, 'worker'), (error) => error.code === 'TEMPORARY' && error.retryAt > Date.now())
  assert.equal(saves, 0)
})

test('仓库终态映射、retryAt、字段白名单和非 owner 约束', () => {
  const { repo } = createTestRepository()
  const task = repo.upsertTask({ shareCode: 'repo-rules' })
  repo.updateTask(task.id, { unknown: 'ignored', title: '合法' })
  assert.equal(repo.getTask(task.id).unknown, undefined)
  const claimed = repo.claimNextTask('owner', 60000)
  assert.equal(repo.scheduleTaskRetry(task.id, 'other', new TaskError('TEMPORARY', '错误', { retryable: true }), 0), null)
  const retryAt = Date.now() + 60000
  const waiting = repo.scheduleTaskRetry(task.id, 'owner', new TaskError('TEMPORARY', '稍后', { retryable: true, retryAt }), 0)
  assert.equal(waiting.status, 'retry_wait')
  assert.ok(Date.parse(waiting.next_run_at) >= retryAt)
  repo.updateTask(task.id, { next_run_at: '2000-01-01T00:00:00.000Z' })
  repo.claimNextTask('owner2', 60000)
  const attention = repo.scheduleTaskRetry(task.id, 'owner2', new TaskError('AUTH_CONFIG', '认证', { attention: true }), 0)
  assert.equal(attention.status, 'needs_attention')
  assert.equal(claimed.attempt_count, 1)
})

test('手动重试更新通知代际并使旧通知租约失效', () => {
  const { repo } = createTestRepository()
  const task = repo.upsertTask({ shareCode: 'generation' })
  const notification = repo.enqueueNotification(task.id, 'failed', '旧通知')
  repo.claimNextNotification('notifier', 60000)
  repo.updateTask(task.id, { status: 'failed' })
  const retried = repo.retryTask(task.id)
  assert.equal(retried.run_generation, 1)
  assert.equal(repo.assertNotificationLease(notification.id, 'notifier'), null)
  assert.equal(repo.listNotifications(task.id)[0].status, 'superseded')
})
