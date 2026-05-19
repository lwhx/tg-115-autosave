export function parse115ShareLinks(text = '') {
  const links = []
  const seen = new Set()
  const patterns = [
    /https?:\/\/(?:www\.)?(?:115cdn\.com|115\.com)\/s\/([A-Za-z0-9_-]+)(?:[^\s#]*)?(?:#)?/gi,
    /(?:115cdn\.com|115\.com)\/s\/([A-Za-z0-9_-]+)(?:[^\s#]*)?(?:#)?/gi,
  ]

  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const raw = match[0].replace(/#+$/g, '')
      const shareCode = match[1]
      const receiveCode = extractReceiveCode(raw, text, match.index || 0)
      const key = `${shareCode}:${receiveCode}`
      if (!seen.has(key)) {
        links.push({ shareCode, receiveCode, raw })
        seen.add(key)
      }
    }
  }
  return links
}

function extractReceiveCode(raw, fullText, index) {
  const urlPassword = raw.match(/[?&](?:password|pwd|receive_code)=([^&#\s]+)/i)
  if (urlPassword) return cleanCode(urlPassword[1])

  const windowText = fullText.slice(index, Math.min(fullText.length, index + 160))
  const nearby = windowText.match(/(?:提取码|访问码|密码|password|pwd)[:：=\s]*([A-Za-z0-9]{4,8})/i)
  return nearby ? cleanCode(nearby[1]) : ''
}

function cleanCode(value) {
  return String(value || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 16)
}

export function sanitizeFileName(name = '未命名任务') {
  const cleaned = String(name)
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '')
  return (cleaned || '未命名任务').slice(0, 120)
}

export function normalizeMediaName(name = '') {
  return sanitizeFileName(
    String(name)
      .replace(/\[(?:公众号|微信|QQ群|TG|Telegram|广告)[^\]]*\]/gi, '')
      .replace(/(?:更多资源|关注公众号|扫码进群|禁止在线解压).*/gi, '')
  )
}
