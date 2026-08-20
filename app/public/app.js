const state = { library: { sources: [], updatedAt: null }, management: { accounts: [], groups: [], settings: {}, job: {} }, dashboards: { items: [], updatedAt: null }, appVersion: null, tab: 'today', sourceId: null, favorites: new Set(), highlights: {}, reader: null, pendingRemoval: null, selectedText: '', selectionRange: null, movingSources: new Set(), moveVersions: new Map(), announcedLibraryVersion: null, twitterVisibleCount: 30, twitterTagFilter: '低频' };
const TWITTER_PAGE_SIZE = 30;
const TWITTER_TAGS = ['低频', '高频'];
const TWITTER_TAG_WINDOWS = { 高频: 14, 低频: 60 };
const content = document.querySelector('#content');
const meta = document.querySelector('#library-meta');
const refreshButton = document.querySelector('#refresh-button');
const jobStatus = document.querySelector('#job-status');
const syncStatus = document.querySelector('#sync-status');
const jobProgress = document.querySelector('#job-progress');
const jobProgressFill = document.querySelector('#job-progress-fill');
const jobProgressLabel = document.querySelector('#job-progress-label');
const subscribeDialog = document.querySelector('#subscribe-dialog');
const youtubeDialog = document.querySelector('#youtube-dialog');
const twitterDialog = document.querySelector('#twitter-dialog');
const dashboardDialog = document.querySelector('#dashboard-dialog');
const settingsDialog = document.querySelector('#settings-dialog');
const removeDialog = document.querySelector('#remove-dialog');
const overLimitDialog = document.querySelector('#over-limit-dialog');
const toast = document.querySelector('#toast');
const backToTopButton = document.querySelector('#back-to-top');

const esc = (value) => String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);
const dt = (time, options = {}) => time ? new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false, ...options }).format(new Date(time * 1000)) : '尚未同步';
const fullDt = (time) => time ? new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(time)) : '尚未更新';
const dayKey = (time) => new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', weekday: 'short' }).format(new Date(time * 1000));
const fullDayKey = (time) => new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'short' }).format(new Date(time * 1000));
const publishedDesc = (a, b) => {
  const delta = (Number(b.t) || 0) - (Number(a.t) || 0);
  if (delta) return delta;
  return String(b.rid || b.url || '').localeCompare(String(a.rid || a.url || ''), 'en', { numeric: true });
};
const allArticles = () => state.library.sources.flatMap((source) => source.items.map((item) => ({ ...item, source: source.name, bookId: source.bookId, platform: source.platform || 'wechat' }))).sort(publishedDesc);
const allTwitterArticles = () => {
  const preferences = new Map((state.management.accounts || []).filter((account) => account.platform === 'twitter').map((account) => [account.bookId, account]));
  return allArticles().filter((article) => {
    if (article.platform !== 'twitter') return false;
    if (article.valueDecision !== 'keep') return false;
    const account = preferences.get(article.bookId);
    if (account?.mutedInFeed) return false;
    if ((account?.feedTag || '低频') !== state.twitterTagFilter) return false;
    const days = TWITTER_TAG_WINDOWS[state.twitterTagFilter] || 14;
    return article.t * 1000 >= cutoff(days);
  });
};
const allYoutubeArticles = () => allArticles().filter((article) => article.platform === 'youtube');
const cutoff = (days) => Date.now() - days * 24 * 60 * 60 * 1000;
const sourceById = (id) => state.library.sources.find((source) => source.bookId === id);
const articleId = (article) => article.rid || article.url;
const publicArticleUrl = (value) => String(value || '').replace(
  /^(https:\/\/mp\.weixin\.qq\.com\/s\/)([^/?#]+)(.*)$/i,
  (_, prefix, token, suffix) => `${prefix}${token.replaceAll('~', '_')}${suffix}`
);
const articleById = (id) => allArticles().find((article) => articleId(article) === id);
const accountById = (id) => state.management.accounts.find((account) => account.bookId === id);
const groupById = (id) => state.management.groups?.find((group) => group.id === id);
const groupForSource = (sourceId) => accountById(sourceId)?.groupId || 'group_value';
let toastTimer;
let twitterFeedObserver = null;

function notify(message, kind = 'normal') {
  toast.textContent = message;
  toast.className = `toast show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.className = 'toast'; }, 4200);
}
function jobLabel(job) {
  if (job.status === 'running') {
    if (job.kind === 'youtube_refresh') return job.phase === 'archiving' ? 'YouTube 字幕归档中…' : '正在检查 YouTube 更新…';
    if (job.kind === 'youtube_subscribe') return '正在解析 YouTube 频道…';
    if (job.kind === 'twitter_refresh') return job.phase === 'archiving' ? 'Twitter 推文归档中…' : '正在检查 Twitter 更新…';
    if (job.kind === 'twitter_subscribe') return '正在解析 Twitter 账号…';
    if (job.phase === 'archiving') return '新文章已显示 · 后台归档中…';
    return job.kind === 'refresh' ? '正在拉取文章索引…' : '正在解析订阅…';
  }
  if (job.status === 'failed') {
    if (/登录|扫码/.test(job.output || '')) return '需要登录微信读书';
    if (/Chrome|9222|WebSocket/.test(job.output || '')) return 'Chrome 连接失败';
    return '上次任务未完成';
  }
  if (job.status === 'success') return '同步完成';
  return '准备就绪';
}
function jobFailure(job) {
  const output = String(job?.output || '');
  if (/专用 Chrome 当前没有读到微信读书书架|请先在刚打开的专用 Chrome 窗口登录/.test(output)) {
    return '请在自动打开的专用 Chrome 窗口登录微信读书，然后再次点击“拉取更新”。';
  }
  if (/验证码|captcha/i.test(output)) return '微信读书需要验证，请在专用 Chrome 窗口完成验证后再次拉取。';
  if (/Chrome|9222|WebSocket/.test(output)) return '无法连接专用 Chrome，请关闭该窗口后再次点击“拉取更新”。';
  const lines = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return lines.slice(-2).join(' ') || job?.message || '同步未完成';
}
function updateJobProgress(job) {
  const visible = job?.status === 'running' && ['refresh', 'youtube_refresh', 'twitter_refresh'].includes(job?.kind);
  jobProgress.hidden = !visible;
  if (!visible) return;
  const progress = job.progress || {};
  const indeterminate = progress.total == null;
  jobProgress.classList.toggle('indeterminate', indeterminate);
  if (indeterminate) {
    jobProgressFill.style.width = '';
    jobProgressLabel.textContent = progress.stage === 'archiving' ? (job.kind === 'youtube_refresh' ? '准备字幕…' : job.kind === 'twitter_refresh' ? '准备推文…' : '准备归档…') : (job.kind === 'youtube_refresh' ? '频道索引处理中…' : job.kind === 'twitter_refresh' ? '账号索引处理中…' : '索引处理中…');
    jobProgress.removeAttribute('aria-valuenow');
    jobProgress.removeAttribute('aria-valuemax');
    jobProgress.setAttribute('aria-valuetext', jobProgressLabel.textContent);
    return;
  }
  const total = Math.max(0, Number(progress.total) || 0);
  const completed = Math.min(total, Math.max(0, Number(progress.completed) || 0));
  const percent = total === 0 ? 100 : Math.round((completed / total) * 100);
  jobProgressFill.style.width = `${percent}%`;
  jobProgressLabel.textContent = total === 0 ? '无需新增归档' : `${job.kind === 'youtube_refresh' ? '字幕' : job.kind === 'twitter_refresh' ? '推文' : '归档'} ${completed} / ${total}`;
  jobProgress.setAttribute('aria-valuenow', String(completed));
  jobProgress.setAttribute('aria-valuemax', String(total));
  jobProgress.setAttribute('aria-valuetext', jobProgressLabel.textContent);
}
function updateHeader() {
  const running = state.management.job?.status === 'running';
  const sync = state.management.sync || {};
  const maxRuns = sync.maxRunsPerDay ?? 2;
  const runsToday = sync.runsToday ?? 0;
  const reachedLimit = maxRuns > 0 && runsToday >= maxRuns;
  syncStatus.textContent = `上次更新：${fullDt(sync.lastSuccessAt)} · 今日拉取：${runsToday}/${maxRuns} 次`;
  jobStatus.textContent = jobLabel(state.management.job || {});
  jobStatus.title = state.management.job?.status === 'failed' ? jobFailure(state.management.job) : '';
  jobStatus.className = `job-status ${running ? 'working' : ''}`;
  updateJobProgress(state.management.job || {});
  refreshButton.disabled = running;
  refreshButton.title = reachedLimit ? `今日已拉取 ${runsToday}/${maxRuns} 次，点击后需要再次确认` : '';
  refreshButton.textContent = running ? '↻ 正在拉取…' : reachedLimit ? '↻ 仍要拉取' : '↻ 拉取更新';
}
function articleRow(article) {
  const id = articleId(article);
  const saved = state.favorites.has(id);
  const localReader = article.platform === 'youtube' ? `<button class="local-reader-button" data-local-article="${esc(id)}" aria-label="打开本地字幕：${esc(article.title)}">字幕</button>` : article.platform === 'twitter' ? `<button class="local-reader-button" data-local-article="${esc(id)}" aria-label="打开本地推文：${esc(article.title)}">正文</button>` : '';
  const permanentDelete = article.platform === 'twitter' ? `<button class="twitter-delete-button" data-delete-twitter="${esc(id)}" aria-label="彻底删除推文：${esc(article.title)}" title="从书库和本地归档中彻底删除">−</button>` : '';
  const openLabel = article.platform === 'youtube' ? '观看 YouTube 视频' : article.platform === 'twitter' ? '打开 X 原帖' : '打开微信原文';
  return `<div class="article-row"><a class="article-link" href="${esc(publicArticleUrl(article.url))}" target="_blank" rel="noopener noreferrer" aria-label="${openLabel}：${esc(article.title)}"><span class="article-source">${esc(article.source)}</span><span class="article-title">${esc(article.title)}</span><time>${dt(article.t)}</time></a>${localReader}<button class="favorite-button${saved ? ' saved' : ''}" data-favorite="${esc(id)}" aria-label="${saved ? '取消收藏' : '收藏文章'}" aria-pressed="${saved}">${saved ? '★' : '☆'}</button>${permanentDelete}</div>`;
}
function tweetTextMarkup(value) {
  return esc(value || '')
    .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>')
    .replace(/\r?\n/g, '<br>');
}
function tweetCard(article) {
  const id = articleId(article);
  const saved = state.favorites.has(id);
  const wordCount = Number(article.wordCount) || 0;
  const summarized = wordCount > 500 && article.displayTitle && article.abstract;
  const source = sourceById(article.bookId) || {};
  const profileUrl = source.profileUrl || `https://x.com/${source.screenName || ''}`;
  const chineseBody = article.translation || article.title || '这条推文尚未完成中文翻译。';
  const mainContent = summarized
    ? `<h4>${esc(article.displayTitle)}</h4><p class="tweet-abstract">${tweetTextMarkup(article.abstract)}</p><span class="tweet-long-label">长文 · ${wordCount} 词 · LLM 摘要</span>`
    : `<p class="tweet-translation">${tweetTextMarkup(chineseBody)}</p>`;
  return `<article class="tweet-card"><header><a href="${esc(profileUrl)}" target="_blank" rel="noopener noreferrer"><strong>${esc(article.source)}</strong><span>${source.screenName ? `@${esc(source.screenName)}` : ''}</span></a><time>${dt(article.t, { year: 'numeric', month: 'numeric', day: 'numeric' })}</time></header><div class="tweet-chinese">${mainContent}</div><details class="tweet-original"><summary>查看英文原文</summary><p>${tweetTextMarkup(article.text || article.title)}</p></details><footer><div class="tweet-stats"><span>${Number(article.replyCount) || 0} 回复</span><span>${Number(article.retweetCount) || 0} 转发</span><span>${Number(article.favoriteCount) || 0} 喜欢</span></div><div class="tweet-actions"><a href="${esc(article.url)}" target="_blank" rel="noopener noreferrer">X 原帖 ↗</a><button class="favorite-button${saved ? ' saved' : ''}" data-favorite="${esc(id)}" aria-label="${saved ? '取消收藏' : '收藏推文'}" aria-pressed="${saved}">${saved ? '★' : '☆'}</button><button class="twitter-delete-button" data-delete-twitter="${esc(id)}" aria-label="彻底删除推文" title="从书库和本地归档中彻底删除">−</button></div></footer></article>`;
}
function empty(title, note) { return `<section class="empty"><div class="empty-icon">☾</div><h2>${title}</h2><p>${note}</p></section>`; }

function renderTimeline(days, title, description) {
  const articles = allArticles().filter((article) =>
    article.platform === 'wechat' && article.t * 1000 >= cutoff(days)
  );
  if (!articles.length) {
    content.innerHTML = `<section class="view-heading"><p class="eyebrow">TIME VIEW</p><h2>${title}</h2><p>${description}</p></section>${empty('这段时间还没有更新', '点击右上角「拉取更新」后，新文章会出现在这里。')}`;
    return;
  }
  const daysMap = new Map();
  for (const article of articles) daysMap.set(dayKey(article.t), [...(daysMap.get(dayKey(article.t)) || []), article]);
  const renderDay = ([day, items]) => {
    const buckets = new Map();
    for (const article of items) {
      const groupId = groupForSource(article.bookId);
      buckets.set(groupId, [...(buckets.get(groupId) || []), article]);
    }
    const ordered = (state.management.groups || []).filter((group) => buckets.has(group.id)).map((group) => [group.id, group.name, buckets.get(group.id)]);
    return `<section class="day-group"><h3>${day}<span>${items.length}</span></h3>${ordered.map(([, name, entries]) => `<section class="timeline-subgroup"><h4>${esc(name)}<span>${entries.length}</span></h4>${entries.map(articleRow).join('')}</section>`).join('')}</section>`;
  };
  content.innerHTML = `<section class="view-heading"><p class="eyebrow">TIME VIEW</p><h2>${title}</h2><p>${description} · ${articles.length} 篇</p></section><div class="timeline">${[...daysMap.entries()].map(renderDay).join('')}</div>`;
}
function cover(source, index) {
  const colors = ['#ef6d54', '#6558d3', '#19917c', '#d9902b', '#b24b6e', '#2b799b'];
  const label = source.platform === 'twitter' ? '推特' : source.platform === 'youtube' ? 'YouTube' : '公众号';
  const unit = source.platform === 'youtube' ? '个视频' : source.platform === 'twitter' ? '条推文' : '篇文章';
  return `<div class="book-cover" style="--cover:${colors[index % colors.length]}"><span>${label}</span><strong>${esc(source.name)}</strong><i>${source.items.length} ${unit}</i></div>`;
}
function groupOptions(selectedId) {
  return (state.management.groups || []).map((group) => `<option value="${esc(group.id)}"${group.id === selectedId ? ' selected' : ''}>${esc(group.name)}</option>`).join('');
}
function bookCard(account, sourceMap, index, initialLimit) {
  const source = sourceMap.get(account.bookId) || { ...account, items: [] };
  const ready = source.items.length > 0;
  const moving = state.movingSources.has(account.bookId);
  const pendingLimit = account.platform === 'youtube' ? (account.initialVideoLimit || 5) : account.platform === 'twitter' ? (account.initialTweetLimit || 10) : initialLimit;
  const pendingUnit = account.platform === 'youtube' ? '个视频' : account.platform === 'twitter' ? '条推文' : '篇文章';
  const twitterControls = account.platform === 'twitter' ? `<div class="book-twitter-controls"><label><span>频率</span><select data-twitter-account-tag="${esc(account.bookId)}" aria-label="设置 ${esc(account.name)} 的 Twitter 频率"><option value="高频"${account.feedTag === '高频' ? ' selected' : ''}>高频 · 2 周</option><option value="低频"${account.feedTag !== '高频' ? ' selected' : ''}>低频 · 2 个月</option></select></label><button data-twitter-account-mute="${esc(account.bookId)}">${account.mutedInFeed ? '恢复信息流' : '屏蔽信息流'}</button></div>` : '';
  return `<div class="book-entry${ready ? '' : ' pending-initialization'}${moving ? ' moving' : ''}${account.mutedInFeed ? ' muted' : ''}" draggable="true" data-drag-source="${esc(account.bookId)}">${ready ? '' : '<span class="initialization-badge">未完成初始化</span>'}<button class="book" ${ready ? `data-source="${esc(account.bookId)}"` : 'disabled'}>${cover({ ...source, platform: account.platform }, index)}<span class="book-name">${esc(account.name)}</span><span class="book-update">${ready ? `更新至 ${dt(source.items[0]?.t || 0, { year: 'numeric', month: 'numeric', day: 'numeric' })}` : `首次同步将导入最近 ${pendingLimit} ${pendingUnit}`}</span></button><label class="book-group-select"><span>分组</span><select data-move-source="${esc(account.bookId)}" ${moving ? 'disabled' : ''}>${groupOptions(account.groupId)}</select></label>${twitterControls}<button class="book-remove" data-remove="${esc(account.bookId)}" aria-label="停止订阅 ${esc(account.name)}">×</button></div>`;
}
function renderShelf() {
  if (state.sourceId) return renderSource();
  const sourceMap = new Map(state.library.sources.map((source) => [source.bookId, source]));
  const accounts = [...state.management.accounts].sort((a, b) => (b.latestAt || 0) - (a.latestAt || 0));
  const initialLimit = state.management.settings?.initialArticleLimit || 50;
  const groups = state.management.groups || [];
  const sections = groups.map((group) => ({ id: group.id, name: group.name, accounts: accounts.filter((account) => account.groupId === group.id) }));
  const shelfDirectory = `<aside class="shelf-directory" aria-label="书架目录"><strong>书架目录</strong>${sections.map((section) => `<button data-shelf-jump="${esc(section.id)}"><span>${esc(section.name)}</span><i>${section.accounts.length}</i></button>`).join('')}</aside>`;
  let cardIndex = 0;
  content.innerHTML = `<section class="shelf-heading"><div><p class="eyebrow">LIBRARY</p><h2>全部书架</h2><p>公众号、Twitter 与 YouTube 的订阅都在这里管理。Twitter 的高低频和信息流屏蔽直接在对应书卡下调整。</p></div><div class="shelf-actions"><button class="secondary-button" data-twitter-refresh${state.management.accounts.some((account) => account.platform === 'twitter') ? '' : ' disabled'}>↻ 同步 Twitter</button><button class="secondary-button" data-youtube-refresh${state.management.accounts.some((account) => account.platform === 'youtube') ? '' : ' disabled'}>↻ 同步 YouTube</button></div></section><div class="shelf-layout">${shelfDirectory}<div class="grouped-shelf">${sections.map((section) => `<section class="shelf-group" id="shelf-${esc(section.id)}" data-shelf-section="${esc(section.id)}" data-group-drop="${esc(section.id)}"><header><h3>${esc(section.name)}</h3><span>${section.accounts.length} 本</span></header><div class="shelf">${section.accounts.length ? section.accounts.map((account) => bookCard(account, sourceMap, cardIndex++, initialLimit)).join('') : '<div class="empty-group">把来源拖到这里</div>'}</div></section>`).join('')}</div></div>`;
}
function dashboardCard(item) {
  let host = '';
  try { host = new URL(item.url).hostname.replace(/^www\./, ''); } catch { host = item.url; }
  return `<div class="dashboard-entry" style="--dashboard-accent:${esc(item.accent || '#6558d3')}"><a class="dashboard-card" href="${esc(item.url)}" target="_blank" rel="noopener noreferrer" aria-label="打开 Dashboard：${esc(item.title)}"><span class="dashboard-card-kicker">${esc(item.eyebrow || host)}</span><strong>${esc(item.title)}</strong><p>${esc(item.description || '点击进入网页查看最新数据。')}</p><span class="dashboard-card-footer"><i>${esc(host)}</i><b>打开 Dashboard ↗</b></span></a><button class="dashboard-remove" data-delete-dashboard="${esc(item.id)}" aria-label="移除 Dashboard：${esc(item.title)}" title="从超级大盘移除">×</button></div>`;
}
function renderDashboards() {
  const items = state.dashboards.items || [];
  const categories = new Map();
  for (const item of items) categories.set(item.category || '其他大盘', [...(categories.get(item.category || '其他大盘') || []), item]);
  const sections = [...categories.entries()].map(([category, entries]) => `<section class="dashboard-section"><header><h3>${esc(category)}</h3><span>${entries.length} 个栏目</span></header><div class="dashboard-grid">${entries.map(dashboardCard).join('')}<button class="dashboard-add-card" data-open-dashboard><span>＋</span><strong>关注新大盘</strong><small>保存一个研究网页</small></button></div></section>`).join('');
  content.innerHTML = `<section class="dashboard-heading"><div><p class="eyebrow">MARKET COMMAND CENTER</p><h2>超级大盘</h2><p>把常看的市场监控与研究网站收在一个入口。点击卡片会直接打开原始 Dashboard；这里仅保存链接，不抓取或改写对方数据。</p></div><button class="primary-button" data-open-dashboard>＋ 关注 Dashboard</button></section>${sections || `${empty('还没有关注 Dashboard', '添加一个研究网页，它会以书架卡片的形式出现在这里。')}<button class="dashboard-empty-add primary-button" data-open-dashboard>＋ 关注第一个 Dashboard</button>`}`;
}
function twitterFeedTags(accounts) {
  return TWITTER_TAGS;
}
function renderTwitterFeed() {
  const accounts = (state.management.accounts || []).filter((account) => account.platform === 'twitter');
  const tags = twitterFeedTags(accounts);
  if (!tags.includes(state.twitterTagFilter)) state.twitterTagFilter = '低频';
  const articles = allTwitterArticles();
  const awaitingReview = allArticles().filter((article) => article.platform === 'twitter' && article.valueDecision !== 'keep').length;
  const authLabel = state.management.sync?.twitterAuthenticated ? '专用 X 登录态已接入。' : '当前使用游客读取。';
  const controls = `<div class="shelf-actions"><button class="secondary-button" data-twitter-refresh${accounts.length ? '' : ' disabled'}>↻ 同步 Twitter</button></div>`;
  const tagFilters = `<nav class="twitter-tag-filters" aria-label="Twitter Leader 分类">${tags.map((tag) => `<button data-twitter-tag-filter="${esc(tag)}" class="${state.twitterTagFilter === tag ? 'active' : ''}">${esc(tag)} · 最近${tag === '高频' ? '2 周' : '2 个月'}</button>`).join('')}</nav>`;
  if (!articles.length) {
    content.innerHTML = `<section class="platform-feed-heading"><div><p class="eyebrow">TWITTER TIMELINE</p><h2>Twitter</h2><p>${authLabel}信息流只显示通过 AI 审核闸门的内容。${awaitingReview ? `现有 ${awaitingReview} 条旧数据等待重新审核。` : ''}</p></div>${controls}</section>${tagFilters}${empty('这个分类暂时没有审核通过的内容', '未审核或被判定为低价值的推文不会进入信息流。')}`;
    return;
  }
  const visibleCount = Math.min(articles.length, Math.max(TWITTER_PAGE_SIZE, state.twitterVisibleCount || TWITTER_PAGE_SIZE));
  const visibleArticles = articles.slice(0, visibleCount);
  const days = new Map();
  for (const article of visibleArticles) {
    const key = fullDayKey(article.t);
    days.set(key, [...(days.get(key) || []), article]);
  }
  const remaining = articles.length - visibleCount;
  content.innerHTML = `<section class="platform-feed-heading"><div><p class="eyebrow">TWITTER TIMELINE</p><h2>Twitter</h2><p>${authLabel}${esc(state.twitterTagFilter)} Leader · 最近 ${state.twitterTagFilter === '高频' ? '2 周' : '2 个月'} · ${articles.length} 条。分类内部仍按原始发布时间倒序；账号分类请在“全部书架”调整。</p></div>${controls}</section>${tagFilters}<div class="timeline twitter-timeline">${[...days.entries()].map(([day, items]) => `<section class="day-group"><h3>${esc(day)}<span>${items.length}</span></h3>${items.map(tweetCard).join('')}</section>`).join('')}</div><button class="twitter-feed-sentinel" data-load-more-twitter${remaining ? '' : ' disabled'}>${remaining ? `继续下滑加载更早推文 · 已显示 ${visibleCount}/${articles.length}` : `已显示全部 ${articles.length} 条推文`}</button>`;
  setupTwitterFeedObserver(articles.length);
}
function renderYoutubeFeed() {
  const accounts = (state.management.accounts || []).filter((account) => account.platform === 'youtube');
  const articles = allYoutubeArticles();
  const controls = `<div class="shelf-actions"><button class="secondary-button" data-youtube-refresh${accounts.length ? '' : ' disabled'}>↻ 同步 YouTube</button></div>`;
  const heading = `<section class="platform-feed-heading"><div><p class="eyebrow">YOUTUBE LIBRARY</p><h2>YouTube</h2><p>以文章目录方式阅读本地字幕。完成归档的视频会把中文译文放在前面、英文 Transcript 放在后面，并保留原视频跳转。</p></div>${controls}</section>`;
  if (!articles.length) {
    content.innerHTML = `${heading}${empty('还没有完成 YouTube 字幕归档', '频道已经订阅；点击“同步 YouTube”后会导入最新视频及可用字幕。')}`;
    return;
  }
  const days = new Map();
  for (const article of articles) {
    const key = fullDayKey(article.t);
    days.set(key, [...(days.get(key) || []), article]);
  }
  content.innerHTML = `${heading}<div class="timeline youtube-timeline">${[...days.entries()].map(([day, items]) => `<section class="day-group"><h3>${esc(day)}<span>${items.length}</span></h3>${items.map(articleRow).join('')}</section>`).join('')}</div>`;
}
function setupTwitterFeedObserver(total) {
  twitterFeedObserver?.disconnect();
  twitterFeedObserver = null;
  const sentinel = content.querySelector('[data-load-more-twitter]');
  if (!sentinel || state.twitterVisibleCount >= total || !('IntersectionObserver' in window)) return;
  twitterFeedObserver = new IntersectionObserver((entries) => {
    if (!entries.some((entry) => entry.isIntersecting) || state.tab !== 'twitter') return;
    twitterFeedObserver?.disconnect();
    state.twitterVisibleCount = Math.min(total, state.twitterVisibleCount + TWITTER_PAGE_SIZE);
    renderTwitterFeed();
  }, { rootMargin: '500px 0px' });
  twitterFeedObserver.observe(sentinel);
}
function renderSource() {
  const source = sourceById(state.sourceId);
  if (!source) { state.sourceId = null; return renderShelf(); }
  const youtube = source.platform === 'youtube';
  const twitter = source.platform === 'twitter';
  const visibleItems = twitter ? source.items.filter((item) => item.valueDecision === 'keep') : source.items;
  const articles = [...visibleItems].sort(publishedDesc).map((item) => ({ ...item, source: source.name, bookId: source.bookId, platform: source.platform || 'wechat' }));
  content.innerHTML = `<button class="back" data-back>← 返回书架</button><section class="source-header"><div class="source-cover">${esc(source.name).slice(0, 1)}</div><div><p class="eyebrow">${youtube ? 'YOUTUBE CHANNEL' : twitter ? 'TWITTER ACCOUNT' : 'PUBLIC ACCOUNT'}</p><h2>${esc(source.name)}</h2><p>完整目录 · ${articles.length} ${youtube ? '个视频' : twitter ? '条推文' : '篇文章'}</p></div></section><section class="catalog">${articles.map(articleRow).join('')}</section>`;
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
  const externalLabel = article.platform === 'youtube' ? 'YouTube 原视频' : article.platform === 'twitter' ? 'X 原帖' : '微信原文';
  content.innerHTML = `<button class="back" data-back>← 返回文章列表</button><button class="reader-floating-back" data-back aria-label="返回文章列表">← <span>文章列表</span></button><article class="reader"><header class="reader-header"><p class="eyebrow">${esc(article.source)}</p><h1>${esc(doc.title || article.title)}</h1><p class="reader-meta">${dt(article.t, { year: 'numeric', month: 'numeric', day: 'numeric' })} · 本地 Markdown</p><div class="reader-actions"><button id="reader-favorite" class="reader-action${saved ? ' saved' : ''}" data-favorite="${esc(id)}">${saved ? '★ 已收藏' : '☆ 收藏'}</button><a class="reader-action" href="${esc(publicArticleUrl(article.url))}" target="_blank" rel="noreferrer">${externalLabel} ↗</a></div></header><div class="reader-layout"><div class="reader-body">${renderMarkdown(doc.markdown, id)}</div><aside class="highlight-panel"><h3>划线</h3><p>用鼠标选中文本，旁边会出现确认按钮。</p>${highlights.length ? `<ol>${highlights.map((item) => `<li>${esc(item.text)}</li>`).join('')}</ol>` : '<span class="highlight-empty">还没有划线</span>'}</aside></div></article><div id="selection-popover" class="selection-popover" hidden><button class="selection-confirm" data-confirm-highlight aria-label="确认划线">✓</button><button class="selection-cancel" data-cancel-highlight aria-label="取消划线">×</button></div>`;
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
  if (state.tab !== 'twitter') { twitterFeedObserver?.disconnect(); twitterFeedObserver = null; }
  document.querySelectorAll('.tab').forEach((button) => button.classList.toggle('active', button.dataset.tab === state.tab));
  if (state.tab === 'today') renderTimeline(1, '最近一天', '过去 24 小时内的新文章');
  if (state.tab === 'favorites') renderFavorites();
  if (state.tab === 'week') renderTimeline(7, '最近 7 天', '过去一周内的新文章');
  if (state.tab === 'shelf') renderShelf();
  if (state.tab === 'twitter') renderTwitterFeed();
  if (state.tab === 'youtube') renderYoutubeFeed();
  if (state.tab === 'dashboards') renderDashboards();
}
function routeUrl(tab = state.tab, sourceId = state.sourceId) {
  return sourceId ? `#shelf/${encodeURIComponent(sourceId)}` : `#${tab}`;
}
function routeFromLocation() {
  const match = location.hash.match(/^#shelf\/(.+)$/);
  if (match) return { tab: 'shelf', sourceId: decodeURIComponent(match[1]) };
  const tab = location.hash.slice(1);
  return { tab: ['today', 'favorites', 'week', 'shelf', 'twitter', 'youtube', 'dashboards'].includes(tab) ? tab : 'today', sourceId: null };
}
function navigate(tab, sourceId = null, { replace = false } = {}) {
  if (tab === 'twitter' && state.tab !== 'twitter') state.twitterVisibleCount = TWITTER_PAGE_SIZE;
  state.tab = tab;
  state.sourceId = sourceId;
  state.reader = null;
  const currentDepth = Number(history.state?.weReadDepth) || 0;
  const historyState = { weRead: true, weReadDepth: replace ? currentDepth : currentDepth + 1, tab, sourceId };
  history[replace ? 'replaceState' : 'pushState'](historyState, '', routeUrl(tab, sourceId));
  render();
}
async function loadData() {
  const [libraryResponse, favoritesResponse, managementResponse, highlightsResponse, dashboardsResponse] = await Promise.all([fetch('/api/library'), fetch('/api/favorites'), fetch('/api/management'), fetch('/api/highlights'), fetch('/api/dashboards')]);
  if (!libraryResponse.ok || !managementResponse.ok) throw new Error('本地书库暂不可用');
  state.library = await libraryResponse.json();
  state.management = await managementResponse.json();
  state.appVersion = state.management.appVersion || state.appVersion;
  if (favoritesResponse.ok) { const saved = await favoritesResponse.json(); state.favorites = new Set(Array.isArray(saved.ids) ? saved.ids : []); }
  if (highlightsResponse.ok) { const saved = await highlightsResponse.json(); state.highlights = saved.byArticle || {}; }
  if (dashboardsResponse.ok) state.dashboards = await dashboardsResponse.json();
  updateLibraryMeta();
  updateHeader();
}
function updateLibraryMeta() {
  const count = allArticles().length;
  meta.textContent = `${state.library.sources.length} 个来源 · ${count} 条内容 · 最近同步 ${state.library.updatedAt ? new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(state.library.updatedAt)) : '尚未同步'}`;
}
async function refreshManagement({ reloadLibrary = false } = {}) {
  const response = await fetch('/api/management');
  if (!response.ok) return;
  const priorStatus = state.management.job?.status;
  const nextManagement = await response.json();
  if (state.appVersion && nextManagement.appVersion && state.appVersion !== nextManagement.appVersion) return location.reload();
  state.management = nextManagement;
  state.appVersion = nextManagement.appVersion || state.appVersion;
  updateHeader();
  if (reloadLibrary && state.management.job?.status === 'running') {
    const libraryResponse = await fetch('/api/library');
    if (libraryResponse.ok) {
      const library = await libraryResponse.json();
      if (library.updatedAt && library.updatedAt !== state.library.updatedAt) {
        state.library = library;
        updateLibraryMeta();
        render();
        if (state.announcedLibraryVersion !== library.updatedAt) {
          state.announcedLibraryVersion = library.updatedAt;
          notify('新文章已经显示，Markdown 与图片正在后台继续下载。', 'success');
        }
      }
    }
  }
  if (reloadLibrary && priorStatus === 'running' && state.management.job?.status === 'success') { await loadData(); render(); notify('同步完成，书架已更新。', 'success'); }
  if (priorStatus === 'running' && state.management.job?.status === 'failed') notify(jobFailure(state.management.job), 'error');
}
async function moveSource(sourceId, groupId) {
  const account = accountById(sourceId);
  if (!account || account.groupId === groupId || state.movingSources.has(sourceId)) return;
  const previous = account.groupId || 'group_value';
  const version = (state.moveVersions.get(sourceId) || 0) + 1;
  state.moveVersions.set(sourceId, version);
  state.movingSources.add(sourceId);
  account.groupId = groupId;
  render();
  try {
    const response = await fetch(`/api/source-group-assignments/${encodeURIComponent(sourceId)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ groupId }) });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || '移动失败');
    if (state.moveVersions.get(sourceId) === version) notify(`已将「${account.name}」移到「${groupById(groupId)?.name || '分组'}」。`, 'success');
  } catch (error) {
    if (state.moveVersions.get(sourceId) === version) {
      account.groupId = previous;
      notify(error.message, 'error');
    }
  } finally {
    if (state.moveVersions.get(sourceId) === version) state.movingSources.delete(sourceId);
    render();
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
async function deleteTwitterItem(id) {
  const article = articleById(id);
  if (!article || !window.confirm('确认彻底删除这条推文？本地 Markdown、收藏和划线都会删除，之后同步也不会重新导入。')) return;
  const response = await fetch(`/api/twitter/items/${encodeURIComponent(id)}`, { method: 'DELETE' });
  const payload = await response.json();
  if (!response.ok) return notify(payload.error || '推文删除失败', 'error');
  state.favorites.delete(id);
  delete state.highlights[id];
  await loadData();
  render();
  notify(payload.note || '推文已彻底删除。', 'success');
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
  navigate(tab.dataset.tab);
});
document.querySelector('.brand').addEventListener('click', (event) => { event.preventDefault(); navigate('today'); });
content.addEventListener('click', async (event) => {
  const source = event.target.closest('[data-source]');
  const favorite = event.target.closest('[data-favorite]');
  const localArticle = event.target.closest('[data-local-article]');
  const deleteTwitter = event.target.closest('[data-delete-twitter]');
  const deleteDashboard = event.target.closest('[data-delete-dashboard]');
  const twitterTagFilter = event.target.closest('[data-twitter-tag-filter]');
  const twitterAccountMute = event.target.closest('[data-twitter-account-mute]');
  const shelfJump = event.target.closest('[data-shelf-jump]');
  const remove = event.target.closest('[data-remove]');
  if (twitterTagFilter) {
    state.twitterTagFilter = twitterTagFilter.dataset.twitterTagFilter || '低频';
    state.twitterVisibleCount = TWITTER_PAGE_SIZE;
    return renderTwitterFeed();
  }
  if (twitterAccountMute) {
    const account = accountById(twitterAccountMute.dataset.twitterAccountMute);
    if (!account) return;
    return updateTwitterPreferences(account.bookId, { mutedInFeed: !account.mutedInFeed });
  }
  if (shelfJump) {
    const target = content.querySelector(`[data-shelf-section="${CSS.escape(shelfJump.dataset.shelfJump)}"]`);
    target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }
  if (source) return navigate('shelf', source.dataset.source);
  if (event.target.closest('[data-back]')) {
    if (state.reader) { state.reader = null; return render(); }
    if (state.sourceId && Number(history.state?.weReadDepth) > 0) return history.back();
    if (state.sourceId) return navigate('shelf', null, { replace: true });
  }
  if (localArticle) return openArticle(articleById(localArticle.dataset.localArticle));
  if (deleteTwitter) return deleteTwitterItem(deleteTwitter.dataset.deleteTwitter);
  if (deleteDashboard) {
    const item = (state.dashboards.items || []).find((entry) => entry.id === deleteDashboard.dataset.deleteDashboard);
    if (!item || !window.confirm(`从超级大盘移除「${item.title}」？\n这只会删除本机保存的链接，不影响原网站。`)) return;
    const response = await fetch(`/api/dashboards/${encodeURIComponent(item.id)}`, { method: 'DELETE' });
    const payload = await response.json();
    if (!response.ok) return notify(payload.error || '移除失败', 'error');
    state.dashboards = { items: payload.items || [], updatedAt: payload.updatedAt || null };
    render();
    return notify(`已移除「${item.title}」。`, 'success');
  }
  if (event.target.closest('[data-load-more-twitter]')) {
    state.twitterVisibleCount += TWITTER_PAGE_SIZE;
    return renderTwitterFeed();
  }
  if (favorite) return toggleFavorite(favorite.dataset.favorite);
  if (event.target.closest('[data-confirm-highlight]')) return saveHighlight();
  if (event.target.closest('[data-cancel-highlight]')) {
    window.getSelection()?.removeAllRanges(); state.selectedText = ''; state.selectionRange = null;
    const popover = document.querySelector('#selection-popover'); if (popover) popover.hidden = true;
    return;
  }
  if (event.target.closest('[data-open-subscribe]')) return subscribeDialog.showModal();
  if (event.target.closest('[data-open-youtube]')) return youtubeDialog.showModal();
  if (event.target.closest('[data-open-twitter]')) return twitterDialog.showModal();
  if (event.target.closest('[data-open-dashboard]')) return dashboardDialog.showModal();
  if (event.target.closest('[data-youtube-refresh]')) return startYoutubeRefresh();
  if (event.target.closest('[data-twitter-refresh]')) return startTwitterRefresh();
  if (remove) {
    const account = state.management.accounts.find((item) => item.bookId === remove.dataset.remove);
    if (!account) return;
    state.pendingRemoval = account;
    document.querySelector('#remove-title').textContent = `停止订阅「${account.name}」？`;
    document.querySelector('#remove-note').textContent = account.platform === 'youtube' ? '停止后不会再同步这个 YouTube 频道。已保存的字幕 Markdown 会默认保留。' : account.platform === 'twitter' ? '停止后不会再同步这个 Twitter 账号。已保存的推文 Markdown 会默认保留。' : '停止后不会再拉取这个公众号。已下载的本地文章会默认保留。';
    document.querySelector('#remove-archive-label').textContent = account.platform === 'youtube' ? '同时删除该频道已保存的字幕 Markdown' : account.platform === 'twitter' ? '同时删除该账号已保存的推文 Markdown' : '同时删除该公众号已下载的本地 Markdown 和图片';
    document.querySelector('#remove-archive').checked = false;
    removeDialog.showModal();
  }
});
content.addEventListener('change', (event) => {
  const twitterTag = event.target.closest('[data-twitter-account-tag]');
  if (twitterTag) return updateTwitterPreferences(twitterTag.dataset.twitterAccountTag, { feedTag: twitterTag.value });
  const select = event.target.closest('[data-move-source]');
  if (select) moveSource(select.dataset.moveSource, select.value || null);
});
content.addEventListener('dragstart', (event) => {
  const card = event.target.closest('[data-drag-source]');
  if (!card || state.movingSources.has(card.dataset.dragSource)) return event.preventDefault();
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('text/plain', card.dataset.dragSource);
  requestAnimationFrame(() => card.classList.add('dragging'));
});
content.addEventListener('dragover', (event) => {
  const group = event.target.closest('[data-group-drop]');
  if (!group) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'move';
  content.querySelectorAll('.shelf-group.drag-over').forEach((item) => item.classList.remove('drag-over'));
  group.classList.add('drag-over');
});
content.addEventListener('drop', (event) => {
  const group = event.target.closest('[data-group-drop]');
  if (!group) return;
  event.preventDefault();
  const sourceId = event.dataTransfer.getData('text/plain');
  content.querySelectorAll('.shelf-group.drag-over').forEach((item) => item.classList.remove('drag-over'));
  if (sourceId) moveSource(sourceId, group.dataset.groupDrop || null);
});
content.addEventListener('dragend', () => {
  content.querySelectorAll('.dragging,.drag-over').forEach((item) => item.classList.remove('dragging', 'drag-over'));
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
async function startYoutubeRefresh() {
  const response = await fetch('/api/youtube/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  const payload = await response.json();
  if (!response.ok) return notify(payload.error || '无法开始 YouTube 同步', 'error');
  state.management.job = payload.job;
  updateHeader();
  render();
  notify('已开始检查 YouTube 更新；字幕请求会按安全间隔执行。');
}
async function startTwitterRefresh() {
  const response = await fetch('/api/twitter/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  const payload = await response.json();
  if (!response.ok) return notify(payload.error || '无法开始 Twitter 同步', 'error');
  state.management.job = payload.job;
  updateHeader();
  render();
  notify('已开始低频检查 Twitter 公开更新。');
}
async function updateTwitterPreferences(sourceId, changes) {
  const response = await fetch(`/api/twitter/accounts/${encodeURIComponent(sourceId)}/preferences`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(changes),
  });
  const payload = await response.json();
  if (!response.ok) return notify(payload.error || 'Twitter 分类保存失败', 'error');
  state.management = payload.management;
  state.twitterVisibleCount = TWITTER_PAGE_SIZE;
  render();
  notify('Twitter Leader 分类已保存到本机。', 'success');
}
async function autoRefreshTwitterOnOpen() {
  try {
    const response = await fetch('/api/twitter/auto-refresh', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const payload = await response.json();
    if (response.status === 202 && payload.started) {
      state.management.job = payload.job;
      updateHeader();
      render();
      notify('已自动检查 Twitter 更新；新推文会翻译并保存到本地。');
    }
  } catch { /* 打开页面时的自动检查不阻塞书库使用。 */ }
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
document.querySelector('#youtube-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = event.currentTarget.querySelector('.primary-button');
  const note = document.querySelector('#youtube-note');
  button.disabled = true;
  note.textContent = '正在解析频道身份…';
  try {
    const response = await fetch('/api/youtube/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: document.querySelector('#youtube-url').value, initialLimit: Number(document.querySelector('#youtube-initial-limit').value) }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || 'YouTube 订阅失败');
    await loadData();
    render();
    youtubeDialog.close();
    event.currentTarget.reset();
    document.querySelector('#youtube-initial-limit').value = 5;
    notify(`已添加「${payload.channel.name}」，点击“同步 YouTube”导入视频与字幕。`, 'success');
  } catch (error) { note.textContent = error.message; }
  finally { button.disabled = false; }
});
document.querySelector('#twitter-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = event.currentTarget.querySelector('.primary-button');
  const note = document.querySelector('#twitter-note');
  button.disabled = true;
  note.textContent = '正在读取公开账号资料…';
  try {
    const response = await fetch('/api/twitter/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ account: document.querySelector('#twitter-account').value, initialLimit: Number(document.querySelector('#twitter-initial-limit').value) }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || 'Twitter 订阅失败');
    await loadData();
    render();
    twitterDialog.close();
    event.currentTarget.reset();
    document.querySelector('#twitter-initial-limit').value = 10;
    notify(`已添加「${payload.account.name}」，点击“同步 Twitter”导入公开推文。`, 'success');
  } catch (error) { note.textContent = error.message; }
  finally { button.disabled = false; }
});
document.querySelector('#dashboard-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = event.currentTarget.querySelector('.primary-button');
  const note = document.querySelector('#dashboard-note');
  button.disabled = true;
  note.textContent = '正在保存到本机…';
  try {
    const response = await fetch('/api/dashboards', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: document.querySelector('#dashboard-title').value,
        url: document.querySelector('#dashboard-url').value,
        category: document.querySelector('#dashboard-category').value,
        description: document.querySelector('#dashboard-description').value,
      }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || 'Dashboard 保存失败');
    state.dashboards = { items: payload.items || [], updatedAt: payload.updatedAt || null };
    dashboardDialog.close();
    event.currentTarget.reset();
    document.querySelector('#dashboard-category').value = '全球市场';
    render();
    notify(`已关注「${payload.dashboard.title}」。`, 'success');
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

const updateBackToTop = () => { backToTopButton.hidden = window.scrollY < 480; };
window.addEventListener('scroll', updateBackToTop, { passive: true });
backToTopButton.addEventListener('click', () => {
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  window.scrollTo({ top: 0, behavior: reduceMotion ? 'auto' : 'smooth' });
});
updateBackToTop();

let foregroundReloading = false;
let lastForegroundReloadAt = Date.now();
async function reloadOnForeground() {
  if (document.hidden || foregroundReloading || Date.now() - lastForegroundReloadAt < 5000) return;
  foregroundReloading = true;
  try {
    await loadData();
    render();
    lastForegroundReloadAt = Date.now();
  } catch { /* 保留当前可读页面，下次回到标签页时再试。 */ }
  finally { foregroundReloading = false; }
}
window.addEventListener('focus', reloadOnForeground);
document.addEventListener('visibilitychange', reloadOnForeground);

try {
  await loadData();
  const initialRoute = routeFromLocation();
  navigate(initialRoute.tab, initialRoute.sourceId, { replace: true });
  autoRefreshTwitterOnOpen();
  window.addEventListener('popstate', (event) => {
    const route = event.state?.weRead ? event.state : routeFromLocation();
    state.tab = route.tab || 'today';
    state.sourceId = route.sourceId || null;
    state.reader = null;
    render();
  });
  setInterval(() => refreshManagement({ reloadLibrary: true }), 2500);
} catch (error) {
  meta.textContent = '书库暂不可用';
  content.innerHTML = empty('还没有可读取的书库', error.message);
}
