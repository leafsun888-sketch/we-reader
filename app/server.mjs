import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { latestArchiveProgress } from './lib/progress.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.resolve(ROOT, '..');
const PUBLIC = path.join(ROOT, 'public');
const DATA = path.join(PROJECT, 'data');
const FETCHER = path.join(PROJECT, 'fetcher');
const YOUTUBE = path.join(PROJECT, 'youtube');
const TWITTER = path.join(PROJECT, 'twitter');
const LIBRARY = path.join(DATA, '数据', 'library.json');
const FAVORITES = path.join(DATA, '数据', 'favorites.json');
const ANNOTATIONS = path.join(DATA, '数据', 'annotations.json');
const ARCHIVE_STATUS = path.join(DATA, '数据', 'archive-status.json');
const SOURCE_GROUPS = path.join(DATA, '数据', 'source-groups.json');
const YOUTUBE_SUBSCRIPTIONS = path.join(DATA, '数据', 'youtube-subscriptions.json');
const YOUTUBE_STATUS = path.join(DATA, '数据', 'youtube-status.json');
const YOUTUBE_PYTHON = path.join(YOUTUBE, '.venv', 'bin', 'python');
const YOUTUBE_SYNC = path.join(YOUTUBE, 'sync.py');
const TWITTER_SUBSCRIPTIONS = path.join(DATA, '数据', 'twitter-subscriptions.json');
const TWITTER_STATUS = path.join(DATA, '数据', 'twitter-status.json');
const TWITTER_COOKIES = path.join(DATA, '数据', 'twitter-cookies.json');
const DASHBOARDS = path.join(DATA, '数据', 'dashboards.json');
const TWITTER_PYTHON = path.join(TWITTER, '.venv', 'bin', 'python');
const TWITTER_SYNC = path.join(TWITTER, 'sync.py');
const CONFIG = path.join(FETCHER, 'config.json');
const QUOTA = path.join(FETCHER, 'data', 'quota.json');
const LATEST = path.join(FETCHER, 'data', 'latest.json');
const RECOMMENDED_DAILY_LIMIT = 2;
const DEFAULT_SOURCE_GROUP_ID = 'group_value';
const FIXED_SOURCE_GROUPS = Object.freeze([
  { id: 'group_macro', name: '宏观', order: 0 },
  { id: DEFAULT_SOURCE_GROUP_ID, name: '价值', order: 1 },
  { id: 'group_growth', name: '成长', order: 2 },
  { id: 'group_youtube', name: 'Youtube', order: 3 },
  { id: 'group_twitter', name: 'Twitter', order: 4 },
]);
const port = Number(process.env.PORT || 8041);
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };
const APP_VERSION = (await fs.stat(path.join(PUBLIC, 'app.js'))).mtimeMs.toString(36);
const DEFAULT_DASHBOARDS = Object.freeze({
  updatedAt: null,
  items: [{
    id: 'DASH_KIM_PREMIUM',
    title: '韩国散户杠杆',
    url: 'https://kimpremium.com/',
    category: '韩国市场',
    eyebrow: 'KR RETAIL LEVERAGE',
    description: '监控杠杆温度、强平爆仓、融资率与投资者存管金，观察韩国市场去杠杆进度。',
    accent: '#a84732',
  }],
});

let job = { status: 'idle', kind: null, phase: null, message: '准备就绪', startedAt: null, finishedAt: null, output: '' };
let groupWriteQueue = Promise.resolve();
let dashboardWriteQueue = Promise.resolve();
let twitterScheduleTimer = null;
let twitterNextScheduledAt = null;

const send = (res, status, body, type = 'text/plain; charset=utf-8') => {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
};
const sendJson = (res, status, data) => send(res, status, JSON.stringify(data), MIME['.json']);
const readJson = async (file, fallback) => {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return fallback; }
};
const writeJson = async (file, value) => {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  try {
    await fs.writeFile(temp, JSON.stringify(value, null, 2) + '\n', 'utf8');
    await fs.rename(temp, file);
  } finally {
    await fs.rm(temp, { force: true }).catch(() => {});
  }
};
const dashboardUrl = (value) => {
  const raw = String(value || '').trim().replace(/[。；;，,]+$/, '');
  let parsed;
  try { parsed = new URL(raw); } catch { throw new Error('请输入完整的 Dashboard 网页地址'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('Dashboard 只支持普通 http/https 网页地址');
  return parsed.href;
};
const normalizeDashboardItem = (item) => {
  if (!item || typeof item.id !== 'string' || !/^DASH_[A-Za-z0-9_-]+$/.test(item.id)) return null;
  const title = String(item.title || '').trim().slice(0, 80);
  if (!title) return null;
  let url;
  try { url = dashboardUrl(item.url); } catch { return null; }
  const category = String(item.category || '其他大盘').trim().slice(0, 40) || '其他大盘';
  const eyebrow = String(item.eyebrow || new URL(url).hostname).trim().slice(0, 60);
  const description = String(item.description || '').trim().slice(0, 240);
  const accent = /^#[0-9a-f]{6}$/i.test(String(item.accent || '')) ? item.accent : '#6558d3';
  return { id: item.id, title, url, category, eyebrow, description, accent, ...(item.addedAt ? { addedAt: item.addedAt } : {}) };
};
const normalizedDashboards = (value = DEFAULT_DASHBOARDS) => {
  const ids = new Set();
  const urls = new Set();
  const items = [];
  for (const raw of Array.isArray(value.items) ? value.items.slice(0, 200) : []) {
    const item = normalizeDashboardItem(raw);
    if (!item || ids.has(item.id) || urls.has(item.url)) continue;
    ids.add(item.id); urls.add(item.url); items.push(item);
  }
  return { items, updatedAt: value.updatedAt || null };
};
const readDashboards = async () => normalizedDashboards(await readJson(DASHBOARDS, DEFAULT_DASHBOARDS));
const mutateDashboards = (mutator) => {
  const operation = dashboardWriteQueue.then(async () => {
    const current = await readDashboards();
    const result = await mutator(current);
    current.updatedAt = new Date().toISOString();
    await writeJson(DASHBOARDS, normalizedDashboards(current));
    return { data: current, result };
  });
  dashboardWriteQueue = operation.catch(() => {});
  return operation;
};
const normalizedGroups = (value = {}) => {
  const groups = FIXED_SOURCE_GROUPS.map((group) => ({ ...group }));
  const validIds = new Set(groups.map((group) => group.id));
  const idByName = new Map(groups.map((group) => [group.name.toLocaleLowerCase('zh-CN'), group.id]));
  const legacyIdMap = new Map((Array.isArray(value.groups) ? value.groups : [])
    .filter((group) => group && typeof group.id === 'string' && typeof group.name === 'string')
    .map((group) => [group.id, idByName.get(group.name.trim().toLocaleLowerCase('zh-CN'))])
    .filter(([, groupId]) => groupId));
  const assignments = Object.fromEntries(Object.entries(value.assignments || {}).flatMap(([sourceId, groupId]) => {
    if (typeof sourceId !== 'string') return [];
    const normalizedId = validIds.has(groupId) ? groupId : legacyIdMap.get(groupId);
    return normalizedId ? [[sourceId, normalizedId]] : [];
  }));
  return { groups, assignments, updatedAt: value.updatedAt || null };
};
const mutateGroups = (mutator) => {
  const operation = groupWriteQueue.then(async () => {
    const current = normalizedGroups(await readJson(SOURCE_GROUPS, { groups: [], assignments: {} }));
    const result = await mutator(current);
    current.updatedAt = new Date().toISOString();
    await writeJson(SOURCE_GROUPS, current);
    return { data: current, result };
  });
  groupWriteQueue = operation.catch(() => {});
  return operation;
};
const ensureFixedSourceGroups = async () => {
  const [config, youtubeConfig, twitterConfig, stored] = await Promise.all([
    readJson(CONFIG, { accounts: [] }),
    readJson(YOUTUBE_SUBSCRIPTIONS, { channels: [] }),
    readJson(TWITTER_SUBSCRIPTIONS, { accounts: [] }),
    readJson(SOURCE_GROUPS, { groups: [], assignments: {} }),
  ]);
  const current = normalizedGroups(stored);
  for (const account of config.accounts || []) {
    if (typeof account.bookId === 'string' && !current.assignments[account.bookId]) current.assignments[account.bookId] = DEFAULT_SOURCE_GROUP_ID;
  }
  for (const channel of youtubeConfig.channels || []) {
    if (typeof channel.sourceId === 'string' && !current.assignments[channel.sourceId]) current.assignments[channel.sourceId] = 'group_youtube';
  }
  for (const account of twitterConfig.accounts || []) {
    if (typeof account.sourceId === 'string' && !current.assignments[account.sourceId]) current.assignments[account.sourceId] = 'group_twitter';
  }
  const persisted = { groups: current.groups, assignments: current.assignments, updatedAt: stored.updatedAt || null };
  const needsWrite = JSON.stringify(stored.groups || []) !== JSON.stringify(persisted.groups)
    || JSON.stringify(stored.assignments || {}) !== JSON.stringify(persisted.assignments);
  if (needsWrite) {
    persisted.updatedAt = new Date().toISOString();
    await writeJson(SOURCE_GROUPS, persisted);
  }
};
const readJsonBody = (req) => new Promise((resolve, reject) => {
  let body = '';
  req.on('data', (chunk) => {
    body += chunk;
    if (body.length > 64 * 1024) reject(new Error('请求内容过大'));
  });
  req.on('end', () => {
    try { resolve(JSON.parse(body || '{}')); } catch { reject(new Error('JSON 格式无效')); }
  });
  req.on('error', reject);
});
const localDay = () => {
  const date = new Date();
  const part = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${part(date.getMonth() + 1)}-${part(date.getDate())}`;
};
const archiveFor = async (articleId) => {
  const statusFile = articleId.startsWith('YT_VIDEO_') ? YOUTUBE_STATUS : articleId.startsWith('TW_TWEET_') ? TWITTER_STATUS : ARCHIVE_STATUS;
  const status = await readJson(statusFile, { archived: {} });
  return { status, entry: status.archived?.[articleId] || null };
};
const archiveMarkdownPath = (entry) => {
  if (!entry?.markdown) return null;
  const file = path.resolve(DATA, entry.markdown);
  const articleRoot = path.join(DATA, '文章') + path.sep;
  return file.startsWith(articleRoot) ? file : null;
};

function runFetcher(kind, args) {
  if (job.status === 'running') throw new Error('已有任务正在执行，请等待完成');
  job = { status: 'running', kind, phase: kind === 'refresh' ? 'fetching' : 'subscribing', message: kind === 'refresh' ? '正在连接微信读书并拉取文章索引…' : '正在解析文章链接并加入书架…', startedAt: new Date().toISOString(), finishedAt: null, output: '', progress: kind === 'refresh' ? { stage: 'indexing', completed: 0, total: null, archived: 0, failed: 0 } : null };
  const child = spawn(process.execPath, [path.join(FETCHER, 'bin', 'weread.mjs'), ...args], { cwd: FETCHER, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  const append = (chunk) => {
    output = (output + chunk.toString()).slice(-12000);
    job.output = output;
    if (kind === 'refresh' && output.includes('Second Brain 书库已更新。')) {
      job.phase = 'archiving';
      job.message = '文章列表已更新，正在后台下载 Markdown 与图片…';
      job.progress = latestArchiveProgress(output) || { stage: 'archiving', completed: 0, total: null, archived: 0, failed: 0 };
    }
    const archiveProgress = latestArchiveProgress(output);
    if (archiveProgress) job.progress = archiveProgress;
  };
  child.stdout.on('data', append);
  child.stderr.on('data', append);
  const done = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => {
      job = {
        ...job,
        status: code === 0 ? 'success' : 'failed',
        phase: code === 0 ? 'complete' : 'failed',
        message: code === 0 ? (kind === 'refresh' ? '同步完成，书库已更新。' : '公众号已加入书架。') : '任务未完成，请查看提示。',
        finishedAt: new Date().toISOString(),
        output,
        progress: code === 0 && kind === 'refresh' ? { ...(job.progress || {}), stage: 'complete' } : job.progress,
      };
      resolve({ code, output });
    });
  });
  return done;
}

const latestYoutubeProgress = (output) => {
  const lines = String(output || '').split(/\r?\n/).reverse();
  for (const line of lines) {
    if (!line.startsWith('WE_READ_YOUTUBE_PROGRESS ')) continue;
    try { return { stage: 'archiving', ...JSON.parse(line.slice('WE_READ_YOUTUBE_PROGRESS '.length)) }; }
    catch { return null; }
  }
  return null;
};

function runYoutube(kind, args) {
  if (job.status === 'running') throw new Error('已有任务正在执行，请等待完成');
  const refreshing = kind === 'youtube_refresh';
  job = {
    status: 'running', kind, phase: refreshing ? 'discovering' : 'subscribing',
    message: refreshing ? '正在检查 YouTube 频道更新…' : '正在解析 YouTube 频道…',
    startedAt: new Date().toISOString(), finishedAt: null, output: '',
    progress: refreshing ? { stage: 'indexing', completed: 0, total: null, archived: 0, failed: 0 } : null,
  };
  const child = spawn(YOUTUBE_PYTHON, [YOUTUBE_SYNC, ...args], { cwd: YOUTUBE, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '', output = '';
  const append = (chunk, target) => {
    const text = chunk.toString();
    if (target === 'stdout') stdout += text; else stderr += text;
    output = (output + text).slice(-16000);
    job.output = output;
    const progress = latestYoutubeProgress(output);
    if (progress) {
      job.phase = 'archiving';
      job.message = 'YouTube 视频已进入书库，正在保存字幕 Markdown…';
      job.progress = progress;
    }
  };
  child.stdout.on('data', (chunk) => append(chunk, 'stdout'));
  child.stderr.on('data', (chunk) => append(chunk, 'stderr'));
  return new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => {
      job = {
        ...job,
        status: code === 0 ? 'success' : 'failed',
        phase: code === 0 ? 'complete' : 'failed',
        message: code === 0 ? (refreshing ? 'YouTube 同步完成。' : 'YouTube 频道已加入。') : 'YouTube 任务未完成。',
        finishedAt: new Date().toISOString(), output,
        progress: code === 0 && refreshing ? { ...(job.progress || {}), stage: 'complete' } : job.progress,
      };
      resolve({ code, output, stdout, stderr });
    });
  });
}

const latestTwitterProgress = (output) => {
  const lines = String(output || '').split(/\r?\n/).reverse();
  for (const line of lines) {
    if (!line.startsWith('WE_READ_TWITTER_PROGRESS ')) continue;
    try { return { stage: 'archiving', ...JSON.parse(line.slice('WE_READ_TWITTER_PROGRESS '.length)) }; }
    catch { return null; }
  }
  return null;
};

function runTwitter(kind, args) {
  if (job.status === 'running') throw new Error('已有任务正在执行，请等待完成');
  const refreshing = kind === 'twitter_refresh';
  job = {
    status: 'running', kind, phase: refreshing ? 'discovering' : 'subscribing',
    message: refreshing ? '正在检查 Twitter 更新…' : '正在解析 Twitter 账号…',
    startedAt: new Date().toISOString(), finishedAt: null, output: '',
    progress: refreshing ? { stage: 'indexing', completed: 0, total: null, archived: 0, failed: 0 } : null,
  };
  const child = spawn(TWITTER_PYTHON, [TWITTER_SYNC, ...args], { cwd: TWITTER, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '', output = '';
  const append = (chunk, target) => {
    const text = chunk.toString();
    if (target === 'stdout') stdout += text; else stderr += text;
    output = (output + text).slice(-16000);
    job.output = output;
    const progress = latestTwitterProgress(output);
    if (progress) {
      job.phase = 'archiving';
      job.message = 'Twitter 推文已进入书库，正在保存本地 Markdown…';
      job.progress = progress;
    }
  };
  child.stdout.on('data', (chunk) => append(chunk, 'stdout'));
  child.stderr.on('data', (chunk) => append(chunk, 'stderr'));
  return new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => {
      job = {
        ...job,
        status: code === 0 ? 'success' : 'failed', phase: code === 0 ? 'complete' : 'failed',
        message: code === 0 ? (refreshing ? 'Twitter 同步完成。' : 'Twitter 账号已加入。') : 'Twitter 任务未完成。',
        finishedAt: new Date().toISOString(), output,
        progress: code === 0 && refreshing ? { ...(job.progress || {}), stage: 'complete' } : job.progress,
      };
      resolve({ code, output, stdout, stderr });
    });
  });
}

async function startTwitterBackgroundRefresh(reason = 'manual') {
  if (job.status === 'running') return { started: false, reason: 'busy', job };
  const twitterConfig = await readJson(TWITTER_SUBSCRIPTIONS, { accounts: [], settings: {} });
  if (!(twitterConfig.accounts || []).some((account) => account.enabled !== false)) return { started: false, reason: 'no-accounts', job };
  const delay = Math.min(Math.max(Number(twitterConfig.settings?.requestIntervalSeconds) || 5, 2), 60);
  runTwitter('twitter_refresh', ['sync', '--max-new', '600', '--delay', String(delay)]).catch((error) => {
    job = { ...job, status: 'failed', phase: 'failed', message: error.message, finishedAt: new Date().toISOString() };
  });
  job.reason = reason;
  return { started: true, reason, job };
}

function nextTwitterSchedule(now = new Date()) {
  for (const hour of [12, 20]) {
    const candidate = new Date(now);
    candidate.setHours(hour, 0, 0, 0);
    if (candidate.getTime() > now.getTime() + 1000) return candidate;
  }
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(12, 0, 0, 0);
  return tomorrow;
}

function scheduleTwitterRefresh() {
  if (twitterScheduleTimer) clearTimeout(twitterScheduleTimer);
  const next = nextTwitterSchedule();
  twitterNextScheduledAt = next.toISOString();
  twitterScheduleTimer = setTimeout(async function runScheduledTwitterRefresh() {
    if (job.status === 'running') {
      twitterScheduleTimer = setTimeout(runScheduledTwitterRefresh, 10 * 60 * 1000);
      return;
    }
    await startTwitterBackgroundRefresh('schedule');
    scheduleTwitterRefresh();
  }, Math.max(1000, next.getTime() - Date.now()));
}

async function management() {
  const [config, youtubeConfig, twitterConfig, library, quota, latest, groupSettings, twitterAuthenticated] = await Promise.all([
    readJson(CONFIG, { accounts: [] }),
    readJson(YOUTUBE_SUBSCRIPTIONS, { channels: [] }),
    readJson(TWITTER_SUBSCRIPTIONS, { accounts: [] }),
    readJson(LIBRARY, { sources: [] }),
    readJson(QUOTA, {}),
    readJson(LATEST, {}),
    readJson(SOURCE_GROUPS, { groups: [], assignments: {} }),
    fs.access(TWITTER_COOKIES).then(() => true).catch(() => false),
  ]);
  const sourceGroups = normalizedGroups(groupSettings);
  const sourceById = new Map((library.sources || []).map((source) => [source.bookId, source]));
  const maxRunsPerDay = Math.min(Math.max(Number(config.maxRunsPerDay) || RECOMMENDED_DAILY_LIMIT, 1), RECOMMENDED_DAILY_LIMIT);
  const runsToday = quota.date === localDay() ? Math.max(0, Number(quota.count) || 0) : 0;
  const wechatAccounts = (config.accounts || []).map((account) => ({ ...account, platform: account.platform || 'wechat' }));
  const youtubeAccounts = (youtubeConfig.channels || []).filter((channel) => channel.enabled !== false).map((channel) => ({
    name: channel.name, bookId: channel.sourceId, platform: 'youtube', channelId: channel.channelId, url: channel.url, initialVideoLimit: channel.initialVideoLimit || 5,
  }));
  const twitterAccounts = (twitterConfig.accounts || []).filter((account) => account.enabled !== false).map((account) => ({
    name: account.name, bookId: account.sourceId, platform: 'twitter', userId: account.userId, screenName: account.screenName, url: account.url, initialTweetLimit: account.initialTweetLimit || 10,
    mutedInFeed: account.mutedInFeed === true, feedTag: ['高频', '低频'].includes(account.feedTag) ? account.feedTag : '低频',
  }));
  return {
    appVersion: APP_VERSION,
    accounts: [...wechatAccounts, ...youtubeAccounts, ...twitterAccounts].map((account) => {
      const source = sourceById.get(account.bookId);
      const defaultGroup = account.platform === 'youtube' ? 'group_youtube' : account.platform === 'twitter' ? 'group_twitter' : DEFAULT_SOURCE_GROUP_ID;
      return { ...account, platform: account.platform || source?.platform || 'wechat', groupId: sourceGroups.assignments[account.bookId] || defaultGroup, articleCount: source?.items?.length || 0, latestAt: source?.items?.[0]?.t || null };
    }),
    groups: sourceGroups.groups,
    settings: {
      maxRunsPerDay,
      requestIntervalMs: config.requestIntervalMs ?? 3000,
      initialArticleLimit: config.initialArticleLimit ?? 50,
    },
    sync: {
      lastSuccessAt: latest.fetchedAt || library.updatedAt || null,
      runsToday,
      maxRunsPerDay,
      remainingRuns: Math.max(0, maxRunsPerDay - runsToday),
      youtubeLastSuccessAt: (youtubeConfig.channels || []).map((channel) => channel.lastSyncedAt).filter(Boolean).sort().at(-1) || null,
      twitterLastSuccessAt: (twitterConfig.accounts || []).map((account) => account.lastSyncedAt).filter(Boolean).sort().at(-1) || null,
      twitterNextScheduledAt,
      twitterScheduleLocalTimes: ['12:00', '20:00'],
      twitterAuthenticated,
    },
    job,
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname === '/api/library' && req.method === 'GET') return sendJson(res, 200, await readJson(LIBRARY, { updatedAt: null, sources: [] }));
    if (url.pathname === '/api/management' && req.method === 'GET') return sendJson(res, 200, await management());
    if (url.pathname === '/api/job' && req.method === 'GET') return sendJson(res, 200, job);

    if (url.pathname === '/api/dashboards') {
      if (req.method === 'GET') return sendJson(res, 200, await readDashboards());
      if (req.method === 'POST') {
        const payload = await readJsonBody(req);
        const title = String(payload.title || '').trim();
        const category = String(payload.category || '').trim() || '其他大盘';
        const description = String(payload.description || '').trim();
        if (!title || title.length > 80 || category.length > 40 || description.length > 240) throw new Error('请检查名称、分类和简介长度');
        const target = dashboardUrl(payload.url);
        const palette = ['#a84732', '#6558d3', '#187c6b', '#c47d24', '#8f4566', '#2c7895'];
        const { data, result } = await mutateDashboards((current) => {
          if (current.items.some((item) => item.url === target)) throw new Error('这个 Dashboard 已经关注');
          const item = normalizeDashboardItem({
            id: `DASH_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
            title,
            url: target,
            category,
            eyebrow: new URL(target).hostname.replace(/^www\./, '').toUpperCase(),
            description,
            accent: palette[current.items.length % palette.length],
            addedAt: new Date().toISOString(),
          });
          current.items.push(item);
          return item;
        });
        return sendJson(res, 201, { ok: true, dashboard: result, ...data });
      }
      return send(res, 405, 'Method not allowed');
    }

    const dashboardRequest = url.pathname.match(/^\/api\/dashboards\/(DASH_[A-Za-z0-9_-]+)$/);
    if (dashboardRequest && req.method === 'DELETE') {
      const dashboardId = dashboardRequest[1];
      const { data, result } = await mutateDashboards((current) => {
        const item = current.items.find((entry) => entry.id === dashboardId);
        if (!item) throw new Error('找不到这个 Dashboard');
        current.items = current.items.filter((entry) => entry.id !== dashboardId);
        return item;
      });
      return sendJson(res, 200, { ok: true, dashboard: result, ...data });
    }

    if (url.pathname === '/api/source-groups') {
      if (req.method === 'GET') return sendJson(res, 200, normalizedGroups(await readJson(SOURCE_GROUPS, { groups: [], assignments: {} })));
      return send(res, 405, 'Method not allowed');
    }

    const groupAssignment = url.pathname.match(/^\/api\/source-group-assignments\/(.+)$/);
    if (groupAssignment && req.method === 'PUT') {
      const sourceId = decodeURIComponent(groupAssignment[1]);
      const payload = await readJsonBody(req);
      const groupId = String(payload.groupId || '');
      if (!groupId) return sendJson(res, 400, { error: '请选择宏观、价值、成长、Youtube 或 Twitter' });
      const currentManagement = await management();
      if (!(currentManagement.accounts || []).some((account) => account.bookId === sourceId)) return sendJson(res, 404, { error: '找不到该订阅源' });
      const { data } = await mutateGroups((current) => {
        if (!current.groups.some((group) => group.id === groupId)) throw new Error('目标分组不存在');
        current.assignments[sourceId] = groupId;
      });
      return sendJson(res, 200, { ok: true, sourceId, groupId, groups: data.groups, assignments: data.assignments });
    }

    const assetRequest = url.pathname.match(/^\/api\/articles\/([^/]+)\/assets\/(.+)$/);
    if (assetRequest && req.method === 'GET') {
      const articleId = decodeURIComponent(assetRequest[1]);
      const assetName = decodeURIComponent(assetRequest[2]);
      if (!articleId.startsWith('MP_WXS_') || assetName.includes('..') || path.isAbsolute(assetName)) return send(res, 400, '无效资源路径');
      const { entry } = await archiveFor(articleId);
      const markdown = archiveMarkdownPath(entry);
      if (!markdown) return send(res, 404, '本地文章不存在');
      const asset = path.resolve(path.dirname(markdown), 'assets', assetName);
      const assetRoot = path.join(path.dirname(markdown), 'assets') + path.sep;
      if (!asset.startsWith(assetRoot)) return send(res, 403, 'Forbidden');
      try { return send(res, 200, await fs.readFile(asset), MIME[path.extname(asset).toLowerCase()] || 'application/octet-stream'); }
      catch { return send(res, 404, '资源不存在'); }
    }

    const articleRequest = url.pathname.match(/^\/api\/articles\/([^/]+)$/);
    if (articleRequest && req.method === 'GET') {
      const articleId = decodeURIComponent(articleRequest[1]);
      if (!articleId.startsWith('MP_WXS_') && !articleId.startsWith('YT_VIDEO_') && !articleId.startsWith('TW_TWEET_')) return sendJson(res, 400, { error: '内容标识无效' });
      const { entry } = await archiveFor(articleId);
      const markdown = archiveMarkdownPath(entry);
      if (!markdown) return sendJson(res, 404, { error: '这篇文章尚未完成本地归档' });
      try {
        return sendJson(res, 200, {
          id: articleId,
          title: entry.title,
          account: entry.account,
          source: entry.url,
          markdown: await fs.readFile(markdown, 'utf8'),
        });
      } catch { return sendJson(res, 404, { error: '本地 Markdown 文件不存在' }); }
    }

    if (url.pathname === '/api/favorites') {
      if (req.method === 'GET') return sendJson(res, 200, await readJson(FAVORITES, { ids: [] }));
      if (req.method === 'POST') {
        const payload = await readJsonBody(req);
        if (!Array.isArray(payload.ids) || payload.ids.length > 5000 || payload.ids.some((id) => typeof id !== 'string' || id.length > 600)) throw new Error('收藏数据格式无效');
        await writeJson(FAVORITES, { ids: [...new Set(payload.ids)], updatedAt: new Date().toISOString() });
        return sendJson(res, 200, { ok: true });
      }
      return send(res, 405, 'Method not allowed');
    }

    if (url.pathname === '/api/highlights') {
      if (req.method === 'GET') return sendJson(res, 200, await readJson(ANNOTATIONS, { byArticle: {} }));
      if (req.method === 'POST') {
        const payload = await readJsonBody(req);
        const articleId = String(payload.articleId || '');
        const text = String(payload.text || '').trim().replace(/\s+/g, ' ');
        if ((!articleId.startsWith('MP_WXS_') && !articleId.startsWith('YT_VIDEO_') && !articleId.startsWith('TW_TWEET_')) || !text || text.length > 800) throw new Error('划线内容无效');
        const annotations = await readJson(ANNOTATIONS, { byArticle: {} });
        const existing = annotations.byArticle?.[articleId] || [];
        if (!existing.some((item) => item.text === text)) existing.push({ id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, text, createdAt: new Date().toISOString() });
        annotations.byArticle = { ...(annotations.byArticle || {}), [articleId]: existing };
        await writeJson(ANNOTATIONS, annotations);
        return sendJson(res, 200, { ok: true, highlights: existing });
      }
      return send(res, 405, 'Method not allowed');
    }

    if (url.pathname === '/api/refresh' && req.method === 'POST') {
      if (job.status === 'running') return sendJson(res, 409, { error: '已有任务正在执行', job });
      const payload = await readJsonBody(req);
      const current = await management();
      const overLimit = current.sync.remainingRuns <= 0;
      if (overLimit && payload.confirmOverLimit !== true) return sendJson(res, 409, { requiresConfirmation: true, error: `今日已拉取 ${current.sync.runsToday}/${current.sync.maxRunsPerDay} 次。额外拉取更容易触发微信读书验证，是否继续？`, management: current });
      runFetcher('refresh', overLimit ? ['--force'] : []).catch((error) => { job = { ...job, status: 'failed', message: error.message, finishedAt: new Date().toISOString() }; });
      return sendJson(res, 202, { ok: true, job });
    }

    if (url.pathname === '/api/subscribe' && req.method === 'POST') {
      const payload = await readJsonBody(req);
      const articleUrl = String(payload.url || '').trim().replace(/[。；;，,]+$/, '');
      if (!/^https:\/\/mp\.weixin\.qq\.com\/s\//.test(articleUrl)) return sendJson(res, 400, { error: '请输入一篇 mp.weixin.qq.com/s/ 开头的公众号文章链接。' });
      const result = await runFetcher('subscribe', ['--add', articleUrl]);
      const match = result.output.match(/解析成功:(MP_WXS_\d+)(?: \(([^)]+)\))?/);
      if (result.code !== 0 || !match || !/已加入书架/.test(result.output)) return sendJson(res, 422, { error: '未能完成订阅', detail: result.output.slice(-1200), job });
      const [, bookId, parsedName] = match;
      const config = await readJson(CONFIG, { accounts: [] });
      if (!(config.accounts || []).some((account) => account.bookId === bookId)) {
        config.accounts = [...(config.accounts || []), { name: parsedName || bookId, bookId }];
        await writeJson(CONFIG, config);
      }
      await mutateGroups((current) => { current.assignments[bookId] ||= DEFAULT_SOURCE_GROUP_ID; });
      return sendJson(res, 200, { ok: true, name: parsedName || bookId, bookId, management: await management() });
    }

    if (url.pathname === '/api/youtube/subscribe' && req.method === 'POST') {
      if (job.status === 'running') return sendJson(res, 409, { error: '已有任务正在执行', job });
      const payload = await readJsonBody(req);
      const channelUrl = String(payload.url || '').trim();
      if (!/^https?:\/\/(?:www\.|m\.)?youtube\.com\//i.test(channelUrl)) return sendJson(res, 400, { error: '请输入 YouTube 频道主页或 /videos 链接。' });
      const initialLimit = Math.min(Math.max(Number(payload.initialLimit) || 5, 1), 15);
      const result = await runYoutube('youtube_subscribe', ['subscribe', channelUrl, '--initial-limit', String(initialLimit)]);
      let channel;
      try { channel = JSON.parse(result.stdout); } catch { channel = null; }
      if (result.code !== 0 || !channel?.sourceId) return sendJson(res, 422, { error: '未能解析 YouTube 频道', detail: (result.stderr || result.output).slice(-1200), job });
      await mutateGroups((current) => { current.assignments[channel.sourceId] ||= 'group_youtube'; });
      return sendJson(res, 200, { ok: true, channel, management: await management() });
    }

    if (url.pathname === '/api/youtube/refresh' && req.method === 'POST') {
      if (job.status === 'running') return sendJson(res, 409, { error: '已有任务正在执行', job });
      const youtubeConfig = await readJson(YOUTUBE_SUBSCRIPTIONS, { channels: [], settings: {} });
      if (!(youtubeConfig.channels || []).some((channel) => channel.enabled !== false)) return sendJson(res, 400, { error: '请先添加一个 YouTube 频道。' });
      const delay = Math.min(Math.max(Number(youtubeConfig.settings?.requestIntervalSeconds) || 60, 10), 300);
      runYoutube('youtube_refresh', ['sync', '--max-new', '10', '--delay', String(delay)]).catch((error) => {
        job = { ...job, status: 'failed', phase: 'failed', message: error.message, finishedAt: new Date().toISOString() };
      });
      return sendJson(res, 202, { ok: true, job });
    }

    if (url.pathname === '/api/twitter/subscribe' && req.method === 'POST') {
      if (job.status === 'running') return sendJson(res, 409, { error: '已有任务正在执行', job });
      const payload = await readJsonBody(req);
      const accountValue = String(payload.account || '').trim();
      if (!/^@?[A-Za-z0-9_]{1,15}$/.test(accountValue) && !/^https?:\/\/(?:www\.)?(?:x|twitter)\.com\/[A-Za-z0-9_]{1,15}\/?$/i.test(accountValue)) return sendJson(res, 400, { error: '请输入 @用户名或 x.com 用户主页链接。' });
      const initialLimit = Math.min(Math.max(Number(payload.initialLimit) || 10, 1), 20);
      const result = await runTwitter('twitter_subscribe', ['subscribe', accountValue, '--initial-limit', String(initialLimit)]);
      let account;
      try { account = JSON.parse(result.stdout); } catch { account = null; }
      if (result.code !== 0 || !account?.sourceId) return sendJson(res, 422, { error: '未能解析 Twitter 账号', detail: (result.stderr || result.output).slice(-1200), job });
      await mutateGroups((current) => { current.assignments[account.sourceId] ||= 'group_twitter'; });
      return sendJson(res, 200, { ok: true, account, management: await management() });
    }

    if (url.pathname === '/api/twitter/refresh' && req.method === 'POST') {
      const result = await startTwitterBackgroundRefresh('manual');
      if (!result.started) return sendJson(res, result.reason === 'busy' ? 409 : 400, { error: result.reason === 'busy' ? '已有任务正在执行' : '请先添加一个 Twitter 账号。', job });
      return sendJson(res, 202, { ok: true, job });
    }

    if (url.pathname === '/api/twitter/auto-refresh' && req.method === 'POST') {
      const twitterConfig = await readJson(TWITTER_SUBSCRIPTIONS, { accounts: [], settings: {} });
      const accounts = (twitterConfig.accounts || []).filter((account) => account.enabled !== false);
      if (!accounts.length) return sendJson(res, 200, { ok: true, started: false, reason: 'no-accounts', job });
      if (job.status === 'running') return sendJson(res, 200, { ok: true, started: false, reason: 'busy', job });
      const lastSyncedAt = accounts.map((account) => Date.parse(account.lastSyncedAt || '')).filter(Number.isFinite).sort((a, b) => b - a)[0] || 0;
      const cooldownMinutes = Math.min(Math.max(Number(twitterConfig.settings?.openRefreshCooldownMinutes) || 30, 10), 180);
      if (Date.now() - lastSyncedAt < cooldownMinutes * 60 * 1000) return sendJson(res, 200, { ok: true, started: false, reason: 'fresh', job });
      const result = await startTwitterBackgroundRefresh('open');
      return sendJson(res, result.started ? 202 : 200, { ok: true, ...result });
    }

    const twitterPreferences = url.pathname.match(/^\/api\/twitter\/accounts\/(TW_USER_\d+)\/preferences$/);
    if (twitterPreferences && req.method === 'PUT') {
      if (job.status === 'running') return sendJson(res, 409, { error: '同步任务进行中，请完成后再调整 Twitter 分类' });
      const sourceId = twitterPreferences[1];
      const payload = await readJsonBody(req);
      const twitterConfig = await readJson(TWITTER_SUBSCRIPTIONS, { accounts: [], settings: {} });
      const account = (twitterConfig.accounts || []).find((entry) => entry.sourceId === sourceId);
      if (!account) return sendJson(res, 404, { error: '找不到该 Twitter 账号' });
      if (Object.hasOwn(payload, 'mutedInFeed')) account.mutedInFeed = payload.mutedInFeed === true;
      if (Object.hasOwn(payload, 'feedTag')) {
        const feedTag = String(payload.feedTag || '').trim().replace(/\s+/g, ' ');
        if (!['高频', '低频'].includes(feedTag)) return sendJson(res, 400, { error: 'Twitter 标签只能选择高频或低频' });
        account.feedTag = feedTag;
      }
      twitterConfig.updatedAt = new Date().toISOString();
      await writeJson(TWITTER_SUBSCRIPTIONS, twitterConfig);
      return sendJson(res, 200, { ok: true, account: { sourceId, mutedInFeed: account.mutedInFeed === true, feedTag: ['高频', '低频'].includes(account.feedTag) ? account.feedTag : '低频' }, management: await management() });
    }

    const twitterItem = url.pathname.match(/^\/api\/twitter\/items\/(TW_TWEET_\d+)$/);
    if (twitterItem && req.method === 'DELETE') {
      if (job.status === 'running') return sendJson(res, 409, { error: '同步任务进行中，请完成后再删除推文' });
      const articleId = twitterItem[1];
      const [library, twitterStatus, favorites, annotations] = await Promise.all([
        readJson(LIBRARY, { sources: [] }),
        readJson(TWITTER_STATUS, { archived: {}, failures: {}, deleted: {} }),
        readJson(FAVORITES, { ids: [] }),
        readJson(ANNOTATIONS, { byArticle: {} }),
      ]);
      const source = (library.sources || []).find((entry) => entry.platform === 'twitter' && (entry.items || []).some((item) => item.rid === articleId));
      const item = source?.items?.find((entry) => entry.rid === articleId);
      if (!source || !item) return sendJson(res, 404, { error: '找不到这条推文' });
      source.items = source.items.filter((entry) => entry.rid !== articleId);
      library.updatedAt = new Date().toISOString();
      const markdown = archiveMarkdownPath(twitterStatus.archived?.[articleId]);
      if (markdown) await fs.rm(path.dirname(markdown), { recursive: true, force: true });
      delete twitterStatus.archived?.[articleId];
      delete twitterStatus.failures?.[articleId];
      twitterStatus.deleted = { ...(twitterStatus.deleted || {}), [articleId]: {
        sourceId: source.bookId, title: item.title, url: item.url, deletedAt: new Date().toISOString(),
      } };
      twitterStatus.updatedAt = new Date().toISOString();
      favorites.ids = (favorites.ids || []).filter((id) => id !== articleId);
      favorites.updatedAt = new Date().toISOString();
      if (annotations.byArticle) delete annotations.byArticle[articleId];
      annotations.updatedAt = new Date().toISOString();
      await Promise.all([
        writeJson(LIBRARY, library), writeJson(TWITTER_STATUS, twitterStatus),
        writeJson(FAVORITES, favorites), writeJson(ANNOTATIONS, annotations),
      ]);
      return sendJson(res, 200, { ok: true, id: articleId, note: '已从书库和本地归档中彻底删除；后续同步不会重新导入。' });
    }

    if (url.pathname === '/api/settings' && req.method === 'PUT') {
      const payload = await readJsonBody(req);
      const config = await readJson(CONFIG, { accounts: [] });
      const maxRunsPerDay = Number(payload.maxRunsPerDay);
      const requestIntervalMs = Number(payload.requestIntervalMs);
      const initialArticleLimit = Number(payload.initialArticleLimit);
      if (!Number.isInteger(maxRunsPerDay) || maxRunsPerDay < 1 || maxRunsPerDay > RECOMMENDED_DAILY_LIMIT) throw new Error('每日抓取上限应在 1 到 2 次之间，以降低触发验证的概率');
      if (!Number.isInteger(requestIntervalMs) || requestIntervalMs < 1500 || requestIntervalMs > 20000) throw new Error('请求间隔应在 1500 到 20000 毫秒之间');
      if (!Number.isInteger(initialArticleLimit) || initialArticleLimit < 1 || initialArticleLimit > 100) throw new Error('首次文章数量应在 1 到 100 篇之间');
      Object.assign(config, { maxRunsPerDay, requestIntervalMs, initialArticleLimit });
      await writeJson(CONFIG, config);
      return sendJson(res, 200, { ok: true, management: await management() });
    }

    const subscription = url.pathname.match(/^\/api\/subscriptions\/(MP_WXS_\d+|YT_CHANNEL_UC[A-Za-z0-9_-]+|TW_USER_\d+)$/);
    if (subscription && req.method === 'DELETE') {
      if (job.status === 'running') return sendJson(res, 409, { error: '拉取或订阅任务进行中，请完成后再删除公众号' });
      const bookId = subscription[1];
      const payload = await readJsonBody(req);
      const deleteArchive = payload.deleteArchive === true;
      if (bookId.startsWith('YT_CHANNEL_')) {
        const [youtubeConfig, library, youtubeStatus, favorites] = await Promise.all([
          readJson(YOUTUBE_SUBSCRIPTIONS, { channels: [] }),
          readJson(LIBRARY, { sources: [] }),
          readJson(YOUTUBE_STATUS, { archived: {}, failures: {} }),
          readJson(FAVORITES, { ids: [] }),
        ]);
        const channel = (youtubeConfig.channels || []).find((entry) => entry.sourceId === bookId);
        if (!channel) return sendJson(res, 404, { error: '找不到该 YouTube 订阅' });
        youtubeConfig.channels = youtubeConfig.channels.filter((entry) => entry.sourceId !== bookId);
        youtubeConfig.updatedAt = new Date().toISOString();
        library.sources = (library.sources || []).filter((source) => source.bookId !== bookId);
        library.updatedAt = new Date().toISOString();
        const articleIds = [...new Set([
          ...Object.entries(youtubeStatus.archived || {}).filter(([, entry]) => entry.sourceId === bookId).map(([id]) => id),
          ...Object.entries(youtubeStatus.failures || {}).filter(([, entry]) => entry.sourceId === bookId).map(([id]) => id),
        ])];
        let removedArchives = 0;
        if (deleteArchive) {
          for (const articleId of articleIds) {
            const file = archiveMarkdownPath(youtubeStatus.archived?.[articleId]);
            if (file) { await fs.rm(path.dirname(file), { recursive: true, force: true }); removedArchives += 1; }
            delete youtubeStatus.archived?.[articleId];
            delete youtubeStatus.failures?.[articleId];
          }
          youtubeStatus.updatedAt = new Date().toISOString();
          favorites.ids = (favorites.ids || []).filter((id) => !articleIds.includes(id));
        }
        await Promise.all([
          writeJson(YOUTUBE_SUBSCRIPTIONS, youtubeConfig),
          writeJson(LIBRARY, library),
          ...(deleteArchive ? [writeJson(YOUTUBE_STATUS, youtubeStatus), writeJson(FAVORITES, favorites)] : []),
        ]);
        await mutateGroups((current) => { delete current.assignments[bookId]; });
        return sendJson(res, 200, { ok: true, name: channel.name, removedArchives, note: deleteArchive ? `已停止订阅并删除 ${removedArchives} 份 YouTube 字幕。` : '已从书架移除；已保存的字幕 Markdown 仍保留。' });
      }
      if (bookId.startsWith('TW_USER_')) {
        const [twitterConfig, library, twitterStatus, favorites, annotations] = await Promise.all([
          readJson(TWITTER_SUBSCRIPTIONS, { accounts: [] }),
          readJson(LIBRARY, { sources: [] }),
          readJson(TWITTER_STATUS, { archived: {}, failures: {} }),
          readJson(FAVORITES, { ids: [] }),
          readJson(ANNOTATIONS, { byArticle: {} }),
        ]);
        const account = (twitterConfig.accounts || []).find((entry) => entry.sourceId === bookId);
        if (!account) return sendJson(res, 404, { error: '找不到该 Twitter 订阅' });
        twitterConfig.accounts = twitterConfig.accounts.filter((entry) => entry.sourceId !== bookId);
        twitterConfig.updatedAt = new Date().toISOString();
        library.sources = (library.sources || []).filter((source) => source.bookId !== bookId);
        library.updatedAt = new Date().toISOString();
        const articleIds = [...new Set([
          ...Object.entries(twitterStatus.archived || {}).filter(([, entry]) => entry.sourceId === bookId).map(([id]) => id),
          ...Object.entries(twitterStatus.failures || {}).filter(([, entry]) => entry.sourceId === bookId).map(([id]) => id),
        ])];
        let removedArchives = 0;
        if (deleteArchive) {
          for (const articleId of articleIds) {
            const file = archiveMarkdownPath(twitterStatus.archived?.[articleId]);
            if (file) { await fs.rm(path.dirname(file), { recursive: true, force: true }); removedArchives += 1; }
            delete twitterStatus.archived?.[articleId];
            delete twitterStatus.failures?.[articleId];
            delete annotations.byArticle?.[articleId];
          }
          twitterStatus.updatedAt = new Date().toISOString();
          favorites.ids = (favorites.ids || []).filter((id) => !articleIds.includes(id));
        }
        await Promise.all([
          writeJson(TWITTER_SUBSCRIPTIONS, twitterConfig),
          writeJson(LIBRARY, library),
          ...(deleteArchive ? [writeJson(TWITTER_STATUS, twitterStatus), writeJson(FAVORITES, favorites), writeJson(ANNOTATIONS, annotations)] : []),
        ]);
        await mutateGroups((current) => { delete current.assignments[bookId]; });
        return sendJson(res, 200, { ok: true, name: account.name, removedArchives, note: deleteArchive ? `已停止订阅并删除 ${removedArchives} 份推文 Markdown。` : '已从书架移除；已保存的推文 Markdown 仍保留。' });
      }
      const [config, library, archiveStatus, favorites, annotations] = await Promise.all([
        readJson(CONFIG, { accounts: [] }),
        readJson(LIBRARY, { sources: [] }),
        readJson(ARCHIVE_STATUS, { archived: {}, failures: {} }),
        readJson(FAVORITES, { ids: [] }),
        readJson(ANNOTATIONS, { byArticle: {} }),
      ]);
      const account = (config.accounts || []).find((entry) => entry.bookId === bookId);
      if (!account) return sendJson(res, 404, { error: '找不到该订阅' });
      config.accounts = config.accounts.filter((entry) => entry.bookId !== bookId);
      library.sources = (library.sources || []).filter((source) => source.bookId !== bookId);
      library.updatedAt = new Date().toISOString();
      const articleIds = Object.keys(archiveStatus.archived || {}).filter((id) => id.startsWith(`${bookId}_`));
      let removedArchives = 0;
      if (deleteArchive) {
        for (const articleId of articleIds) {
          const file = archiveMarkdownPath(archiveStatus.archived[articleId]);
          if (file) {
            const articleDirectory = path.dirname(file);
            const incoming = path.resolve(DATA, '.incoming', path.basename(articleDirectory));
            await fs.rm(articleDirectory, { recursive: true, force: true });
            if (incoming.startsWith(path.join(DATA, '.incoming') + path.sep)) await fs.rm(incoming, { recursive: true, force: true });
            removedArchives += 1;
          }
          delete archiveStatus.archived[articleId];
          if (archiveStatus.failures) delete archiveStatus.failures[articleId];
        }
        archiveStatus.updatedAt = new Date().toISOString();
        favorites.ids = (favorites.ids || []).filter((id) => !articleIds.includes(id));
        for (const articleId of articleIds) delete annotations.byArticle?.[articleId];
      }
      await Promise.all([
        writeJson(CONFIG, config),
        writeJson(LIBRARY, library),
        ...(deleteArchive ? [writeJson(ARCHIVE_STATUS, archiveStatus), writeJson(FAVORITES, favorites), writeJson(ANNOTATIONS, annotations)] : []),
      ]);
      await mutateGroups((current) => { delete current.assignments[bookId]; });
      return sendJson(res, 200, { ok: true, name: account.name, removedArchives, note: deleteArchive ? `已停止订阅并删除 ${removedArchives} 篇本地文章及其图片。` : '已从本地订阅与阅读器隐藏；已归档的 Markdown 和图片仍保留在 data/文章 中。' });
    }

    const requested = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
    const file = path.resolve(PUBLIC, requested);
    if (!file.startsWith(`${PUBLIC}${path.sep}`) && file !== path.join(PUBLIC, 'index.html')) return send(res, 403, 'Forbidden');
    try { return send(res, 200, await fs.readFile(file), MIME[path.extname(file)] || 'application/octet-stream'); }
    catch { return send(res, 404, 'Not found'); }
  } catch (error) {
    return sendJson(res, 400, { error: error.message || '请求失败' });
  }
});

await ensureFixedSourceGroups();
scheduleTwitterRefresh();
server.listen(port, '127.0.0.1', () => console.log(`微信公众号知识库：http://localhost:${port}`));
