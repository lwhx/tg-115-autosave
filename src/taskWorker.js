import crypto from 'node:crypto'
import { classifyTaskError } from './taskError.js'

/**
 * 等待指定时长。
 * @param {number} milliseconds 毫秒数。
 * @returns {Promise<void>} 等待完成。
 */
function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

/** 单进程持久化任务与通知工作器。 */
export class TaskWorker {
  /**
   * 创建工作器。
   * @param {{repo: object, runner: object, notifier?: Function, pollMs?: number, leaseMs?: number, concurrency?: number}} options 工作器配置。
   */
  constructor({ repo, runner, notifier, pollMs = 1000, leaseMs = 60000, concurrency = 1 }) {
    this.repo = repo
    this.runner = runner
    this.notifier = notifier
    this.pollMs = pollMs
    this.leaseMs = leaseMs
    this.concurrency = Math.max(1, concurrency)
    this.owner = `${process.pid}-${crypto.randomUUID()}`
    this.stopping = true
    this.loops = []
  }

  /** 启动轮询循环。 */
  start() {
    if (!this.stopping) return
    this.stopping = false
    // 租约恢复由领取操作执行，数据库错误统一留在受保护的轮询循环内。
    this.loops = Array.from({ length: this.concurrency }, (_, index) => this.runLoop(index))
    this.loops.push(this.runNotificationLoop())
  }

  /**
   * 停止领取并等待在途任务结束。
   * @returns {Promise<void>} 停止完成。
   */
  async stop() {
    this.stopping = true
    await Promise.allSettled(this.loops)
    this.loops = []
  }

  /**
   * 执行任务轮询。
   * @param {number} index 并发槽编号。
   * @returns {Promise<void>} 循环结束。
   */
  async runLoop(index) {
    let databaseFailures = 0
    while (!this.stopping) {
      const owner = `${this.owner}-task-${index}-${crypto.randomUUID()}`
      const controller = new AbortController()
      let task
      let renewal
      let databaseFailed = false
      try {
        task = this.repo.claimNextTask(owner, this.leaseMs)
        if (!task) {
          databaseFailures = 0
          await sleep(this.pollMs)
          continue
        }
        renewal = this.startLeaseRenewal(() => this.repo.renewTaskLease(task.id, owner, this.leaseMs), controller, `任务 ${task.id} 续租`)
        try {
          await this.runner.execute(task.id, owner, { signal: controller.signal })
        } catch (rawError) {
          const error = classifyTaskError(rawError)
          if (error.code !== 'LEASE_LOST' && !controller.signal.aborted) {
            const delay = this.retryDelay(Math.max(0, task.attempt_count - 1))
            this.repo.scheduleTaskRetry(task.id, owner, error, delay)
          }
        }
      } catch (error) {
        databaseFailed = true
        this.reportError('任务工作器', error)
      } finally {
        clearInterval(renewal)
        if (task) {
          try { this.repo.releaseTaskLease(task.id, owner) }
          catch (error) {
            databaseFailed = true
            this.reportError(`任务 ${task.id} 释放租约`, error)
          }
        }
      }
      if (databaseFailed) await sleep(this.retryDelay(databaseFailures++))
      else databaseFailures = 0
    }
  }

  /**
   * 执行通知轮询，通知失败不影响业务任务。
   * @returns {Promise<void>} 循环结束。
   */
  async runNotificationLoop() {
    let databaseFailures = 0
    while (!this.stopping) {
      const owner = `${this.owner}-notification-${crypto.randomUUID()}`
      const controller = new AbortController()
      let notification
      let renewal
      let databaseFailed = false
      try {
        notification = this.repo.claimNextNotification(owner, this.leaseMs)
        if (!notification) {
          databaseFailures = 0
          await sleep(this.pollMs)
          continue
        }
        renewal = this.startLeaseRenewal(() => this.repo.renewNotificationLease(notification.id, owner, this.leaseMs), controller, `通知 ${notification.id} 续租`)
        if (!this.repo.assertNotificationLease(notification.id, owner)) continue
        try {
          if (!this.notifier) throw new Error('未配置通知发送器')
          await this.notifier(notification.message, { signal: controller.signal })
          if (!controller.signal.aborted) this.repo.completeNotification(notification.id, owner)
        } catch (error) {
          if (!controller.signal.aborted) this.repo.retryNotification(notification.id, owner, error.message || String(error), this.retryDelay(notification.attempt_count))
        }
      } catch (error) {
        databaseFailed = true
        this.reportError('通知工作器', error)
      } finally {
        clearInterval(renewal)
        if (notification) {
          try { this.repo.releaseNotificationLease(notification.id, owner) }
          catch (error) {
            databaseFailed = true
            this.reportError(`通知 ${notification.id} 释放租约`, error)
          }
        }
      }
      if (databaseFailed) await sleep(this.retryDelay(databaseFailures++))
      else databaseFailures = 0
    }
  }

  /** 定时器中的数据库异常不得逸出；失去租约后要求执行器停止后续操作。 */
  startLeaseRenewal(renew, controller, scope) {
    const timer = setInterval(() => {
      try {
        if (renew()) return
      } catch (error) {
        this.reportError(scope, error)
      }
      controller.abort()
      clearInterval(timer)
    }, Math.max(1000, Math.floor(this.leaseMs / 3)))
    return timer
  }

  reportError(scope, error) {
    const message = `${scope}：${error?.message || String(error)}`
    try { this.repo.addEvent(null, 'error', message) }
    catch { console.error(message) }
  }

  /**
   * 计算指数退避和抖动。
   * @param {number} attemptCount 已失败次数。
   * @returns {number} 延迟毫秒数。
   */
  retryDelay(attemptCount) {
    const base = Math.min(300000, 1000 * 2 ** Math.min(attemptCount, 8))
    return Math.floor(base * (0.8 + Math.random() * 0.4))
  }
}
