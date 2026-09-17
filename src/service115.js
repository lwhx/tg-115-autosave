import axios from 'axios'
import { stringify } from 'node:querystring'
import https from 'node:https'

export class Service115 {
  constructor({ http = axios, pageSize = 100 } = {}) {
    this.http = http
    this.pageSize = pageSize
    this.agent = new https.Agent({ keepAlive: true })
    this.headers = {
      Host: 'webapi.115.com',
      Connection: 'keep-alive',
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/98.0.4758.102 Safari/537.36 MicroMessenger/6.8.0(0x16080000) NetType/WIFI MiniProgramEnv/Mac MacWechat/WMPF XWEB/30626',
      Referer: 'https://servicewechat.com/wx2c744c010a61b0fa/94/page-frame.html',
      'Accept-Encoding': 'gzip, deflate, br',
      Accept: '*/*',
    }
  }

  getHeaders(cookie) {
    return { ...this.headers, Cookie: cookie }
  }

  async getUserInfo(cookie) {
    if (!cookie) throw new Error('Cookie为空')
    const res = await this.http.get('https://webapi.115.com/files/index_info', {
      headers: this.getHeaders(cookie),
      httpsAgent: this.agent,
      timeout: 6000,
    })
    if (res.data?.state) return { success: true, name: res.data.data?.user_name || '115用户' }
    throw new Error(res.data?.error || res.data?.msg || 'Cookie无效或已过期')
  }

  async getFolderList(cookie, cid = '0') {
    const res = await this.http.get('https://webapi.115.com/files', {
      headers: this.getHeaders(cookie),
      httpsAgent: this.agent,
      params: { aid: 1, cid, o: 'user_ptime', asc: 0, offset: 0, show_dir: 1, limit: 100, type: 0, format: 'json' },
    })
    if (!res.data?.state) throw new Error(res.data?.error || '获取目录失败')
    return {
      success: true,
      path: res.data.path,
      list: (res.data.data || []).filter((item) => item.cid).map((item) => ({ cid: String(item.cid), name: item.n })),
    }
  }

  async addFolder(cookie, parentCid, folderName) {
    const res = await this.http.post('https://webapi.115.com/files/add', stringify({ pid: parentCid, cname: folderName }), {
      headers: this.getHeaders(cookie),
      httpsAgent: this.agent,
    })
    if (res.data?.state) return { success: true, cid: String(res.data.data?.cid), name: res.data.data?.file_name || folderName }
    throw new Error(res.data?.error || res.data?.msg || '创建文件夹失败')
  }

  async getShareInfo(cookie, shareCode, receiveCode) {
    const all = []
    let offset = 0
    let title = ''
    let total = 0
    while (true) {
      const res = await this.http.get('https://webapi.115.com/share/snap', {
        headers: this.getHeaders(cookie),
        httpsAgent: this.agent,
        timeout: 10000,
        params: { share_code: shareCode, receive_code: receiveCode, offset, limit: this.pageSize, cid: '' },
      })
      if (!res.data?.state) throw new Error(res.data?.error || res.data?.msg || '链接无效或提取码错误')
      const data = res.data.data || {}
      const list = Array.isArray(data.list) ? data.list : []
      all.push(...list)
      title = title || data.share_title || list[0]?.n || '未命名任务'
      total = Number(data.count || list.length || all.length)
      offset += this.pageSize
      if (list.length < this.pageSize || all.length >= total) break
    }
    return {
      success: true,
      fileIds: all.map((item) => String(item.cid || item.fid || '')).filter(Boolean).sort(),
      files: all.map((item) => ({ shareFileId: String(item.cid || item.fid || ''), name: item.n || '', type: item.cid ? 'folder' : 'file', size: item.s != null || item.fs != null ? Number(item.s ?? item.fs) : null, contentHash: item.sha || item.sha1 || '' })),
      shareTitle: title,
      count: total,
    }
  }

  async saveFiles(cookie, targetCid, shareCode, receiveCode, fileIds) {
    if (!fileIds?.length) return { success: true, count: 0 }
    const res = await this.http.post('https://webapi.115.com/share/receive', stringify({
      cid: targetCid,
      share_code: shareCode,
      receive_code: receiveCode,
      file_id: fileIds.join(','),
    }), {
      headers: this.getHeaders(cookie),
      httpsAgent: this.agent,
      timeout: 30000,
    })
    if (res.data?.state) return { success: true, count: fileIds.length }
    return { success: false, msg: res.data?.error || res.data?.msg || '转存被拒绝' }
  }
}

export default new Service115()
