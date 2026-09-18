import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createAuthStore } from '../src/authStore.js'

const directories = []
afterEach(async () => Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))))

/** 创建临时认证存储。 */
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'auth-store-'))
  directories.push(directory)
  return { directory, store: createAuthStore({ configDir: directory }) }
}

test('认证存储支持账户 CRUD、默认账户且公开列表不泄露 token', async () => {
  const { store } = await fixture()
  const account = { provider: '115', accountId: 'a', displayName: '账号', token: { access_token: 'secret' } }
  await store.saveAccount(account)
  await store.setDefaultAccount('115', 'a')
  assert.deepEqual(await store.getDefaultAccount('115'), account)
  assert.deepEqual(await store.listAccounts(), [{ provider: '115', accountId: 'a', displayName: '账号', isDefault: true }])
  assert.equal(JSON.stringify(await store.listAccounts()).includes('secret'), false)
  const updated = await store.updateAccount('115', 'a', (current) => ({ ...current, displayName: '新名称' }))
  assert.equal(updated.displayName, '新名称')
  await assert.rejects(() => store.updateAccount('115', 'a', (current) => ({ ...current, accountId: 'b' })), /identity/)
})

test('多个实例并发保存不会丢失账户且文件保持完整 JSON', async () => {
  const { directory, store } = await fixture()
  const second = createAuthStore({ configDir: directory })
  await Promise.all(Array.from({ length: 12 }, (_, index) => (index % 2 ? store : second).saveAccount({
    provider: '115', accountId: String(index), token: { access_token: `token-${index}` },
  })))
  assert.equal((await store.listAccounts()).length, 12)
  const data = JSON.parse(await readFile(join(directory, 'tokens.json'), 'utf8'))
  assert.equal(data.accounts.length, 12)
})

test('认证存储校验必填字段和未知账户', async () => {
  const { store } = await fixture()
  await assert.rejects(() => store.saveAccount({}), /provider/)
  await assert.rejects(() => store.saveAccount({ provider: '115' }), /accountId/)
  await assert.rejects(() => store.setDefaultAccount('115', 'missing'), /Unknown account/)
  assert.equal(await store.getDefaultAccount('115'), null)
})
