import { OAUTH_STORE_DIR } from './config.js'
import { createAuthStore } from './authStore.js'
import { loginWithDrive115QrCode } from './drive115OAuth.js'
import { createDrive115Provider } from './drive115Provider.js'
import { normalizeMediaName } from './shareLinks.js'

export class Organizer115 {
  /**
   * 创建整理器。
   * @param {{configDir?: string, store?: object, provider?: object, loginQr?: Function, sleep?: Function}} options 可替换依赖。
   */
  constructor({ configDir = OAUTH_STORE_DIR, store, provider, loginQr = loginWithDrive115QrCode, sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)) } = {}) {
    this.configDir = configDir
    this.store = store || createAuthStore({ configDir })
    this.provider = provider || createDrive115Provider()
    this.loginQr = loginQr
    this.sleep = sleep
  }

  async getToken() {
    const account = await this.store.getDefaultAccount('115')
    if (!account?.token?.access_token) throw new Error('未配置 115 OAuth token')
    const token = account.token
    if (token.expire_time && new Date(token.expire_time).getTime() - Date.now() < 5 * 60 * 1000) {
      const refreshed = await this.store.updateAccount(account.provider, account.accountId, async (current) => {
        // 在存储锁内重新读取到期时间，避免并发请求重复刷新同一个 refresh_token。
        if (!current.token.expire_time || new Date(current.token.expire_time).getTime() - Date.now() >= 5 * 60 * 1000) return current
        return { ...current, token: await this.provider.auth.refresh(current.token) }
      })
      return refreshed.token
    }
    return token
  }

  async listAccounts() {
    return this.store.listAccounts()
  }

  async startQrLogin({ onQrCode, timeoutMs = 120000 } = {}) {
    return this.loginQr({
      configDir: this.configDir,
      timeoutMs,
      renderQrCode: async (qrcode) => {
        if (onQrCode) await onQrCode(qrcode)
      },
    })
  }

  async mkdir(parentId, name) {
    const token = await this.getToken()
    return this.provider.files.mkdir({ token, parentId: parentId || '0', name })
  }

  async ensureFolder(parentId, name, { assertActive } = {}) {
    const token = await this.getToken()
    assertActive?.()
    const list = await this.provider.files.list({ token, parentFileId: parentId || '0' })
    assertActive?.()
    const found = list.find((item) => item.type === 'folder' && item.name === name)
    if (found) return found
    return this.provider.files.mkdir({ token, parentId: parentId || '0', name })
  }

  async list(parentId) {
    const token = await this.getToken()
    return this.provider.files.list({ token, parentFileId: parentId || '0' })
  }

  async waitForFiles(parentId, { attempts = 8, delayMs = 3000, assertActive } = {}) {
    for (let i = 0; i < attempts; i++) {
      assertActive?.()
      const list = await this.list(parentId)
      assertActive?.()
      if (list.length > 0) return list
      await this.sleep(delayMs)
    }
    return []
  }

  /**
   * 重命名单个文件，供逐文件持久化整理使用。
   * @param {string} fileId 文件标识。
   * @param {string} newName 新文件名。
   * @returns {Promise<object>} 重命名结果。
   * @throws {Error} OAuth 或远端接口异常。
   */
  async renameFile(fileId, newName, { assertActive } = {}) {
    const token = await this.getToken()
    assertActive?.()
    const results = await this.provider.files.renameBatch({ token, renames: [{ fileId, newName }] })
    const result = results[0]
    if (!result) throw new Error('115 重命名接口没有返回结果')
    if (result.status === 'error') throw result.error || new Error(result.message || '115 重命名失败')
    return result
  }

  async basicOrganize(parentId) {
    const token = await this.getToken()
    const list = await this.provider.files.list({ token, parentFileId: parentId })
    const renames = []
    for (const item of list) {
      const nextName = normalizeMediaName(item.name, { isFolder: item.type === 'folder' })
      if (nextName && nextName !== item.name) renames.push({ fileId: item.fileId, newName: nextName })
    }
    const results = renames.length ? await this.provider.files.renameBatch({ token, renames }) : []
    return { items: list, renames, results }
  }
}
