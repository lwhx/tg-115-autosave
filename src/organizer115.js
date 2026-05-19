import { OAUTH_STORE_DIR } from './config.js'
import { createAuthStore } from './authStore.js'
import { loginWithDrive115QrCode } from './drive115OAuth.js'
import { createDrive115Provider } from './drive115Provider.js'
import { normalizeMediaName } from './shareLinks.js'

export class Organizer115 {
  constructor({ configDir = OAUTH_STORE_DIR } = {}) {
    this.configDir = configDir
    this.store = createAuthStore({ configDir })
    this.provider = createDrive115Provider()
  }

  async getToken() {
    const account = await this.store.getDefaultAccount('115')
    if (!account?.token?.access_token) throw new Error('未配置 115 OAuth token')
    const token = account.token
    if (token.expire_time && new Date(token.expire_time).getTime() - Date.now() < 5 * 60 * 1000) {
      const refreshed = await this.provider.auth.refresh(token)
      await this.store.saveAccount({ ...account, token: refreshed })
      return refreshed
    }
    return token
  }

  async listAccounts() {
    return this.store.listAccounts()
  }

  async startQrLogin({ onQrCode, timeoutMs = 120000 } = {}) {
    return loginWithDrive115QrCode({
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

  async ensureFolder(parentId, name) {
    const token = await this.getToken()
    const list = await this.provider.files.list({ token, parentFileId: parentId || '0' })
    const found = list.find((item) => item.type === 'folder' && item.name === name)
    if (found) return found
    return this.provider.files.mkdir({ token, parentId: parentId || '0', name })
  }

  async list(parentId) {
    const token = await this.getToken()
    return this.provider.files.list({ token, parentFileId: parentId || '0' })
  }

  async waitForFiles(parentId, { attempts = 8, delayMs = 3000 } = {}) {
    for (let i = 0; i < attempts; i++) {
      const list = await this.list(parentId)
      if (list.length > 0) return list
      await new Promise((resolve) => setTimeout(resolve, delayMs))
    }
    return []
  }

  async basicOrganize(parentId) {
    const token = await this.getToken()
    const list = await this.provider.files.list({ token, parentFileId: parentId })
    const renames = []
    for (const item of list) {
      const nextName = normalizeMediaName(item.name)
      if (nextName && nextName !== item.name) renames.push({ fileId: item.fileId, newName: nextName })
    }
    const results = renames.length ? await this.provider.files.renameBatch({ token, renames }) : []
    return { items: list, renames, results }
  }
}
