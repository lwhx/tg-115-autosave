import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'

const TOKENS_FILE = 'tokens.json'
const CONFIG_FILE = 'config.json'
// 同一进程中，扫码登录和整理器的不同 store 实例共享目录级写入锁。
const storeWrites = new Map()

function withStoreLock(directory, operation) {
  const absolute = resolve(directory)
  const key = process.platform === 'win32' ? absolute.toLowerCase() : absolute
  const previous = storeWrites.get(key) || Promise.resolve()
  const result = previous.then(operation)
  const settled = result.then(() => {}, () => {})
  storeWrites.set(key, settled)
  void settled.then(() => {
    if (storeWrites.get(key) === settled) storeWrites.delete(key)
  })
  return result
}

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return fallback
    throw error
  }
}

async function writePrivateJson(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    const file = await open(temporary, 'wx', 0o600)
    try {
      await file.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
      await file.sync()
    } finally {
      await file.close()
    }
    // 同目录原子替换，读取方只能看到完整的旧版或新版 JSON。
    await rename(temporary, path)
  } finally {
    await unlink(temporary).catch(() => {})
  }
}

function publicAccount(account, defaults) {
  return {
    provider: account.provider,
    accountId: account.accountId,
    displayName: account.displayName || account.accountId,
    isDefault: defaults[account.provider] === account.accountId,
  }
}

export function createAuthStore({ configDir }) {
  if (!configDir) throw new Error('configDir is required')
  const tokensPath = join(configDir, TOKENS_FILE)
  const configPath = join(configDir, CONFIG_FILE)

  async function ensureDir() {
    await mkdir(configDir, { recursive: true, mode: 0o700 })
  }

  async function readTokens() {
    await ensureDir()
    const data = await readJson(tokensPath, { accounts: [] })
    return { accounts: Array.isArray(data.accounts) ? data.accounts : [] }
  }

  async function readConfig() {
    await ensureDir()
    const data = await readJson(configPath, { defaults: {} })
    return { defaults: data.defaults && typeof data.defaults === 'object' ? data.defaults : {} }
  }

  return {
    async saveAccount(account) {
      if (!account?.provider) throw new Error('account.provider is required')
      if (!account?.accountId) throw new Error('account.accountId is required')
      return withStoreLock(configDir, async () => {
        const data = await readTokens()
        const nextAccounts = data.accounts.filter((item) => !(item.provider === account.provider && item.accountId === account.accountId))
        nextAccounts.push(account)
        await writePrivateJson(tokensPath, { accounts: nextAccounts })
        return account
      })
    },

    async updateAccount(provider, accountId, update) {
      return withStoreLock(configDir, async () => {
        const data = await readTokens()
        const index = data.accounts.findIndex((item) => item.provider === provider && item.accountId === accountId)
        if (index < 0) throw new Error(`Unknown account: ${provider}/${accountId}`)
        const current = data.accounts[index]
        const next = await update(current)
        if (next.provider !== provider || next.accountId !== accountId) throw new Error('Account identity cannot change during refresh')
        if (next !== current) {
          data.accounts[index] = next
          await writePrivateJson(tokensPath, data)
        }
        return next
      })
    },

    async listAccounts() {
      const [{ accounts }, { defaults }] = await Promise.all([readTokens(), readConfig()])
      return accounts.map((account) => publicAccount(account, defaults))
    },

    async getAccount(provider, accountId) {
      const { accounts } = await readTokens()
      return accounts.find((account) => account.provider === provider && account.accountId === accountId) || null
    },

    async setDefaultAccount(provider, accountId) {
      return withStoreLock(configDir, async () => {
        const account = await this.getAccount(provider, accountId)
        if (!account) throw new Error(`Unknown account: ${provider}/${accountId}`)
        const config = await readConfig()
        config.defaults[provider] = accountId
        await writePrivateJson(configPath, config)
        return account
      })
    },

    async getDefaultAccount(provider) {
      const { defaults } = await readConfig()
      const accountId = defaults[provider]
      if (!accountId) return null
      return this.getAccount(provider, accountId)
    },
  }
}
