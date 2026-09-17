/**
 * 可调度任务错误，携带稳定错误码和重试语义。
 */
export class TaskError extends Error {
  /**
   * 创建任务错误。
   * @param {string} code 稳定错误码。
   * @param {string} message 面向用户的错误消息。
   * @param {{retryable?: boolean, attention?: boolean, cause?: unknown, retryAt?: number}} options 错误选项。
   */
  constructor(code, message, { retryable = false, attention = false, cause, retryAt = 0 } = {}) {
    super(message, { cause })
    this.name = 'TaskError'
    this.code = code
    this.retryable = retryable
    this.attention = attention
    this.retryAt = retryAt
  }
}

/**
 * 将外部服务异常归类为结构化任务错误。
 * @param {unknown} error 原始异常。
 * @returns {TaskError} 可用于调度的任务错误。
 */
export function classifyTaskError(error) {
  if (error instanceof TaskError) return error
  const message = error instanceof Error ? error.message : String(error || '未知错误')
  const status = Number(error?.response?.status || error?.status || error?.statusCode || 0)
  if (status === 429 || /限流|频繁|rate.?limit|too many/i.test(message)) return new TaskError('RATE_LIMITED', message, { retryable: true, cause: error })
  if (status >= 500 || /timeout|timed out|超时|ECONN|ENOTFOUND|fetch failed|网络|暂时|稍后/i.test(`${message} ${error?.cause?.code || ''}`)) return new TaskError('TEMPORARY', message, { retryable: true, cause: error })
  if (status === 401 || status === 403 || /Cookie|OAuth|token|未配置|登录|认证|授权/i.test(message)) return new TaskError('AUTH_CONFIG', message, { attention: true, cause: error })
  if (/链接无效|分享.*失效|提取码|不存在|已取消分享/i.test(message)) return new TaskError('INVALID_SHARE', message, { cause: error })
  if (/取消|cancel/i.test(message)) return new TaskError('CANCELLED', message, { cause: error })
  return new TaskError('PERMANENT', message, { cause: error })
}
