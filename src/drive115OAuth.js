import { createHash, randomBytes } from 'node:crypto'
import { createAuthStore } from './authStore.js'

const DRIVE115 = {
  authDeviceUrl: 'https://passportapi.115.com/open/authDeviceCode',
  statusUrl: 'https://qrcodeapi.115.com/get/status/',
  tokenUrl: 'https://passportapi.115.com/open/deviceCodeToToken',
  clientId: process.env.CLOUDDRIVE_115_CLIENT_ID || '100195153',
}

function base64Url(buffer) {
  return Buffer.from(buffer).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function createPkceVerifier() {
  return base64Url(randomBytes(48))
}

function createPkceChallenge(verifier) {
  return base64Url(createHash('sha256').update(verifier).digest())
}

async function fetchJson(url, init, fallback) {
  const resp = await fetch(url, init)
  const data = await resp.json().catch(() => undefined)
  if (!resp.ok) throw new Error(`${fallback}: HTTP ${resp.status}`)
  if (data?.error || data?.errno || data?.code) throw new Error(data?.message || fallback)
  return data
}

async function createDeviceCode({ clientId = DRIVE115.clientId, verifier }) {
  const data = await fetchJson(DRIVE115.authDeviceUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, code_challenge: createPkceChallenge(verifier), code_challenge_method: 'sha256' }).toString(),
  }, 'Create 115 QR code failed')
  const payload = data.data || data
  if (!payload?.uid || !payload?.qrcode) throw new Error('Create 115 QR code failed: missing device code')
  return { uid: payload.uid, time: payload.time, sign: payload.sign, qrcode: payload.qrcode }
}

async function pollStatus({ uid, time, sign, timeoutMs = 120000, intervalMs = 1500 }) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const params = new URLSearchParams({ uid, time, sign })
    const data = await fetchJson(`${DRIVE115.statusUrl}?${params.toString()}`, {}, 'Poll 115 QR code failed')
    const state = data.state ?? 0
    const status = data.data?.status ?? 0
    if (state === 0) throw new Error('115 QR code expired')
    if (status === 2) return { state, status, msg: data.data?.msg || 'authorized' }
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  throw new Error('115 QR login timed out')
}

async function exchangeDeviceCode({ uid, verifier }) {
  const data = await fetchJson(DRIVE115.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ uid, code_verifier: verifier }).toString(),
  }, 'Exchange 115 device code failed')
  const payload = data.data || data
  const expiresIn = Number(payload.expires_in || 0)
  const token = {
    tokenfrom: '115',
    access_token: payload.access_token,
    refresh_token: payload.refresh_token || '',
    expires_in: expiresIn,
    token_type: payload.token_type || 'Bearer',
    user_id: `115_${uid}`,
    user_name: '115网盘',
    expire_time: expiresIn ? new Date(Date.now() + expiresIn * 1000).toISOString() : '',
  }
  return { provider: '115', accountId: token.user_id, displayName: `115 ${uid}`, token }
}

export async function loginWithDrive115QrCode({ configDir, verifier = createPkceVerifier(), renderQrCode, timeoutMs = 120000, intervalMs = 1500 } = {}) {
  const device = await createDeviceCode({ verifier })
  if (renderQrCode) await renderQrCode(device.qrcode)
  const status = await pollStatus({ uid: device.uid, time: device.time, sign: device.sign, timeoutMs, intervalMs })
  if ((status.status ?? 0) !== 2) throw new Error(status.msg || '115 QR login was not authorized')
  const account = await exchangeDeviceCode({ uid: device.uid, verifier })
  const store = createAuthStore({ configDir })
  await store.saveAccount(account)
  await store.setDefaultAccount(account.provider, account.accountId)
  return account
}

