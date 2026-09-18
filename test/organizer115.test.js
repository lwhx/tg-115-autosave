import assert from 'node:assert/strict'
import test from 'node:test'
import { Organizer115 } from '../src/organizer115.js'

/** 创建整理器及可观察依赖。 */
function fixture(account) {
  let refreshes = 0
  let current = account
  let updateQueue = Promise.resolve()
  const store = {
    async getDefaultAccount() { return current },
    async updateAccount(_provider, _accountId, update) {
      const result = updateQueue.then(async () => { current = await update(current); return current })
      updateQueue = result.catch(() => {})
      return result
    },
    async listAccounts() { return [] },
  }
  const provider = {
    auth: { async refresh(token) { refreshes += 1; return { ...token, access_token: 'new', expire_time: '2999-01-01T00:00:00.000Z' } } },
    files: {},
  }
  return { organizer: new Organizer115({ store, provider, sleep: async () => {} }), provider, getRefreshes: () => refreshes }
}

test('getToken 拒绝缺失 token 且无需刷新时原样返回', async () => {
  await assert.rejects(() => fixture(null).organizer.getToken(), /未配置/)
  const token = { access_token: 'ok', expire_time: '2999-01-01T00:00:00.000Z' }
  assert.equal(await fixture({ provider: '115', accountId: 'a', token }).organizer.getToken(), token)
})

test('getToken 临期刷新且并发调用在存储锁语义下只刷新一次', async () => {
  const item = fixture({ provider: '115', accountId: 'a', token: { access_token: 'old', expire_time: '2000-01-01T00:00:00.000Z' } })
  const [first, second] = await Promise.all([item.organizer.getToken(), item.organizer.getToken()])
  assert.equal(first.access_token, 'new')
  assert.equal(second.access_token, 'new')
  assert.equal(item.getRefreshes(), 1)
})

test('ensureFolder 复用现有目录或创建目录并调用活动断言', async () => {
  const item = fixture({ provider: '115', accountId: 'a', token: { access_token: 'ok' } })
  let assertions = 0
  item.provider.files.list = async () => [{ fileId: '1', name: '影视', type: 'folder' }]
  item.provider.files.mkdir = async () => ({ fileId: '2', name: '新目录', type: 'folder' })
  assert.equal((await item.organizer.ensureFolder('0', '影视', { assertActive: () => { assertions += 1 } })).fileId, '1')
  item.provider.files.list = async () => []
  assert.equal((await item.organizer.ensureFolder('0', '新目录')).fileId, '2')
  assert.equal(assertions, 2)
})

test('waitForFiles 快速轮询至有文件并在耗尽后返回空数组', async () => {
  const item = fixture({ provider: '115', accountId: 'a', token: { access_token: 'ok' } })
  let calls = 0
  item.provider.files.list = async () => (++calls === 2 ? [{ fileId: '1' }] : [])
  assert.equal((await item.organizer.waitForFiles('0', { attempts: 3 })).length, 1)
  item.provider.files.list = async () => []
  assert.deepEqual(await item.organizer.waitForFiles('0', { attempts: 2 }), [])
})

test('renameFile 处理空结果和失败，basicOrganize 仅重命名有变化项', async () => {
  const item = fixture({ provider: '115', accountId: 'a', token: { access_token: 'ok' } })
  item.provider.files.renameBatch = async () => []
  await assert.rejects(() => item.organizer.renameFile('1', 'a'), /没有返回结果/)
  item.provider.files.renameBatch = async () => [{ status: 'error', message: '失败' }]
  await assert.rejects(() => item.organizer.renameFile('1', 'a'), /失败/)
  let renames
  item.provider.files.list = async () => [{ fileId: '1', name: '[广告]电影.mkv', type: 'file' }, { fileId: '2', name: '正常.mp4', type: 'file' }]
  item.provider.files.renameBatch = async ({ renames: value }) => { renames = value; return [{ status: 'success' }] }
  const result = await item.organizer.basicOrganize('0')
  assert.deepEqual(renames, [{ fileId: '1', newName: '电影.mkv' }])
  assert.equal(result.results.length, 1)
})
