import assert from 'node:assert/strict'
import test from 'node:test'
import { createDrive115Provider } from '../src/drive115Provider.js'

/** 创建模拟 fetch 响应。 */
function response(data, { ok = true, status = 200, text = '' } = {}) {
  return { ok, status, async json() { return data }, async text() { return text } }
}

test('provider 刷新 token 并保留回退字段', async () => {
  let request
  const provider = createDrive115Provider({ fetcher: async (...args) => { request = args; return response({ data: { access_token: 'new', refresh_token: 'refresh2', expires_in: 60 } }) } })
  const token = await provider.auth.refresh({ access_token: 'old', refresh_token: 'refresh1' })
  assert.equal(token.access_token, 'new')
  assert.equal(token.refresh_token, 'refresh2')
  assert.match(request[1].body, /refresh_token=refresh1/)
  assert.ok(Date.parse(token.expire_time) > Date.now())
})

test('provider 分页列目录并映射文件和目录', async () => {
  const calls = []
  const firstPage = Array.from({ length: 200 }, (_, index) => ({ fid: `f${index}`, pid: '9', n: `文件${index}`, fc: '1', fs: '2' }))
  const provider = createDrive115Provider({ fetcher: async (url) => {
    calls.push(url)
    return response({ count: 201, data: url.includes('offset=0') ? firstPage : [{ cid: 'd1', pid: '9', n: '目录', fc: '0' }] })
  } })
  const list = await provider.files.list({ token: { access_token: 'x', user_id: 'u' }, parentFileId: '9' })
  assert.equal(calls.length, 2)
  assert.equal(list.length, 201)
  assert.deepEqual(list[200], { provider: '115', accountId: 'u', driveId: '115', fileId: 'd1', parentFileId: '9', name: '目录', type: 'folder', size: undefined, contentHash: '' })
})

test('provider 重命名允许部分失败并创建目录', async () => {
  let calls = 0
  const provider = createDrive115Provider({ fetcher: async (_url, init) => {
    calls += 1
    if (calls === 2) return response({}, { ok: false, status: 500, text: 'bad' })
    if (String(init.body).includes('file_name=%E7%9B%AE%E5%BD%95')) return response({ data: { file_id: 'dir' } })
    return response({ code: 0 })
  } })
  const results = await provider.files.renameBatch({ token: { access_token: 'x' }, renames: [{ fileId: '1', newName: '一' }, { fileId: '2', newName: '二' }] })
  assert.equal(results[0].status, 'success')
  assert.equal(results[1].status, 'error')
  assert.equal(results[1].error.status, 500)
  const folder = await provider.files.mkdir({ token: { access_token: 'x', accountId: 'a' }, parentId: '0', name: '目录' })
  assert.equal(folder.fileId, 'dir')
  assert.equal(folder.type, 'folder')
})

test('provider 对 HTTP 和业务错误抛出异常', async () => {
  const httpFailure = createDrive115Provider({ fetcher: async () => response({}, { ok: false, status: 401, text: 'denied' }) })
  await assert.rejects(() => httpFailure.files.list({ token: { access_token: 'x' } }), (error) => error.status === 401)
  const businessFailure = createDrive115Provider({ fetcher: async () => response({ code: 9, message: '业务失败' }) })
  await assert.rejects(() => businessFailure.files.mkdir({ token: { access_token: 'x' }, name: '目录' }), /业务失败/)
})
