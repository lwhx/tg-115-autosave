import Database from 'better-sqlite3'
import { DB_PATH, ensureDataDirs } from './config.js'

/** 任务表允许动态更新的字段白名单。 */
const TASK_UPDATE_FIELDS = new Set([
  'title', 'status', 'stage', 'target_cid', 'target_path', 'error', 'attempt_count',
  'max_attempts', 'next_run_at', 'lease_owner', 'lease_expires_at', 'last_error_code',
  'last_error_at', 'started_at', 'finished_at', 'cancel_requested', 'folder_date',
  'transfer_attempt_count', 'transfer_requested_at', 'expected_file_count', 'expected_fingerprint',
  'target_folder_name', 'directory_isolated', 'run_generation',
])

/** 文件表允许动态更新的字段白名单。 */
const FILE_UPDATE_FIELDS = new Set([
  'saved_file_id', 'name', 'original_name', 'target_name', 'organize_status',
  'organize_error', 'organized_at', 'type', 'size',
  'share_file_id', 'content_hash',
])

/** 通知表允许动态更新的字段白名单。 */
const NOTIFICATION_UPDATE_FIELDS = new Set([
  'status', 'attempt_count', 'next_run_at', 'lease_owner', 'lease_expires_at',
  'last_error', 'sent_at',
])

/** 返回 ISO 格式的当前时间。 */
function currentTime() {
  return new Date().toISOString()
}

/**
 * 打开数据库并执行兼容旧版本的增量迁移。
 * @param {string} path 数据库文件路径。
 * @returns {Database.Database} 已初始化的数据库连接。
 */
export function openDb(path = DB_PATH) {
  ensureDataDirs()
  const db = new Database(path)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  migrate(db)
  return db
}

/**
 * 为已有表补充缺失列。
 * @param {Database.Database} db 数据库连接。
 * @param {string} table 表名。
 * @param {Record<string, string>} columns 列名与定义。
 * @returns {void}
 */
function addMissingColumns(db, table, columns) {
  const existing = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name))
  for (const [name, definition] of Object.entries(columns)) {
    if (!existing.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`)
  }
}

/**
 * 执行数据库迁移。
 * @param {Database.Database} db 数据库连接。
 * @returns {void}
 */
function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      share_code TEXT NOT NULL,
      receive_code TEXT NOT NULL DEFAULT '',
      raw_url TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'queued',
      source TEXT NOT NULL DEFAULT '',
      telegram_chat_id TEXT NOT NULL DEFAULT '',
      telegram_message_id TEXT NOT NULL DEFAULT '',
      target_cid TEXT NOT NULL DEFAULT '',
      target_path TEXT NOT NULL DEFAULT '',
      error TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(share_code, receive_code)
    );
    CREATE TABLE IF NOT EXISTS task_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL,
      share_file_id TEXT NOT NULL DEFAULT '',
      saved_file_id TEXT NOT NULL DEFAULT '',
      name TEXT NOT NULL DEFAULT '',
      type TEXT NOT NULL DEFAULT '',
      size INTEGER,
      created_at TEXT NOT NULL,
      FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER,
      level TEXT NOT NULL,
      message TEXT NOT NULL,
      meta TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE
    );
  `)

  addMissingColumns(db, 'tasks', {
    stage: "TEXT NOT NULL DEFAULT 'queued'",
    attempt_count: 'INTEGER NOT NULL DEFAULT 0',
    max_attempts: 'INTEGER NOT NULL DEFAULT 5',
    next_run_at: "TEXT NOT NULL DEFAULT ''",
    lease_owner: "TEXT NOT NULL DEFAULT ''",
    lease_expires_at: "TEXT NOT NULL DEFAULT ''",
    last_error_code: "TEXT NOT NULL DEFAULT ''",
    last_error_at: "TEXT NOT NULL DEFAULT ''",
    started_at: "TEXT NOT NULL DEFAULT ''",
    finished_at: "TEXT NOT NULL DEFAULT ''",
    cancel_requested: 'INTEGER NOT NULL DEFAULT 0',
    folder_date: "TEXT NOT NULL DEFAULT ''",
    transfer_attempt_count: 'INTEGER NOT NULL DEFAULT 0',
    transfer_requested_at: "TEXT NOT NULL DEFAULT ''",
    expected_file_count: 'INTEGER NOT NULL DEFAULT 0',
    expected_fingerprint: "TEXT NOT NULL DEFAULT ''",
    target_folder_name: "TEXT NOT NULL DEFAULT ''",
    directory_isolated: 'INTEGER NOT NULL DEFAULT 0',
    run_generation: 'INTEGER NOT NULL DEFAULT 0',
  })
  addMissingColumns(db, 'task_files', {
    original_name: "TEXT NOT NULL DEFAULT ''",
    target_name: "TEXT NOT NULL DEFAULT ''",
    organize_status: "TEXT NOT NULL DEFAULT 'pending'",
    organize_error: "TEXT NOT NULL DEFAULT ''",
    organized_at: "TEXT NOT NULL DEFAULT ''",
    content_hash: "TEXT NOT NULL DEFAULT ''",
  })
  db.exec(`
    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL,
      type TEXT NOT NULL,
      message TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      attempt_count INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 10,
      next_run_at TEXT NOT NULL DEFAULT '',
      lease_owner TEXT NOT NULL DEFAULT '',
      lease_expires_at TEXT NOT NULL DEFAULT '',
      last_error TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      sent_at TEXT NOT NULL DEFAULT '',
      UNIQUE(task_id, type),
      FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_tasks_queue ON tasks(status, next_run_at, lease_expires_at, id);
    CREATE INDEX IF NOT EXISTS idx_notifications_queue ON notifications(status, next_run_at, lease_expires_at, id);
    CREATE INDEX IF NOT EXISTS idx_task_files_task ON task_files(task_id, id);
  `)
  addMissingColumns(db, 'notifications', { run_generation: 'INTEGER NOT NULL DEFAULT 0' })
  db.prepare("UPDATE tasks SET stage = CASE status WHEN 'success' THEN 'completed' ELSE 'queued' END WHERE stage = 'queued' AND status IN ('success', 'pending')").run()
  db.prepare("UPDATE tasks SET status = CASE status WHEN 'success' THEN 'completed' WHEN 'pending' THEN 'queued' ELSE status END").run()
  // 旧版已有明确的目标文件 ID 时继续整理；否则在独立目录重新解析和转存。
  // 不移动或删除旧目录，避免把其他同名分享的内容归属于本任务。
  db.transaction(() => {
    const legacyTasks = db.prepare("SELECT id FROM tasks WHERE status IN ('receiving', 'received', 'organizing')").all()
    for (const task of legacyTasks) {
      const files = db.prepare('SELECT saved_file_id FROM task_files WHERE task_id = ?').all(task.id)
      const confirmed = files.length > 0 && files.every((file) => file.saved_file_id)
      db.prepare(`UPDATE tasks SET status = 'queued', stage = ?,
        target_cid = CASE WHEN ? THEN target_cid ELSE '' END,
        target_path = CASE WHEN ? THEN target_path ELSE '' END,
        expected_file_count = ?,
        attempt_count = 0, next_run_at = '', lease_owner = '', lease_expires_at = '', updated_at = ? WHERE id = ?`)
        .run(confirmed ? 'files_confirmed' : 'queued', Number(confirmed), Number(confirmed), confirmed ? files.length : 0, currentTime(), task.id)
    }
  })()
}

/**
 * 生成指定字段白名单约束下的更新 SQL。
 * @param {object} patch 更新对象。
 * @param {Set<string>} allowed 字段白名单。
 * @returns {{keys: string[], sets: string}} 字段列表和 SET 子句。
 */
function buildUpdate(patch, allowed) {
  const keys = Object.keys(patch || {}).filter((key) => allowed.has(key))
  return { keys, sets: keys.map((key) => `${key} = ?`).join(', ') }
}

/**
 * 创建持久化仓库。
 * @param {Database.Database} db 数据库连接。
 * @returns {object} 数据访问仓库。
 */
export function createRepository(db) {
  return {
    getSettings() {
      const rows = db.prepare('SELECT key, value FROM settings').all()
      const output = {}
      for (const row of rows) {
        try { output[row.key] = JSON.parse(row.value) } catch { output[row.key] = row.value }
      }
      return output
    },

    putSettings(values) {
      const statement = db.prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at')
      db.transaction((entries) => {
        for (const [key, value] of entries) statement.run(key, JSON.stringify(value ?? ''), currentTime())
      })(Object.entries(values || {}))
      return this.getSettings()
    },

    upsertTask(input) {
      const existing = this.findTask(input.shareCode, input.receiveCode || '')
      if (existing) return existing
      const timestamp = currentTime()
      const info = db.prepare(`
        INSERT INTO tasks (share_code, receive_code, raw_url, title, status, stage, source, telegram_chat_id, telegram_message_id, next_run_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'queued', 'queued', ?, ?, ?, ?, ?, ?)
      `).run(input.shareCode, input.receiveCode || '', input.raw || '', input.title || '', input.source || '', input.telegramChatId || '', input.telegramMessageId || '', timestamp, timestamp, timestamp)
      return this.getTask(info.lastInsertRowid)
    },

    getTask(id) {
      return db.prepare('SELECT * FROM tasks WHERE id = ?').get(id)
    },

    findTask(shareCode, receiveCode = '') {
      return db.prepare('SELECT * FROM tasks WHERE share_code = ? AND receive_code = ?').get(shareCode, receiveCode)
    },

    listTasks(limit = 100) {
      return db.prepare('SELECT * FROM tasks ORDER BY id DESC LIMIT ?').all(limit)
    },

    updateTask(id, patch) {
      const { keys, sets } = buildUpdate(patch, TASK_UPDATE_FIELDS)
      if (!keys.length) return this.getTask(id)
      db.prepare(`UPDATE tasks SET ${sets}, updated_at = ? WHERE id = ?`).run(...keys.map((key) => patch[key] ?? ''), currentTime(), id)
      return this.getTask(id)
    },

    updateTaskWithLease(id, owner, patch) {
      const { keys, sets } = buildUpdate(patch, TASK_UPDATE_FIELDS)
      if (!keys.length) return this.assertTaskLease(id, owner)
      const now = currentTime()
      const changed = db.prepare(`UPDATE tasks SET ${sets}, updated_at = ?
        WHERE id = ? AND status = 'running' AND lease_owner = ? AND lease_expires_at > ?`)
        .run(...keys.map((key) => patch[key] ?? ''), now, id, owner, now)
      return changed.changes ? this.getTask(id) : null
    },

    updateStage(id, owner, stage, patch = {}) {
      return this.updateTaskWithLease(id, owner, { ...patch, stage })
    },

    assertTaskLease(id, owner) {
      const now = currentTime()
      return db.prepare("SELECT * FROM tasks WHERE id = ? AND status = 'running' AND lease_owner = ? AND lease_expires_at > ?").get(id, owner, now) || null
    },

    claimNextTask(owner, leaseMs = 60000) {
      this.recoverExpiredTaskLeases()
      const claim = db.transaction(() => {
        const now = currentTime()
        const task = db.prepare(`
          SELECT * FROM tasks
          WHERE cancel_requested = 0 AND attempt_count < max_attempts
            AND ((status IN ('queued', 'retry_wait') AND (next_run_at = '' OR next_run_at <= ?))
              OR (status = 'running' AND lease_expires_at != '' AND lease_expires_at <= ?))
          ORDER BY id LIMIT 1
        `).get(now, now)
        if (!task) return null
        const expiresAt = new Date(Date.now() + leaseMs).toISOString()
        const changed = db.prepare(`
          UPDATE tasks SET status = 'running', lease_owner = ?, lease_expires_at = ?,
            attempt_count = attempt_count + 1,
            started_at = CASE WHEN started_at = '' THEN ? ELSE started_at END, updated_at = ?
          WHERE id = ? AND cancel_requested = 0 AND attempt_count < max_attempts
            AND ((status IN ('queued', 'retry_wait') AND (next_run_at = '' OR next_run_at <= ?))
              OR (status = 'running' AND lease_expires_at != '' AND lease_expires_at <= ?))
        `).run(owner, expiresAt, now, now, task.id, now, now)
        return changed.changes ? this.getTask(task.id) : null
      })
      return claim()
    },

    renewTaskLease(id, owner, leaseMs = 60000) {
      const expiresAt = new Date(Date.now() + leaseMs).toISOString()
      const now = currentTime()
      return db.prepare("UPDATE tasks SET lease_expires_at = ?, updated_at = ? WHERE id = ? AND status = 'running' AND lease_owner = ? AND lease_expires_at > ?").run(expiresAt, now, id, owner, now).changes === 1
    },

    releaseTaskLease(id, owner) {
      // 未能完成状态更新时保留可恢复的过期租约，不能留下 running + 空租约。
      return db.prepare(`UPDATE tasks SET
        lease_expires_at = CASE WHEN status = 'running' THEN ? ELSE '' END,
        lease_owner = CASE WHEN status = 'running' THEN lease_owner ELSE '' END,
        updated_at = ? WHERE id = ? AND lease_owner = ?`)
        .run(currentTime(), currentTime(), id, owner).changes === 1
    },

    recoverExpiredTaskLeases() {
      return db.transaction(() => {
        const now = currentTime()
        const abandoned = db.prepare(`SELECT * FROM tasks WHERE
          (status = 'running' AND (lease_expires_at = '' OR lease_expires_at <= ?)) OR
          (status IN ('queued', 'retry_wait') AND attempt_count >= max_attempts)`).all(now)
        for (const task of abandoned) {
          if (task.attempt_count >= task.max_attempts || task.cancel_requested) {
            const message = task.cancel_requested ? '任务已取消' : '最后一次执行中断，重试次数已用尽，请手动重试'
            this.updateTask(task.id, {
              status: task.cancel_requested ? 'cancelled' : 'failed', error: message,
              last_error_code: task.cancel_requested ? 'CANCELLED' : 'ATTEMPTS_EXHAUSTED',
              last_error_at: now, finished_at: now, next_run_at: '', lease_owner: '', lease_expires_at: '',
            })
            this.addEvent(task.id, 'error', message)
            this.enqueueNotification(task.id, 'failed', `115 转存失败：${task.share_code}\n${message}`)
          } else {
            this.updateTask(task.id, { status: 'queued', lease_owner: '', lease_expires_at: '', next_run_at: now })
          }
        }
        return abandoned.length
      })()
    },

    scheduleTaskRetry(id, owner, error, delayMs) {
      return db.transaction(() => {
        const task = this.assertTaskLease(id, owner)
        if (!task) return null
        const exhausted = task.attempt_count >= task.max_attempts || !error.retryable
        const updated = this.updateTaskWithLease(id, owner, {
          status: exhausted ? (error.code === 'CANCELLED' ? 'cancelled' : error.attention ? 'needs_attention' : 'failed') : 'retry_wait',
          next_run_at: exhausted ? '' : new Date(Math.max(Date.now() + delayMs, error.retryAt || 0)).toISOString(),
          lease_owner: '', lease_expires_at: '', error: error.message,
          last_error_code: error.code, last_error_at: currentTime(),
          finished_at: exhausted ? currentTime() : '',
        })
        if (updated) {
          this.addEvent(id, 'error', error.message, { code: error.code, retryable: error.retryable })
          if (exhausted) this.enqueueNotification(id, 'failed', `115 转存失败：${task.share_code}\n${error.message}`)
        }
        return updated
      })()
    },

    retryTask(id) {
      return db.transaction(() => {
        const task = this.getTask(id)
        if (!task || task.status === 'completed') return task
        if (task.status === 'running') {
          const error = new Error('任务正在执行，请等待当前执行结束后重试')
          error.statusCode = 409
          throw error
        }
        // 取消旧批次尚未发送的消息，同时使旧通知工作器的租约失效。
        db.prepare(`UPDATE notifications SET status = 'superseded', lease_owner = '', lease_expires_at = '', updated_at = ?
          WHERE task_id = ? AND status IN ('pending', 'retry_wait', 'sending')`).run(currentTime(), id)
        return this.updateTask(id, {
          status: 'queued', attempt_count: 0, next_run_at: currentTime(), lease_owner: '',
          lease_expires_at: '', error: '', last_error_code: '', last_error_at: '',
          finished_at: '', cancel_requested: 0, run_generation: task.run_generation + 1,
        })
      })()
    },

    completeTask(id, owner) {
      return db.transaction(() => {
        const task = this.updateTaskWithLease(id, owner, { status: 'completed', stage: 'completed', lease_owner: '', lease_expires_at: '', error: '', finished_at: currentTime() })
        if (task) {
          this.addEvent(id, 'info', '任务完成', { count: task.expected_file_count })
          this.enqueueNotification(id, 'completed', `115 转存完成：${task.title}\n目录：${task.target_path}`)
        }
        return task
      })()
    },

    replaceTaskFiles(taskId, files) {
      const timestamp = currentTime()
      db.transaction(() => {
        db.prepare('DELETE FROM task_files WHERE task_id = ?').run(taskId)
        const statement = db.prepare(`INSERT INTO task_files
          (task_id, share_file_id, saved_file_id, name, original_name, target_name, organize_status, type, size, content_hash, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        for (const file of files || []) {
          const name = file.name || file.originalName || ''
          statement.run(taskId, file.shareFileId || '', file.savedFileId || '', name, file.originalName || name, file.targetName || name, file.organizeStatus || 'pending', file.type || '', file.size ?? null, file.contentHash || '', timestamp)
        }
      })()
    },

    syncSavedTaskFiles(taskId, files) {
      db.transaction(() => {
        const existing = this.listTaskFiles(taskId)
        const bySavedId = new Map(existing.filter((file) => file.saved_file_id).map((file) => [file.saved_file_id, file]))
        const byShareId = new Map(existing.filter((file) => file.share_file_id).map((file) => [file.share_file_id, file]))
        const insert = db.prepare(`INSERT INTO task_files
          (task_id, share_file_id, saved_file_id, name, original_name, target_name, organize_status, type, size, content_hash, created_at)
          VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`)
        for (const file of files || []) {
          const savedId = String(file.fileId || file.savedFileId || '')
          const row = bySavedId.get(savedId) || byShareId.get(file.shareFileId)
          if (row) this.updateTaskFile(row.id, { saved_file_id: savedId, name: file.name || row.name, type: file.type || row.type, size: file.size ?? row.size, content_hash: file.contentHash || row.content_hash })
          else insert.run(taskId, file.shareFileId || '', savedId, file.name || '', file.name || '', file.name || '', file.type || '', file.size ?? null, file.contentHash || '', currentTime())
        }
      })()
    },

    updateTaskFile(id, patch) {
      const { keys, sets } = buildUpdate(patch, FILE_UPDATE_FIELDS)
      if (!keys.length) return db.prepare('SELECT * FROM task_files WHERE id = ?').get(id)
      db.prepare(`UPDATE task_files SET ${sets} WHERE id = ?`).run(...keys.map((key) => patch[key] ?? ''), id)
      return db.prepare('SELECT * FROM task_files WHERE id = ?').get(id)
    },

    listTaskFiles(taskId) {
      return db.prepare('SELECT * FROM task_files WHERE task_id = ? ORDER BY id').all(taskId)
    },

    enqueueNotification(taskId, type, message) {
      const timestamp = currentTime()
      const task = this.getTask(taskId)
      if (!task) return null
      // 同批次幂等；新一轮手动重试可覆盖上一批次的通知记录并重新发送。
      db.prepare(`INSERT INTO notifications (task_id, type, message, next_run_at, created_at, updated_at, run_generation)
        VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(task_id, type) DO UPDATE SET
          message = excluded.message, run_generation = excluded.run_generation,
          status = 'pending', attempt_count = 0, next_run_at = excluded.next_run_at,
          lease_owner = '', lease_expires_at = '', last_error = '', sent_at = '',
          created_at = excluded.created_at, updated_at = excluded.updated_at
        WHERE notifications.run_generation != excluded.run_generation`)
        .run(taskId, type, message, timestamp, timestamp, timestamp, task.run_generation)
      return db.prepare('SELECT * FROM notifications WHERE task_id = ? AND type = ?').get(taskId, type)
    },

    claimNextNotification(owner, leaseMs = 60000) {
      return db.transaction(() => {
        const now = currentTime()
        const item = db.prepare(`SELECT * FROM notifications WHERE attempt_count < max_attempts
          AND run_generation = (SELECT run_generation FROM tasks WHERE tasks.id = notifications.task_id) AND
          ((status IN ('pending', 'retry_wait') AND (next_run_at = '' OR next_run_at <= ?)) OR
          (status = 'sending' AND lease_expires_at != '' AND lease_expires_at <= ?)) ORDER BY id LIMIT 1`).get(now, now)
        if (!item) return null
        const expiresAt = new Date(Date.now() + leaseMs).toISOString()
        const changed = db.prepare(`UPDATE notifications SET status = 'sending', lease_owner = ?, lease_expires_at = ?, updated_at = ?
          WHERE id = ? AND attempt_count < max_attempts
            AND run_generation = (SELECT run_generation FROM tasks WHERE tasks.id = notifications.task_id) AND
            ((status IN ('pending', 'retry_wait') AND (next_run_at = '' OR next_run_at <= ?)) OR
            (status = 'sending' AND lease_expires_at != '' AND lease_expires_at <= ?))`).run(owner, expiresAt, now, item.id, now, now)
        return changed.changes ? db.prepare('SELECT * FROM notifications WHERE id = ?').get(item.id) : null
      })()
    },

    completeNotification(id, owner) {
      const timestamp = currentTime()
      return db.prepare(`UPDATE notifications SET status = 'sent', lease_owner = '', lease_expires_at = '', sent_at = ?, updated_at = ?
        WHERE id = ? AND lease_owner = ? AND status = 'sending' AND lease_expires_at > ?
          AND run_generation = (SELECT run_generation FROM tasks WHERE tasks.id = notifications.task_id)`)
        .run(timestamp, timestamp, id, owner, timestamp).changes === 1
    },

    assertNotificationLease(id, owner) {
      return db.prepare(`SELECT * FROM notifications WHERE id = ? AND lease_owner = ?
        AND status = 'sending' AND lease_expires_at > ?
        AND run_generation = (SELECT run_generation FROM tasks WHERE tasks.id = notifications.task_id)`)
        .get(id, owner, currentTime()) || null
    },

    renewNotificationLease(id, owner, leaseMs = 60000) {
      const now = currentTime()
      return db.prepare(`UPDATE notifications SET lease_expires_at = ?, updated_at = ?
        WHERE id = ? AND lease_owner = ? AND status = 'sending' AND lease_expires_at > ?
          AND run_generation = (SELECT run_generation FROM tasks WHERE tasks.id = notifications.task_id)`)
        .run(new Date(Date.now() + leaseMs).toISOString(), now, id, owner, now).changes === 1
    },

    releaseNotificationLease(id, owner) {
      return db.prepare("UPDATE notifications SET lease_expires_at = ?, updated_at = ? WHERE id = ? AND lease_owner = ? AND status = 'sending'")
        .run(currentTime(), currentTime(), id, owner).changes === 1
    },

    retryNotification(id, owner, message, delayMs) {
      return db.transaction(() => {
        const item = this.assertNotificationLease(id, owner)
        if (!item) return false
        const attempts = item.attempt_count + 1
        const patch = {
          status: attempts >= item.max_attempts ? 'failed' : 'retry_wait', attempt_count: attempts,
          next_run_at: new Date(Date.now() + delayMs).toISOString(), lease_owner: '', lease_expires_at: '', last_error: message,
        }
        const { keys, sets } = buildUpdate(patch, NOTIFICATION_UPDATE_FIELDS)
        return db.prepare(`UPDATE notifications SET ${sets}, updated_at = ? WHERE id = ? AND lease_owner = ?`)
          .run(...keys.map((key) => patch[key]), currentTime(), id, owner).changes === 1
      })()
    },

    listNotifications(taskId) {
      return db.prepare('SELECT * FROM notifications WHERE task_id = ? ORDER BY id').all(taskId)
    },

    addEvent(taskId, level, message, meta = {}) {
      db.prepare('INSERT INTO events (task_id, level, message, meta, created_at) VALUES (?, ?, ?, ?, ?)').run(taskId || null, level, message, JSON.stringify(meta || {}), currentTime())
    },

    listEvents(taskId, limit = 100) {
      if (taskId) return db.prepare('SELECT * FROM events WHERE task_id = ? ORDER BY id DESC LIMIT ?').all(taskId, limit)
      return db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT ?').all(limit)
    },
  }
}
