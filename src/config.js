import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

export const DATA_DIR = process.env.DATA_DIR || join(process.cwd(), 'data')
export const PORT = Number(process.env.PORT || 8715)
export const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'change-me'

export const DB_PATH = join(DATA_DIR, 'autosave.db')
export const OAUTH_STORE_DIR = join(DATA_DIR, 'oauth-store')

export function ensureDataDirs() {
  mkdirSync(DATA_DIR, { recursive: true })
  mkdirSync(OAUTH_STORE_DIR, { recursive: true })
}
