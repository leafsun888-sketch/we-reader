const state = { library: { sources: [], updatedAt: null }, management: { accounts: [], settings: {}, job: {} }, tab: 'today', sourceId: null, favorites: new Set(), highlights: {}, reader: null, pendingRemoval: null, selectedText: '', selectionRange: null };
const content = document.querySelector('#content');
const meta = document.querySelector('#library-meta');
const refreshButton = document.querySelector('#refresh-button');
const jobStatus = document.querySelector('#job-status');
const syncStatus = document.querySelector('#sync-status');
const subscribeDialog = document.querySelector('#subscribe-dialog');
const settingsDialog = document.querySelector('#settings-dialog');
const removeDialog = document.querySelector('#remove-dialog');
const overLimitDialog = document.querySelector('#over-limit-dialog');
const toast = document.querySelector('#toast');

const esc = (value) => String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);
const dt = (time, options = {}) => time ? new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false, ...options }).format(new Date(time * 1000)) : '尚未同步';
const fullDt = (time) => time ? new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(time)) : '尚未更新';
const dayKey = (time) => new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', weekday: 'short' }).format(new Date(time * 1000));
const allArticles = () => state.library.sources.flatMap((source) => source.items.map((item) => ({ ...item, source: source.name, bookId: source.bookId }))).sort((a, b) => b.t - a.t);
const cutoff = (days) => Date.now() - days * 24 * 60 * 60 * 1000;
const sourceById = (id) => state.library.sources.find((source) => source.bookId === id);
const articleId = (article) => article.rid || article.url;
const articleById = (id) => allArticles().find((article) => articleId(article) === id);
let toastTimer;

function notify(message, kind = 'normal') {
  toast.textContent = message;
  toast.className = `toast show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.className = 'toast'; }, 4200);
}
function jobLabel(job) {
  if (job.status === 'running') return job.kind === 'refresh' ? '正在拉取并归档…' : '正在解析订阅…';
  if (job.status === 'failed') return '上次任务未完成';
  if (job.status === 'partial') return '同步部分完成';
  if (job.status === 'success') return '同步完成';
  return '准备就绪';
}
function updateHeader() {
  const running = state.management.job?.status === 'running';
  const sync = state.management.sync || {};
  const maxRuns = sync.maxRunsPerDay ?? 2;
  const runsToday = sync.runsToday ?? 0;
  const reachedLimit = maxRuns > 0 && runsToday >= maxRuns;
  syncStatus.textContent = `上次更新：${fullDt(sync.lastSuccessAt)} · 今日拉取：${runsToday}/${maxRuns} 次`;
  const currentJob = state.management.job || {};
  const needsAttention = currentJob.status === 'failed' || currentJob.status === 'partial';
  jobStatus.textContent = needsAttention && currentJob.message ? `${jobLabel(currentJob)}：${currentJob.message}` : jobLabel(currentJob);
  jobStatus.title = currentJob.message || '';
  jobStatus.className = `job-status ${running ? 'working' : ''}${needsAttention ? ' attention' : ''}`;
  refreshButton.disabled = running;
  refreshButton.title = reachedLimit ? `今日已拉取 ${runsToday}/${maxRuns} 次，点击后需要再次确认` : '';
  refreshButton.textContent = running ? '↻ 正在拉取…' : reachedLimit ? '↻ 仍要拉取' : '↻ 拉取更新';
}
function articleRow(article) {
  const id = articleId(article);
  const saved = state.favorites.has(id);
  return `<div class="article-row"><button class="article-link" type="button" data-read-article="${esc(id)}"><span class="article-source">${esc(article.source)}</span><span class="article-title">${esc(article.title)}</span><time>${dt(article.t)}</time></button><button class="favorite-button${saved ? ' saved' : ''}" data-favorite="${esc(id)}" aria-label="${saved ? '取消收藏' : '收藏文章'}" aria-pressed="${saved}">${saved ? '★' : '☆'}</button></div>`;
}
function empty(title, note) { return `<section class="empty"><div class="empty-icon">☾</div><h2>${title}</h2><p>${note}</p></section>`; }

function renderTimeline(days, title, description) {
  const articles = allArticles().filter((article) => article.t * 1000 >= cutoff(days));
  if (!articles.length) {
    content.innerHTML = `<section class="view-heading"><p class="eyebrow">TIME VIEW</p><h2>${title}</h2><p>${description}</p></section>${empty('这段时间还没有更新', '点击右上角「拉取更新」后，新文章会出现在这里。')}`;
    return;
  }
  const groups = new Map();
  for (const article of articles) groups.set(dayKey(article.t), [...(groups.get(dayKey(article.t)) || []), article]);
  content.innerHTML = `<section class="view-heading"><p class="eyebrow">TIME VIEW</p><h2>${title}</h2><p>${description} · ${articles.length} 篇</p></section><div class="timeline">${[...groups.entries()].map(([day, items]) => `<section class="day-group"><h3>${day}<span>${items.length}</span></h3>${items.map(articleRow).join('')}</section>`).join('')}</div>`;
}
function cover(source, index) {
  const colors = ['#ef6d54', '#6558d3', '#19917c', '#d9902b', '#b24b6e', '#2b799b'];
  return `<div class="book-cover" style="--cover:${colors[index % colors.length]}"><span>公众号</span><strong>${esc(source.name)}</strong><i>${source.items.length} 篇文章</i></div>`;
}
function renderShelf() {
  if (state.sourceId) return renderSource();
  const sourceMap = new Map(state.library.sources.map((source) => [source.bookId, source]));
  const accounts = [...state.management.accounts].sort((a, b) => (b.latestAt || 0) - (a.latestAt || 0));
  const initialLimit = state.management.settings?.initialArticleLimit || 50;
  content.innerHTML = `<section class="shelf-heading"><div><p class="eyebrow">LIBRARY</p><h2>全部书架</h2><p>点开一本“书”查看目录；右上角 × 可停止订阅。未完成初始化的账号会在下一次拉取时导入历史文章，已初始化的账号只拉取新文章。</p></div><button class="primary-button" data-open-subscribe>＋ 添加公众号</button></section><div class="shelf">${accounts.map((account, index) => {
    const source = sourceMap.get(account.bookId) || { ...account, items: [] };
    const ready = source.items.length > 0;
    return `<div class="book-entry${ready ? '' : ' pending-initialization'}">${ready ? '' : '<span class="initialization-badge">未完成初始化</span>'}<button class="book" ${ready ? `data-source="${esc(account.bookId)}"` : 'disabled'}>${cover(source, index)}<span class="book-name">${esc(account.name)}</span><span class="book-update">${ready ? `更新至 ${dt(source.items[0]?.t || 0, { year: 'numeric', month: 'numeric', day: 'numeric' })}` : `首次拉取将导入最近 ${initialLimit} 篇`}</span></button><button class="book-remove" data-remove="${esc(account.bookId)}" aria-label="停止订阅 ${esc(account.name)}">×</button></div>`;
  }).join('')}<button class="add-book" data-open-subscribe><span>＋</span><strong>添加公众号</strong><small>粘贴一篇文章链接</small></button></div>`;
}
function renderSource() {
  const source = sourceById(state.sourceId);
  if (!source) { state.sourceId = null; return renderShelf(); }
  const articles = [...source.items].sort((a, b) => b.t - a.t).map((item) => ({ ...item, source: source.name, bookId: source.bookId }));
  content.innerHTML = `<button class="back" data-back>← 返回书架</button><section class="source-header"><div class="source-cover">${esc(source.name).slice(0, 1)}</div><div><p class="eyebrow">PUBLIC ACCOUNT</p><h2>${esc(source.name)}</h2><p>完整目录 · ${articles.length} 篇文章</p></div></section><section class="catalog">${articles.map(articleRow).join('')}</section>`;
}
function renderFavorites() {
  const articles = allArticles().filter((article) => state.favorites.has(articleId(article)));
  if (!articles.length) return content.innerHTML = `<section class="view-heading"><p class="eyebrow">SAVED FOR LATER</p><h2>收藏待读</h2><p>把想看的文章收进这里，之后随时继续读。</p></section>${empty('还没有收藏文章', '点击任意文章右侧的 ☆，它就会出现在这里。')}`;
  content.innerHTML = `<section class="view-heading"><p class="eyebrow">SAVED FOR LATER</p><h2>收藏待读</h2><p>共 ${articles.length} 篇，按最近发布排序。</p></section><section class="catalog">${articles.map(articleRow).join('')}</section>`;
}
function localImageUrl(articleId, source) {
  const clean = String(source).replaceAll('&amp;', '&').trim();
  if (/^assets\/[\w.-]+$/i.test(clean)) return `/api/articles/${encodeURIComponent(articleId)}/assets/${encodeURIComponent(clean.slice(7))}`;
  return /^https:\/\//i.test(clean) ? clean : '';
}
function inlineMarkdown(text, articleId) {
  return esc(text)
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_, alt, source) => {
      const image = localImageUrl(articleId, source);
      return image ? `<img src="${esc(image)}" alt="${alt}" loading="lazy" />` : '';
    })
    .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, (_, label, href) => `<a href="${href}" target="_blank" rel="noreferrer">${label}</a>`)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
}
function readableMarkdown(raw) {
  let body = String(raw || '').replace(/^---\s*[\s\S]*?\n---\s*/m, '').trim();
  if (/^#\s+WeChat Article\s+\n?\s*String\.prototype\.html/m.test(body) || body.includes('\n参数错误\n')) return '';
  const tail = body.search(/\n\s*(?:var first_sceen__time|window\.logs\.pagetime|预览时标签不可点|微信扫一扫可打开此内容)/);
  if (tail >= 0) body = body.slice(0, tail);
  return body.trim();
}
function renderMarkdown(raw, articleId) {
  const body = readableMarkdown(raw);
  if (!body) return `<section class="reader-unavailable"><h3>这篇文章的本地 Markdown 暂不可读</h3><p>文件已经存在，但原文解析结果不完整。你仍可从右上角打开微信原文。</p></section>`;
  return body.split(/\r?\n/).map((line) => {
    if (!line.trim()) return '';
    if (/^###\s+/.test(line)) return `<h3>${inlineMarkdown(line.replace(/^###\s+/, ''), articleId)}</h3>`;
    if (/^##\s+/.test(line)) return `<h2>${inlineMarkdown(line.replace(/^##\s+/, ''), articleId)}</h2>`;
    if (/^#\s+/.test(line)) return `<h1>${inlineMarkdown(line.replace(/^#\s+/, ''), articleId)}</h1>`;
    if (/^>\s?/.test(line)) return `<blockquote>${inlineMarkdown(line.replace(/^>\s?/, ''), articleId)}</blockquote>`;
    if (/^[-*]\s+/.test(line)) return `<p class="reader-list">• ${inlineMarkdown(line.replace(/^[-*]\s+/, ''), articleId)}</p>`;
    if (/^!\[/.test(line)) return `<figure>${inlineMarkdown(line, articleId)}</figure>`;
    return `<p>${inlineMarkdown(line, articleId)}</p>`;
  }).join('');
}
function renderReader() {
  const { article, doc } = state.reader;
  const id = articleId(article);
  const saved = state.favorites.has(id);
  const highlights = state.highlights[id] || [];
  content.innerHTML = `<button class="back" data-back>← 返回文章列表</button><button class="reader-floating-back" data-back aria-label="返回文章列表">← <span>文章列表</span></button><article class="reader"><header class="reader-header"><p class="eyebrow">${esc(article.source)}</p><h1>${esc(doc.title || article.title)}</h1><p class="reader-meta">${dt(article.t, { year: 'numeric', month: 'numeric', day: 'numeric' })} · 本地 Markdown</p><div class="reader-actions"><button id="reader-favorite" class="reader-action${saved ? ' saved' : ''}" data-favorite="${esc(id)}">${saved ? '★ 已收藏' : '☆ 收藏'}</button><a class="reader-action" href="${esc(article.url)}" target="_blank" rel="noreferrer">微信原文 ↗</a></div></header><div class="reader-layout"><div class="reader-body">${renderMarkdown(doc.markdown, id)}</div><aside class="highlight-panel"><h3>划线</h3><p>用鼠标选中文本，旁边会出现确认按钮。</p>${highlights.length ? `<ol>${highlights.map((item) => `<li>${esc(item.text)}</li>`).join('')}</ol>` : '<span class="highlight-empty">还没有划线</span>'}</aside></div></article><div id="selection-popover" class="selection-popover" hidden><button class="selection-confirm" data-confirm-highlight aria-label="确认划线">✓</button><button class="selection-cancel" data-cancel-highlight aria-label="取消划线">×</button></div>`;
}
async function openArticle(article) {
  if (!article) return;
  content.innerHTML = `<section class="reader-loading">正在打开本地 Markdown…</section>`;
  try {
    const response = await fetch(`/api/articles/${encodeURIComponent(articleId(article))}`);
    const doc = await response.json();
    if (!response.ok) throw new Error(doc.error || '无法读取本地文章');
    state.reader = { article, doc };
    state.selectedText = '';
    renderReader();
  } catch (error) {
    content.innerHTML = `<button class="back" data-back>← 返回文章列表</button>${empty('本地文章尚不可读', `${error.message}。`)}`;
  }
}
function render() {
  if (state.reader) return renderReader();
  document.querySelectorAll('.tab').forEach((button) => button.classList.toggle('active', button.dataset.tab === state.tab));
  if (state.tab === 'today') renderTimeline(1, '最近一天', '过去 24 小时内的新文章');
  if (state.tab === 'favorites') renderFavorites();
  if (state.tab === 'week') renderTimeline(7, '最近 7 天', '过去一周内的新文章');
  if (state.tab === 'shelf') renderShelf();
}
async function loadData() {
  const [libraryResponse, favoritesResponse, managementResponse, highlightsResponse] = await Promise.all([fetch('/api/library'), fetch('/api/favorites'), fetch('/api/management'), fetch('/api/highlights')]);
  if (!libraryResponse.ok || !managementResponse.ok) throw new Error('本地书库暂不可用');
  state.library = await libraryResponse.json();
  state.management = await managementResponse.json();
  if (favoritesResponse.ok) { const saved = await favoritesResponse.json(); state.favorites = new Set(Array.isArray(saved.ids) ? saved.ids : []); }
  if (highlightsResponse.ok) { const saved = await highlightsResponse.json(); state.highlights = saved.byArticle || {}; }
  const count = allArticles().length;
  meta.textContent = `${state.library.sources.length} 个公众号 · ${count} 篇文章 · 最近同步 ${state.library.updatedAt ? new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(state.library.updatedAt)) : '尚未同步'}`;
  updateHeader();
}
async function refreshManagement({ reloadLibrary = false } = {}) {
  const response = await fetch('/api/management');
  if (!response.ok) return;
  const priorStatus = state.management.job?.status;
  state.management = await response.json();
  updateHeader();
  if (reloadLibrary && priorStatus === 'running' && ['success', 'partial'].includes(state.management.job?.status)) {
    await loadData(); render();
    const current = state.management.job;
    notify(current.status === 'partial' ? current.message : '同步完成，书架与本地正文已更新。', current.status === 'partial' ? 'error' : 'success');
  }
}
async function toggleFavorite(id) {
  if (state.favorites.has(id)) state.favorites.delete(id); else state.favorites.add(id);
  render();
  try {
    const response = await fetch('/api/favorites', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: [...state.favorites] }) });
    if (!response.ok) throw new Error('save failed');
  } catch { state.favorites.has(id) ? state.favorites.delete(id) : state.favorites.add(id); render(); notify('收藏暂时无法保存，请稍后重试。', 'error'); }
}
async function saveHighlight() {
  const text = state.selectedText.trim();
  const article = state.reader?.article;
  if (!text || !article) return;
  const articleIdValue = articleId(article);
  const response = await fetch('/api/highlights', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ articleId: articleIdValue, text }) });
  const payload = await response.json();
  if (!response.ok) return notify(payload.error || '划线保存失败', 'error');
  state.highlights[articleIdValue] = payload.highlights || [];
  const selection = window.getSelection();
  try {
    const range = state.selectionRange || (selection?.rangeCount ? selection.getRangeAt(0) : null);
    if (range) { const mark = document.createElement('mark'); mark.className = 'reader-highlight'; range.surroundContents(mark); }
  } catch { /* 跨段落选择仍会保存到右侧划线列表。 */ }
  selection?.removeAllRanges();
  state.selectedText = '';
  state.selectionRange = null;
  const popover = document.querySelector('#selection-popover');
  if (popover) popover.hidden = true;
  const panel = document.querySelector('.highlight-panel');
  if (panel) panel.innerHTML = `<h3>划线</h3><p>用鼠标选中文本，旁边会出现确认按钮。</p><ol>${state.highlights[articleIdValue].map((item) => `<li>${esc(item.text)}</li>`).join('')}</ol>`;
  notify('划线已保存到本机。', 'success');
}

document.querySelector('.tabs').addEventListener('click', (event) => {
  const tab = event.target.closest('[data-tab]');
  if (!tab) return;
  state.tab = tab.dataset.tab; state.sourceId = null; state.reader = null; render();
});
content.addEventListener('click', async (event) => {
  const source = event.target.closest('[data-source]');
  const read = event.target.closest('[data-read-article]');
  const favorite = event.target.closest('[data-favorite]');
  const remove = event.target.closest('[data-remove]');
  if (read) return openArticle(articleById(read.dataset.readArticle));
  if (source) { state.sourceId = source.dataset.source; return render(); }
  if (event.target.closest('[data-back]')) { state.reader = null; return render(); }
  if (favorite) return toggleFavorite(favorite.dataset.favorite);
  if (event.target.closest('[data-confirm-highlight]')) return saveHighlight();
  if (event.target.closest('[data-cancel-highlight]')) {
    window.getSelection()?.removeAllRanges(); state.selectedText = ''; state.selectionRange = null;
    const popover = document.querySelector('#selection-popover'); if (popover) popover.hidden = true;
    return;
  }
  if (event.target.closest('[data-open-subscribe]')) return subscribeDialog.showModal();
  if (remove) {
    const account = state.management.accounts.find((item) => item.bookId === remove.dataset.remove);
    if (!account) return;
    state.pendingRemoval = account;
    document.querySelector('#remove-title').textContent = `停止订阅「${account.name}」？`;
    document.querySelector('#remove-note').textContent = '停止后不会再拉取这个公众号。已下载的本地文章会默认保留。';
    document.querySelector('#remove-archive').checked = false;
    removeDialog.showModal();
  }
});
content.addEventListener('mouseup', () => {
  const selected = window.getSelection()?.toString().trim() || '';
  const popover = document.querySelector('#selection-popover');
  if (!state.reader || !selected) { if (popover) popover.hidden = true; return; }
  const selection = window.getSelection();
  if (!selection?.anchorNode || !content.querySelector('.reader-body')?.contains(selection.anchorNode)) return;
  state.selectedText = selected.slice(0, 800);
  state.selectionRange = selection.rangeCount ? selection.getRangeAt(0).cloneRange() : null;
  const rect = state.selectionRange?.getBoundingClientRect();
  if (popover && rect) {
    popover.style.left = `${Math.min(window.innerWidth - 94, Math.max(8, rect.right + 10))}px`;
    popover.style.top = `${Math.min(window.innerHeight - 44, Math.max(8, rect.top - 3))}px`;
    popover.hidden = false;
  }
});
async function startRefresh(confirmOverLimit = false) {
  const response = await fetch('/api/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirmOverLimit }) });
  const payload = await response.json();
  if (payload.requiresConfirmation) {
    document.querySelector('#over-limit-note').textContent = payload.error;
    overLimitDialog.showModal();
    return;
  }
  if (!response.ok) return notify(payload.error || '无法开始同步', 'error');
  state.management.job = payload.job; updateHeader(); notify('已开始同步。首次导入与图片归档可能需要几分钟。');
}
refreshButton.addEventListener('click', () => startRefresh());
document.querySelector('#settings-button').addEventListener('click', () => {
  const settings = state.management.settings || {};
  document.querySelector('#max-runs').value = settings.maxRunsPerDay ?? 2;
  document.querySelector('#request-interval').value = settings.requestIntervalMs ?? 3000;
  document.querySelector('#initial-limit').value = settings.initialArticleLimit ?? 50;
  settingsDialog.showModal();
});
document.querySelectorAll('.modal-close').forEach((button) => button.addEventListener('click', () => button.closest('dialog').close()));
document.querySelectorAll('[data-close-dialog]').forEach((button) => button.addEventListener('click', () => button.closest('dialog').close()));
document.querySelector('#remove-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const account = state.pendingRemoval;
  if (!account) return removeDialog.close();
  const deleteArchive = document.querySelector('#remove-archive').checked;
  const button = event.currentTarget.querySelector('.danger-button');
  button.disabled = true;
  try {
    const response = await fetch(`/api/subscriptions/${encodeURIComponent(account.bookId)}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ deleteArchive }) });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || '移除失败');
    state.pendingRemoval = null; removeDialog.close(); await loadData(); render(); notify(payload.note || `已停止订阅「${account.name}」`, 'success');
  } catch (error) { notify(error.message, 'error'); }
  finally { button.disabled = false; }
});
document.querySelector('#over-limit-form').addEventListener('submit', (event) => { event.preventDefault(); overLimitDialog.close(); startRefresh(true); });
document.querySelector('#subscribe-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = event.currentTarget.querySelector('.primary-button');
  const note = document.querySelector('#subscribe-note');
  button.disabled = true; note.textContent = '正在本地解析并加入书架…';
  try {
    const response = await fetch('/api/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: document.querySelector('#article-url').value }) });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || '订阅失败');
    await loadData(); render(); subscribeDialog.close(); event.currentTarget.reset(); notify(`已添加「${payload.name}」，下次刷新将导入文章。`, 'success');
  } catch (error) { note.textContent = error.message; }
  finally { button.disabled = false; }
});
document.querySelector('#settings-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const response = await fetch('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ maxRunsPerDay: Number(document.querySelector('#max-runs').value), requestIntervalMs: Number(document.querySelector('#request-interval').value), initialArticleLimit: Number(document.querySelector('#initial-limit').value) }) });
  const payload = await response.json();
  if (!response.ok) return notify(payload.error || '设置保存失败', 'error');
  state.management = payload.management; updateHeader(); settingsDialog.close(); notify('设置已保存到本机。', 'success');
});

try {
  await loadData();
  render();
  setInterval(() => refreshManagement({ reloadLibrary: true }), 2500);
} catch (error) {
  meta.textContent = '书库暂不可用';
  content.innerHTML = empty('还没有可读取的书库', error.message);
}
