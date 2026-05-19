const $ = (id) => document.getElementById(id)

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok || data.ok === false) throw new Error(data.error || res.statusText)
  return data
}

function show(id, message) { $(id).textContent = typeof message === 'string' ? message : JSON.stringify(message, null, 2) }
function value(id) { return $(id).value.trim() }

async function login() {
  try {
    await api('/api/admin/login', { method: 'POST', body: JSON.stringify({ password: value('password') }) })
    $('loginPanel').classList.add('hidden')
    $('appPanel').classList.remove('hidden')
    await loadSettings()
    await loadTasks()
  } catch (error) { show('loginStatus', error.message) }
}

async function loadSettings() {
  const data = await api('/api/settings')
  const s = data.settings || {}
  $('cookie115').value = s.cookie115 || ''
  $('telegramBotToken').value = s.telegramBotToken || ''
  $('telegramChatId').value = s.telegramChatId || ''
  $('telegramNotifyChatId').value = s.telegramNotifyChatId || ''
  $('targetRootCid').value = s.targetRootCid || '0'
  show('settingsStatus', `数据目录：${data.dataDir}\nOAuth 账号：${(data.accounts || []).map((a) => a.accountId).join(', ') || '未配置'}`)
}

async function saveSettings() {
  try {
    const payload = {
      cookie115: $('cookie115').value,
      telegramBotToken: $('telegramBotToken').value,
      telegramChatId: value('telegramChatId'),
      telegramNotifyChatId: value('telegramNotifyChatId'),
      targetRootCid: value('targetRootCid') || '0',
    }
    await api('/api/settings', { method: 'PUT', body: JSON.stringify(payload) })
    show('settingsStatus', '配置已保存')
    await loadSettings()
  } catch (error) { show('settingsStatus', error.message) }
}

async function startOauth() {
  try {
    const data = await api('/api/settings/115-oauth/start', { method: 'POST', body: '{}' })
    renderOauth(data)
    pollOauth()
  } catch (error) { show('oauthStatus', error.message) }
}

async function pollOauth() {
  const timer = setInterval(async () => {
    try {
      const data = await api('/api/settings/115-oauth/status')
      renderOauth(data)
      if (data.status === 'success' || data.status === 'failed') clearInterval(timer)
    } catch { clearInterval(timer) }
  }, 2000)
}

function renderOauth(data) {
  show('oauthStatus', `状态：${data.status}${data.error ? '\n' + data.error : ''}`)
  $('oauthQr').innerHTML = data.qrcode ? `<p class="muted">用 115 App 扫码：</p><code>${data.qrcode}</code><p><img alt="qr" src="https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${encodeURIComponent(data.qrcode)}"></p>` : ''
}

async function loadTasks() {
  try {
    const data = await api('/api/tasks')
    $('tasks').innerHTML = renderTasks(data.tasks || [])
    $('events').innerHTML = renderEvents(data.events || [])
  } catch (error) { $('tasks').textContent = error.message }
}

function renderTasks(tasks) {
  if (!tasks.length) return '<p class="muted">暂无任务</p>'
  return `<table><thead><tr><th>ID</th><th>状态</th><th>标题</th><th>分享</th><th>目录/错误</th><th></th></tr></thead><tbody>${tasks.map((t) => `<tr><td>${t.id}</td><td><span class="badge ${t.status}">${t.status}</span></td><td>${escapeHtml(t.title || '')}</td><td><code>${t.share_code}</code></td><td>${escapeHtml(t.target_path || t.error || '')}</td><td><button class="ghost" onclick="retryTask(${t.id})">重试</button></td></tr>`).join('')}</tbody></table>`
}

function renderEvents(events) {
  if (!events.length) return '<p class="muted">暂无事件</p>'
  return `<table><thead><tr><th>时间</th><th>任务</th><th>级别</th><th>消息</th></tr></thead><tbody>${events.map((e) => `<tr><td>${e.created_at}</td><td>${e.task_id || ''}</td><td>${e.level}</td><td>${escapeHtml(e.message)}</td></tr>`).join('')}</tbody></table>`
}

async function manualTask() {
  try {
    const data = await api('/api/tasks/manual', { method: 'POST', body: JSON.stringify({ text: $('manualText').value }) })
    show('manualStatus', `已创建/处理 ${data.count} 个任务`)
    await loadTasks()
  } catch (error) { show('manualStatus', error.message) }
}

window.retryTask = async (id) => {
  await api(`/api/tasks/${id}/retry`, { method: 'POST', body: '{}' })
  await loadTasks()
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (ch) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[ch]))
}

$('loginBtn').onclick = login
$('saveSettingsBtn').onclick = saveSettings
$('startOauthBtn').onclick = startOauth
$('manualBtn').onclick = manualTask
$('refreshBtn').onclick = loadTasks
$('testCookieBtn').onclick = async () => { try { show('settingsStatus', await api('/api/settings/test-115-cookie', { method: 'POST', body: '{}' })) } catch (e) { show('settingsStatus', e.message) } }
$('testBotBtn').onclick = async () => { try { show('settingsStatus', await api('/api/settings/test-telegram', { method: 'POST', body: '{}' })) } catch (e) { show('settingsStatus', e.message) } }
$('testOauthBtn').onclick = async () => { try { show('settingsStatus', await api('/api/settings/test-115-oauth', { method: 'POST', body: '{}' })) } catch (e) { show('settingsStatus', e.message) } }
setInterval(() => { if (!$('appPanel').classList.contains('hidden')) loadTasks() }, 8000)

