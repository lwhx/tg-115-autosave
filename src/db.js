import Database from 'better-sqlite3'
import { DB_PATH, ensureDataDirs } from './config.js'

export function openDb(path = DB_PATH) {
  ensureDataDirs()
  const db = new Database(path)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  migrate(db)
  return db
}

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
      status TEXT NOT NULL,
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
}

export function createRepository(db) {
  const now = () => new Date().toISOString()

  return {
    getSettings() {
      const rows = db.prepare('SELECT key, value FROM settings').all()
      const out = {}
      for (const row of rows) {
        try { out[row.key] = JSON.parse(row.value) } catch { out[row.key] = row.value }
      }
      return out
    },

    putSettings(values) {
      const stmt = db.prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at')
      const write = db.transaction((entries) => {
        for (const [key, value] of entries) stmt.run(key, JSON.stringify(value ?? ''), now())
      })
      write(Object.entries(values || {}))
      return this.getSettings()
    },

    upsertTask(input) {
      const createdAt = now()
      const existing = db.prepare('SELECT * FROM tasks WHERE share_code = ? AND receive_code = ?').get(input.shareCode, input.receiveCode || '')
      if (existing) return existing
      const info = db.prepare(`
        INSERT INTO tasks (share_code, receive_code, raw_url, title, status, source, telegram_chat_id, telegram_message_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(input.shareCode, input.receiveCode || '', input.raw || '', input.title || '', 'pending', input.source || '', input.telegramChatId || '', input.telegramMessageId || '', createdAt, createdAt)
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
      const allowed = ['title', 'status', 'target_cid', 'target_path', 'error']
      const keys = Object.keys(patch || {}).filter((key) => allowed.includes(key))
      if (keys.length === 0) return this.getTask(id)
      const sets = keys.map((key) => `${key} = ?`).join(', ')
      db.prepare(`UPDATE tasks SET ${sets}, updated_at = ? WHERE id = ?`).run(...keys.map((key) => patch[key] ?? ''), now(), id)
      return this.getTask(id)
    },

    replaceTaskFiles(taskId, files) {
      const createdAt = now()
      const write = db.transaction(() => {
        db.prepare('DELETE FROM task_files WHERE task_id = ?').run(taskId)
        const stmt = db.prepare('INSERT INTO task_files (task_id, share_file_id, saved_file_id, name, type, size, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        for (const file of files || []) stmt.run(taskId, file.shareFileId || '', file.savedFileId || '', file.name || '', file.type || '', file.size ?? null, createdAt)
      })
      write()
    },

    listTaskFiles(taskId) {
      return db.prepare('SELECT * FROM task_files WHERE task_id = ? ORDER BY id').all(taskId)
    },

    addEvent(taskId, level, message, meta = {}) {
      db.prepare('INSERT INTO events (task_id, level, message, meta, created_at) VALUES (?, ?, ?, ?, ?)').run(taskId || null, level, message, JSON.stringify(meta || {}), now())
    },

    listEvents(taskId, limit = 100) {
      if (taskId) return db.prepare('SELECT * FROM events WHERE task_id = ? ORDER BY id DESC LIMIT ?').all(taskId, limit)
      return db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT ?').all(limit)
    },
  }
}

