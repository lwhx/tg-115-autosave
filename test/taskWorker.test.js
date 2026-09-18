import assert from 'node:assert/strict'
import test from 'node:test'
import { TaskWorker } from '../src/taskWorker.js'
import { TaskError } from '../src/taskError.js'

/** 创建单轮任务工作器。 */
function taskFixture(error) {
  const calls = { retries: [], releases: [] }
  let claims = 0
  let worker
  const repo = {
    claimNextTask() { claims += 1; return claims === 1 ? { id: 1, attempt_count: 1 } : null },
    renewTaskLease() { return true },
    scheduleTaskRetry(...args) { calls.retries.push(args) },
    releaseTaskLease(...args) { calls.releases.push(args) },
    addEvent() {},
  }
  const runner = { async execute() { if (error) throw error } }
  worker = new TaskWorker({ repo, runner, sleepFn: async () => { worker.stopping = true }, random: () => 0.5, uuid: () => 'id', setIntervalFn: () => 1, clearIntervalFn: () => {} })
  worker.stopping = false
  return { worker, calls }
}

test('TaskWorker 可重试和永久错误均交给仓库映射，LEASE_LOST 不调度', async () => {
  for (const [error, expected] of [[new Error('timeout'), 1], [new Error('永久失败'), 1], [new TaskError('LEASE_LOST', '丢失'), 0]]) {
    const { worker, calls } = taskFixture(error)
    await worker.runLoop(0)
    assert.equal(calls.retries.length, expected)
    assert.equal(calls.releases.length, 1)
  }
})

test('TaskWorker 续租成功保持信号，失败或异常时 abort', () => {
  let callback
  const worker = new TaskWorker({ repo: { addEvent() {} }, runner: {}, setIntervalFn: (value) => { callback = value; return 1 }, clearIntervalFn: () => {} })
  const success = new AbortController()
  worker.startLeaseRenewal(() => true, success, '成功')
  callback()
  assert.equal(success.signal.aborted, false)
  const failed = new AbortController()
  worker.startLeaseRenewal(() => false, failed, '失败')
  callback()
  assert.equal(failed.signal.aborted, true)
  const thrown = new AbortController()
  worker.startLeaseRenewal(() => { throw new Error('数据库失败') }, thrown, '异常')
  callback()
  assert.equal(thrown.signal.aborted, true)
})

test('TaskWorker 通知成功完成，失败进入重试', async () => {
  for (const [notifier, successful] of [[async () => {}, true], [async () => { throw new Error('发送失败') }, false]]) {
    let claims = 0
    let completed = 0
    let retried = 0
    let worker
    const repo = {
      claimNextNotification() { claims += 1; return claims === 1 ? { id: 1, attempt_count: 0 } : null },
      renewNotificationLease() { return true }, assertNotificationLease() { return true },
      completeNotification() { completed += 1 }, retryNotification() { retried += 1 },
      releaseNotificationLease() {}, addEvent() {},
    }
    worker = new TaskWorker({ repo, runner: {}, notifier, sleepFn: async () => { worker.stopping = true }, random: () => 0.5, uuid: () => 'id', setIntervalFn: () => 1, clearIntervalFn: () => {} })
    worker.stopping = false
    await worker.runNotificationLoop()
    assert.equal(completed, successful ? 1 : 0)
    assert.equal(retried, successful ? 0 : 1)
  }
})

test('retryDelay 使用注入随机数且封顶', () => {
  const worker = new TaskWorker({ repo: {}, runner: {}, random: () => 0.5 })
  assert.equal(worker.retryDelay(0), 1000)
  assert.equal(worker.retryDelay(1), 2000)
  assert.equal(worker.retryDelay(99), 256000)
})
