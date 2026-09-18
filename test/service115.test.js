import test from 'node:test'
import assert from 'node:assert/strict'
import { Service115 } from '../src/service115.js'

test('getHeaders 返回副本并设置 Cookie', () => {
  const service = new Service115()
  const headers = service.getHeaders('UID=1')
  assert.equal(headers.Cookie, 'UID=1')
  headers.Host = 'changed'
  assert.equal(service.headers.Host, 'webapi.115.com')
})

test('getUserInfo 校验 Cookie 并映射用户', async () => {
  const service = new Service115({ http: { get: async () => ({ data: { state: true, data: { user_name: '用户' } } }) } })
  await assert.rejects(() => service.getUserInfo(''), /Cookie为空/)
  assert.deepEqual(await service.getUserInfo('cookie'), { success: true, name: '用户' })
  const failed = new Service115({ http: { get: async () => ({ data: { state: false, error: '过期' } }) } })
  await assert.rejects(() => failed.getUserInfo('cookie'), /过期/)
})

test('getFolderList 仅返回目录并标准化标识', async () => {
  const service = new Service115({ http: { get: async (_url, options) => {
    assert.equal(options.params.cid, '10')
    return { data: { state: true, path: [{ name: '根' }], data: [{ cid: 2, n: '目录' }, { fid: 3, n: '文件' }] } }
  } } })
  assert.deepEqual(await service.getFolderList('cookie', '10'), { success: true, path: [{ name: '根' }], list: [{ cid: '2', name: '目录' }] })
})

test('addFolder 编码请求并处理业务失败', async () => {
  let request
  const service = new Service115({ http: { post: async (...args) => { request = args; return { data: { state: true, data: { cid: 7 } } } } } })
  assert.deepEqual(await service.addFolder('cookie', '1', '影视 目录'), { success: true, cid: '7', name: '影视 目录' })
  assert.match(request[1], /pid=1/)
  assert.match(request[1], /cname=%E5%BD%B1%E8%A7%86%20%E7%9B%AE%E5%BD%95/)
  const failed = new Service115({ http: { post: async () => ({ data: { state: false, msg: '重名' } }) } })
  await assert.rejects(() => failed.addFolder('cookie', '1', '目录'), /重名/)
})

test('getShareInfo 合并分页、映射字段并过滤空标识', async () => {
  const calls = []
  const http = { async get(_url, options) {
    calls.push(options.params.offset)
    return { data: { state: true, data: { count: 3, share_title: 'demo', list: options.params.offset === 0
      ? [{ cid: '2', n: '目录' }, { fid: '1', n: 'a.mkv', fs: '10', sha1: 'abc' }]
      : [{ n: '无标识' }] } } }
  } }
  const info = await new Service115({ http, pageSize: 2 }).getShareInfo('cookie', 'share', 'pwd')
  assert.deepEqual(calls, [0, 2])
  assert.deepEqual(info.fileIds, ['1', '2'])
  assert.deepEqual(info.files[1], { shareFileId: '1', name: 'a.mkv', type: 'file', size: 10, contentHash: 'abc' })
  assert.equal(info.count, 3)
})

test('getShareInfo 在业务失败时抛出明确异常', async () => {
  const service = new Service115({ http: { get: async () => ({ data: { state: false, msg: '提取码错误' } }) } })
  await assert.rejects(() => service.getShareInfo('cookie', 'share', 'bad'), /提取码错误/)
})

test('saveFiles 空清单短路、请求正确且业务失败返回失败结果', async () => {
  let request
  const service = new Service115({ http: { post: async (...args) => { request = args; return { data: { state: true } } } } })
  assert.deepEqual(await service.saveFiles('cookie', '9', 'share', 'pwd', []), { success: true, count: 0 })
  assert.deepEqual(await service.saveFiles('cookie', '9', 'share', 'pwd', ['1', '2']), { success: true, count: 2 })
  assert.match(request[1], /file_id=1%2C2/)
  assert.equal(request[2].timeout, 30000)
  const failed = new Service115({ http: { post: async () => ({ data: { state: false, error: '拒绝' } }) } })
  assert.deepEqual(await failed.saveFiles('cookie', '9', 'share', '', ['1']), { success: false, msg: '拒绝' })
})
