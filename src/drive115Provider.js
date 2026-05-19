const BASE = 'https://proapi.115.com/open'
const REFRESH_URL = 'https://passportapi.115.com/open/refreshToken'
const CLIENT_ID = process.env.CLOUDDRIVE_115_CLIENT_ID || '100195153'
const CLIENT_SECRET = process.env.CLOUDDRIVE_115_CLIENT_SECRET || 'ba2656d8fd7ef83a39283e7dfc9dc4fb'

function headers(token) {
  return { Authorization: `Bearer ${token.access_token}` }
}

async function requestJson(url, init = {}, fallback = '115 API request failed') {
  const resp = await fetch(url, init)
  if (!resp.ok) {
    const text = await resp.text().catch(() => '')
    throw new Error(`${fallback} ${resp.status}: ${text.slice(0, 180)}`)
  }
  const data = await resp.json()
  if (data.code != null && data.code !== 0) throw new Error(data.message || `${fallback}: code=${data.code}`)
  return data
}

async function get(url, token) {
  return requestJson(url, { headers: headers(token) }, '115 GET failed')
}

async function post(url, body, token) {
  return requestJson(url, {
    method: 'POST',
    headers: { ...headers(token), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
  }, '115 POST failed')
}

function mapFileItem(item, accountId) {
  const isFolder = item.fc === '1' || item.isdir === 1 || (!item.fid && !!item.cid)
  return {
    provider: '115',
    accountId,
    driveId: '115',
    fileId: String(item.fid || item.cid || item.file_id || ''),
    parentFileId: String(item.pid || item.parent_id || '0'),
    name: item.n || item.fn || item.file_name || '',
    type: isFolder ? 'folder' : 'file',
    size: item.s != null ? Number(item.s) : undefined,
    contentHash: item.sha,
  }
}

export async function drive115RefreshToken(token) {
  const data = await requestJson(REFRESH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ refresh_token: token.refresh_token, client_id: CLIENT_ID, client_secret: CLIENT_SECRET }).toString(),
  }, '115 token refresh failed')
  const payload = data.data || data
  const expiresIn = Number(payload.expires_in || token.expires_in || 0)
  return {
    ...token,
    access_token: payload.access_token || token.access_token,
    refresh_token: payload.refresh_token || token.refresh_token,
    expires_in: expiresIn,
    expire_time: expiresIn ? new Date(Date.now() + expiresIn * 1000).toISOString() : token.expire_time,
  }
}

export async function drive115ListDir(token, cid = '0') {
  const allItems = []
  let offset = 0
  const limit = 200
  while (true) {
    const qs = new URLSearchParams({ cid, limit: String(limit), offset: String(offset), cur: '1', show_dir: '1' })
    const data = await get(`${BASE}/ufile/files?${qs}`, token)
    const items = data.data || []
    for (const item of items) allItems.push(mapFileItem(item, token.user_id || token.accountId || '115'))
    offset += limit
    if (items.length < limit || offset >= Number(data.count || 0)) break
  }
  return allItems
}

export async function drive115RenameBatch(token, renames) {
  const results = []
  for (const { fileId, newName } of renames) {
    try {
      await post(`${BASE}/ufile/update`, { file_id: fileId, file_name: newName }, token)
      results.push({ fileId, status: 'success', newName })
    } catch (error) {
      results.push({ fileId, status: 'error', message: error.message })
    }
  }
  return results
}

export async function drive115Mkdir(token, parentId, name) {
  const data = await post(`${BASE}/ufile/mkdir`, { cid: String(parentId), cname: name }, token)
  return {
    provider: '115',
    accountId: token.user_id || token.accountId || '115',
    driveId: '115',
    fileId: String(data.file_id || data.cid || data.data?.file_id || data.data?.cid || ''),
    parentFileId: String(parentId),
    name,
    type: 'folder',
  }
}

export function createDrive115Provider() {
  return {
    id: '115',
    auth: { refresh: drive115RefreshToken },
    files: {
      list: async ({ token, parentFileId = '0' }) => drive115ListDir(token, parentFileId),
      mkdir: async ({ token, parentId = '0', name }) => drive115Mkdir(token, parentId, name),
      renameBatch: async ({ token, renames }) => drive115RenameBatch(token, renames),
    },
  }
}

