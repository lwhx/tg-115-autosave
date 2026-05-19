import { sanitizeFileName } from './shareLinks.js'

function dateFolder(date = new Date()) {
  return date.toISOString().slice(0, 10)
}

export class TaskRunner {
  constructor({ repo, receiver, organizer, notifier }) {
    this.repo = repo
    this.receiver = receiver
    this.organizer = organizer
    this.notifier = notifier
    this.running = new Set()
  }

  async run(taskId) {
    if (this.running.has(taskId)) return
    this.running.add(taskId)
    try {
      await this.execute(taskId)
    } finally {
      this.running.delete(taskId)
    }
  }

  async execute(taskId) {
    const settings = this.repo.getSettings()
    const task = this.repo.getTask(taskId)
    if (!task) return
    const cookie = settings.cookie115 || ''
    const rootCid = settings.targetRootCid || '0'
    if (!cookie) {
      await this.fail(task, 'needs_attention', '未配置 115 Cookie')
      return
    }

    try {
      this.repo.updateTask(task.id, { status: 'receiving', error: '' })
      this.repo.addEvent(task.id, 'info', '开始解析分享')
      const share = await this.receiver.getShareInfo(cookie, task.share_code, task.receive_code)
      this.repo.updateTask(task.id, { title: sanitizeFileName(share.shareTitle) })
      this.repo.replaceTaskFiles(task.id, share.files)

      const dayFolder = await this.organizer.ensureFolder(rootCid, 'TG自动转存')
      const dateDir = await this.organizer.ensureFolder(dayFolder.fileId, dateFolder())
      const title = sanitizeFileName(share.shareTitle)
      const taskDir = await this.organizer.ensureFolder(dateDir.fileId, title)
      this.repo.updateTask(task.id, { target_cid: taskDir.fileId, target_path: `TG自动转存/${dateFolder()}/${title}` })

      this.repo.addEvent(task.id, 'info', `开始转存 ${share.fileIds.length} 个条目`)
      const saved = await this.receiver.saveFiles(cookie, taskDir.fileId, task.share_code, task.receive_code, share.fileIds)
      if (!saved.success) throw new Error(saved.msg || '转存失败')
      this.repo.updateTask(task.id, { status: 'received' })

      const savedItems = await this.organizer.waitForFiles(taskDir.fileId)
      if (savedItems.length === 0) throw new Error('转存后未在目标目录扫描到文件')
      this.repo.replaceTaskFiles(task.id, savedItems.map((item) => ({ savedFileId: item.fileId, name: item.name, type: item.type, size: item.size })))

      this.repo.updateTask(task.id, { status: 'organizing' })
      const organized = await this.organizer.basicOrganize(taskDir.fileId)
      const failedRenames = organized.results.filter((item) => item.status === 'error')
      if (failedRenames.length > 0) this.repo.addEvent(task.id, 'warn', '部分文件重命名失败', { failedRenames })

      this.repo.updateTask(task.id, { status: 'success', error: '' })
      this.repo.addEvent(task.id, 'info', '任务完成', { count: savedItems.length })
      await this.notify(`115 转存完成：${title}\n目录：TG自动转存/${dateFolder()}/${title}`)
    } catch (error) {
      const status = /Cookie|OAuth|token|未配置/.test(error.message) ? 'needs_attention' : 'failed'
      await this.fail(task, status, error.message)
    }
  }

  async fail(task, status, message) {
    this.repo.updateTask(task.id, { status, error: message })
    this.repo.addEvent(task.id, 'error', message)
    await this.notify(`115 转存失败：${task.share_code}\n${message}`)
    return new Error(message)
  }

  async notify(message) {
    if (this.notifier) await this.notifier(message).catch(() => {})
  }
}
