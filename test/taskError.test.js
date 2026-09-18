import assert from 'node:assert/strict'
import test from 'node:test'
import { TaskError, classifyTaskError } from '../src/taskError.js'

const cases = [
  ['429 状态', { response: { status: 429 }, message: '请求失败' }, 'RATE_LIMITED', true, false],
  ['限流文本', new Error('请求过于频繁'), 'RATE_LIMITED', true, false],
  ['服务端错误', { status: 503, message: '服务失败' }, 'TEMPORARY', true, false],
  ['网络错误', Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNRESET' } }), 'TEMPORARY', true, false],
  ['401 状态', { statusCode: 401, message: '拒绝' }, 'AUTH_CONFIG', false, true],
  ['403 状态', { response: { status: 403 }, message: '拒绝' }, 'AUTH_CONFIG', false, true],
  ['Cookie 错误', new Error('Cookie无效'), 'AUTH_CONFIG', false, true],
  ['OAuth 错误', new Error('OAuth token 未配置'), 'AUTH_CONFIG', false, true],
  ['无效分享', new Error('分享链接无效'), 'INVALID_SHARE', false, false],
  ['取消', new Error('cancelled'), 'CANCELLED', false, false],
  ['普通异常', new Error('格式错误'), 'PERMANENT', false, false],
  ['非 Error', '字符串异常', 'PERMANENT', false, false],
]

for (const [name, input, code, retryable, attention] of cases) {
  test(`classifyTaskError：${name}`, () => {
    const error = classifyTaskError(input)
    assert.equal(error.code, code)
    assert.equal(error.retryable, retryable)
    assert.equal(error.attention, attention)
    assert.equal(error.cause, input)
  })
}

test('TaskError 保留 retryAt、cause 且重复分类返回原对象', () => {
  const cause = new Error('原始异常')
  const error = new TaskError('TEMPORARY', '稍后重试', { retryable: true, retryAt: 1234, cause })
  assert.equal(error.retryAt, 1234)
  assert.equal(error.cause, cause)
  assert.equal(classifyTaskError(error), error)
})
