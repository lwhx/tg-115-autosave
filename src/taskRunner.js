import crypto from 'node:crypto'
import { normalizeMediaName, sanitizeFileName } from './shareLinks.js'
import { TaskError, classifyTaskError } from './taskError.js'

/** 阶段执行顺序。 */
const STAGES = ['queued', 'share_resolved', 'directory_ready', 'transfer_requesting', 'transfer_requested', 'files_confirmed', 'organized', 'completed']

/**
 * 返回任务首次采用并永久固定的日期目录。
 * @param {Date} date 日期。
 * @returns {string} YYYY-MM-DD 日期。
 */
function dateFolder(date = new Date()) {
  return date.toISOString().slice(0, 10)
}

/**
 * 生成分享文件集合指纹。
 * @param {string[]} fileIds 文件标识集合。
 * @returns {string} SHA-256 指纹。
 */
function fingerprint(fileIds) {
  return crypto.createHash('sha256').update([...fileIds].sort().join(',')).digest('hex')
}

/**
 * 判断当前阶段是否早于目标阶段。
 * @param {string} current 当前阶段。
 * @param {string} target 目标阶段。
 * @returns {boolean} 是否需要执行目标阶段。
 */
function before(current, target) {
  return STAGES.indexOf(current) < STAGES.indexOf(target)
}

/** 按名称、类型、可用的大小/哈希一一核对，保留分享文件和目标文件的对应关系。 */
function matchSavedFiles(expected, actual) {
  const remaining = [...actual]
  const matched = []
  const missing = []
  for (const file of expected) {
    const index = remaining.findIndex((item) => {
      if (!item.fileId || item.name !== (file.original_name || file.name) || item.type !== file.type) return false
      if (file.type === 'file' && file.size != null && item.size != null && Number(file.size) !== Number(item.size)) return false
      if (file.content_hash && item.contentHash && file.content_hash.toLowerCase() !== String(item.contentHash).toLowerCase()) return false
      return true
    })
    if (index < 0) missing.push(file)
    else matched.push({ ...remaining.splice(index, 1)[0], shareFileId: file.share_file_id })
  }
  return { matched, missing, unexpected: remaining }
}

/** 支持断点恢复的任务执行器。 */
export class TaskRunner {
  /**
   * 创建任务执行器。
   * @param {{repo: object, receiver: object, organizer: object, transferRetryWindowMs?: number}} options 依赖与配置。
   */
  constructor({ repo, receiver, organizer, transferRetryWindowMs = 60000 }) {
    this.repo = repo
    this.receiver = receiver
    this.organizer = organizer
    this.transferRetryWindowMs = transferRetryWindowMs
  }

  /**
   * 断言任务租约仍由当前执行器持有。
   * @param {number} taskId 任务标识。
   * @param {string} owner 租约所有者。
   * @returns {object} 当前任务。
   * @throws {TaskError} 租约已失效或被其他执行器接管。
   */
  assertLease(taskId, owner) {
    const task = this.repo.assertTaskLease(taskId, owner)
    if (!task) throw new TaskError('LEASE_LOST', '任务租约已失效，停止当前执行器')
    if (task.cancel_requested) throw new TaskError('CANCELLED', '任务已取消')
    return task
  }

  /**
   * 执行受租约保护的任务更新。
   * @param {number} taskId 任务标识。
   * @param {string} owner 租约所有者。
   * @param {object} patch 更新内容。
   * @returns {object} 更新后的任务。
   * @throws {TaskError} 更新时租约已失效。
   */
  updateTask(taskId, owner, patch) {
    const task = this.repo.updateTaskWithLease(taskId, owner, patch)
    if (!task) throw new TaskError('LEASE_LOST', '任务租约已失效，停止当前执行器')
    return task
  }

  /**
   * 执行受租约保护的阶段更新。
   * @param {number} taskId 任务标识。
   * @param {string} owner 租约所有者。
   * @param {string} stage 目标阶段。
   * @param {object} patch 附加更新内容。
   * @returns {object} 更新后的任务。
   * @throws {TaskError} 更新时租约已失效。
   */
  updateStage(taskId, owner, stage, patch = {}) {
    const task = this.repo.updateStage(taskId, owner, stage, patch)
    if (!task) throw new TaskError('LEASE_LOST', '任务租约已失效，停止当前执行器')
    return task
  }

  /**
   * 从持久化阶段继续执行任务。
   * @param {number} taskId 任务标识。
   * @param {string} owner 租约所有者。
   * @param {{signal?: AbortSignal}} options 租约失效的停止信号。
   * @returns {Promise<object|null>} 完成后的任务。
   * @throws {TaskError} 配置缺失、取消、租约失效或转存结果不符合预期。
   */
  async execute(taskId, owner, { signal } = {}) {
    const assertLease = () => {
      if (signal?.aborted) throw new TaskError('LEASE_LOST', '续租失败，停止当前执行器')
      return this.assertLease(taskId, owner)
    }
    let task = assertLease()
    const settings = this.repo.getSettings()
    const cookie = settings.cookie115 || ''
    const rootCid = settings.targetRootCid || '0'
    if (!cookie) throw new TaskError('AUTH_CONFIG', '未配置 115 Cookie', { attention: true })

    // 旧执行器创建的同名目录无法证明归属。保留远端旧目录，在新目录继续任务。
    if (task.target_cid && !task.directory_isolated && before(task.stage, 'files_confirmed')) {
      task = this.updateStage(task.id, owner, 'queued', {
        target_cid: '', target_path: '', target_folder_name: '',
        transfer_attempt_count: 0, transfer_requested_at: '',
      })
      this.repo.addEvent(task.id, 'info', '旧目录已保留，本任务改用独立目录重新转存')
    }

    if (before(task.stage, 'share_resolved')) {
      assertLease()
      const share = await this.receiver.getShareInfo(cookie, task.share_code, task.receive_code)
      if (!share.fileIds.length) throw new TaskError('INVALID_SHARE', '分享中没有可转存的文件')
      const title = sanitizeFileName(share.shareTitle)
      assertLease()
      this.repo.replaceTaskFiles(task.id, share.files)
      task = this.updateStage(task.id, owner, 'share_resolved', {
        title, expected_file_count: share.fileIds.length, expected_fingerprint: fingerprint(share.fileIds),
      })
      this.repo.addEvent(task.id, 'info', '分享解析完成', { count: share.fileIds.length })
    }

    if (before(task.stage, 'directory_ready')) {
      const folderDate = task.folder_date || dateFolder()
      if (!task.folder_date) task = this.updateTask(task.id, owner, { folder_date: folderDate })
      assertLease()
      const baseDir = await this.organizer.ensureFolder(rootCid, 'TG自动转存', { assertActive: assertLease })
      assertLease()
      const dateDir = await this.organizer.ensureFolder(baseDir.fileId, folderDate, { assertActive: assertLease })
      assertLease()
      if (!task.target_folder_name) {
        const suffix = ` [${task.id}-${crypto.randomBytes(6).toString('hex')}]`
        task = this.updateTask(task.id, owner, { target_folder_name: task.title.slice(0, 120 - suffix.length) + suffix })
      }
      const taskDir = await this.organizer.ensureFolder(dateDir.fileId, task.target_folder_name, { assertActive: assertLease })
      assertLease()
      if (!taskDir.fileId) throw new TaskError('TEMPORARY', '创建目录后未获得目录 ID', { retryable: true })
      task = this.updateStage(task.id, owner, 'directory_ready', {
        folder_date: folderDate, target_cid: taskDir.fileId, directory_isolated: 1,
        target_path: `TG自动转存/${folderDate}/${task.target_folder_name}`,
      })
    }

    if (task.stage === 'directory_ready') task = this.updateStage(task.id, owner, 'transfer_requesting')
    if (task.stage === 'transfer_requesting' || task.stage === 'transfer_requested') {
      try {
        const files = this.repo.listTaskFiles(task.id).filter((file) => file.share_file_id)
        const fileIds = files.map((file) => file.share_file_id)
        if (!files.length || files.length !== task.expected_file_count || fingerprint(fileIds) !== task.expected_fingerprint) {
          throw new TaskError('MANIFEST_MISMATCH', '分享文件清单不完整，无法安全确认转存', { attention: true })
        }
        assertLease()
        let savedItems = await this.organizer.list(task.target_cid)
        assertLease()
        if (savedItems.length && !task.transfer_requested_at) {
          throw new TaskError('DIRECTORY_CONFLICT', '转存前目标目录已存在文件，请人工检查', { attention: true })
        }
        let comparison = matchSavedFiles(files, savedItems)
        if (comparison.unexpected.length) {
          throw new TaskError('CONTENT_MISMATCH', '目标目录存在不属于分享清单的内容，请人工检查', { attention: true })
        }
        if (comparison.missing.length) {
          const requestedAt = Date.parse(task.transfer_requested_at) || 0
          const retryAt = requestedAt + this.transferRetryWindowMs
          if (requestedAt && Date.now() < retryAt) {
            throw new TaskError('TEMPORARY', '等待上次转存请求确认', { retryable: true, retryAt })
          }
          task = this.updateStage(task.id, owner, 'transfer_requesting', {
            transfer_attempt_count: task.transfer_attempt_count + 1,
            transfer_requested_at: new Date().toISOString(),
          })
          assertLease()
          // 已确认存在的条目不再提交，部分转存可在确认窗口结束后补齐。
          const missingIds = comparison.missing.map((file) => file.share_file_id)
          const result = await this.receiver.saveFiles(cookie, task.target_cid, task.share_code, task.receive_code, missingIds)
          assertLease()
          if (!result.success) throw result.error || new Error(result.msg || '转存失败')
          task = this.updateStage(task.id, owner, 'transfer_requested')
          assertLease()
          savedItems = await this.organizer.waitForFiles(task.target_cid, { assertActive: assertLease })
          comparison = matchSavedFiles(files, savedItems)
        }
        if (comparison.unexpected.length) {
          throw new TaskError('CONTENT_MISMATCH', '目标目录内容与分享文件清单不一致，请人工检查', { attention: true })
        }
        if (comparison.missing.length) {
          throw new TaskError('TEMPORARY', `目标目录文件尚未完整出现（${savedItems.length}/${files.length}）`, {
            retryable: true, retryAt: Date.now() + this.transferRetryWindowMs,
          })
        }
        assertLease()
        this.repo.syncSavedTaskFiles(task.id, comparison.matched)
        task = this.updateStage(task.id, owner, 'files_confirmed')
      } catch (rawError) {
        const error = classifyTaskError(rawError)
        if (error.retryable && task.transfer_requested_at) {
          error.retryAt = Math.max(error.retryAt || 0, Date.parse(task.transfer_requested_at) + this.transferRetryWindowMs)
        }
        throw error
      }
    }

    if (before(task.stage, 'organized')) {
      const files = this.repo.listTaskFiles(task.id).filter((file) => file.saved_file_id && file.organize_status !== 'completed')
      for (const file of files) {
        assertLease()
        const targetName = normalizeMediaName(file.original_name || file.name, { isFolder: file.type === 'folder' })
        if (!targetName || targetName === file.name) {
          this.repo.updateTaskFile(file.id, { target_name: targetName || file.name, organize_status: 'completed', organized_at: new Date().toISOString(), organize_error: '' })
          continue
        }
        const result = await this.organizer.renameFile(file.saved_file_id, targetName, { assertActive: assertLease })
        if (result.status === 'error') throw result.error || new Error(result.message || `重命名失败：${file.name}`)
        assertLease()
        this.repo.updateTaskFile(file.id, { name: targetName, target_name: targetName, organize_status: 'completed', organized_at: new Date().toISOString(), organize_error: '' })
      }
      task = this.updateStage(task.id, owner, 'organized')
    }

    assertLease()
    const completed = this.repo.completeTask(task.id, owner)
    if (!completed) throw new TaskError('LEASE_LOST', '任务租约已失效，停止当前执行器')
    return completed
  }
}
