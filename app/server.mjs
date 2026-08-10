import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.resolve(ROOT, '..');
const PUBLIC = path.join(ROOT, 'public');
const DATA = path.resolve(process.env.WE_READER_DATA_DIR || path.join(PROJECT, 'data'));
const FETCHER = path.resolve(process.env.WE_READER_FETCHER_DIR || path.join(PROJECT, 'fetcher'));
const LIBRARY = path.join(DATA, '数据', 'library.json');
const FAVORITES = path.join(DATA, '数据', 'favorites.json');
const ANNOTATIONS = path.join(DATA, '数据', 'annotations.json');
const ARCHIVE_STATUS = path.join(DATA, '数据', 'archive-status.json');
const CONFIG = path.join(FETCHER, 'config.json');
const CONFIG_TEMPLATE = path.join(FETCHER, 'config.example.json');
const FETCHER_BIN = path.resolve(process.env.WE_READER_FETCHER_BIN || path.join(FETCHER, 'bin', 'weread.mjs'));
const QUOTA = path.join(FETCHER, 'data', 'quota.json');
const LATEST = path.join(FETCHER, 'data', 'latest.json');
const RECOMMENDED_DAILY_LIMIT = 2;
const port = Number(process.env.PORT || 8041);
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };

let job = { status: 'idle', kind: null, message: '准备就绪', startedAt: null, finishedAt: null, output: '' };

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
  const temp = `${file}.tmp`;
  await fs.writeFile(temp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  await fs.rename(temp, file);
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
  const status = await readJson(ARCHIVE_STATUS, { archived: {} });
  return { status, entry: status.archived?.[articleId] || null };
};
const archiveMarkdownPath = (entry) => {
  if (!entry?.markdown) return null;
  const file = path.resolve(DATA, entry.markdown);
  const articleRoot = path.join(DATA, '文章') + path.sep;
  return file.startsWith(articleRoot) ? file : null;
};
const ensureFetcherConfig = async () => {
  try { await fs.access(CONFIG); return; } catch { /* First-run setup continues below. */ }
  const template = await readJson(CONFIG_TEMPLATE, {});
  await writeJson(CONFIG, {
    ...template,
    accounts: [],
    readerUrl: '',
    statePath: 'data/quota.json',
  });
};

const completionFromOutput = (output) => {
  const results = [...String(output).matchAll(/WE_READER_RESULT:(\{[^\n]+\})/g)];
  if (!results.length) return null;
  try { return JSON.parse(results.at(-1)[1]); } catch { return null; }
};

function runFetcher(kind, args) {
  if (job.status === 'running') throw new Error('已有任务正在执行，请等待完成');
  job = { status: 'running', kind, message: kind === 'refresh' ? '正在连接微信读书并拉取文章…' : '正在解析文章链接并加入书架…', startedAt: new Date().toISOString(), finishedAt: null, output: '' };
  const child = spawn(process.execPath, [FETCHER_BIN, ...args], { cwd: FETCHER, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  const append = (chunk) => { output = (output + chunk.toString()).slice(-12000); job.output = output; };
  child.stdout.on('data', append);
  child.stderr.on('data', append);
  const done = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => {
      const completion = completionFromOutput(output);
      const status = completion?.outcome === 'partial' ? 'partial' : code === 0 ? 'success' : 'failed';
      const defaultMessage = kind === 'refresh' ? '同步完成，书库与本地正文已更新。' : '公众号已加入书架。';
      job = {
        ...job,
        status,
        message: completion?.message || (status === 'success' ? defaultMessage : '任务未完成，请查看提示。'),
        finishedAt: new Date().toISOString(),
        output,
      };
      resolve({ code, output });
    });
  });
  return done;
}

async function management() {
  const [config, library, quota, latest] = await Promise.all([
    readJson(CONFIG, { accounts: [] }),
    readJson(LIBRARY, { sources: [] }),
    readJson(QUOTA, {}),
    readJson(LATEST, {}),
  ]);
  const sourceById = new Map((library.sources || []).map((source) => [source.bookId, source]));
  const maxRunsPerDay = Math.min(Math.max(Number(config.maxRunsPerDay) || RECOMMENDED_DAILY_LIMIT, 1), RECOMMENDED_DAILY_LIMIT);
  const runsToday = quota.date === localDay() ? Math.max(0, Number(quota.count) || 0) : 0;
  return {
    accounts: (config.accounts || []).map((account) => {
      const source = sourceById.get(account.bookId);
      return { ...account, articleCount: source?.items?.length || 0, latestAt: source?.items?.[0]?.t || null };
    }),
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
      if (!articleId.startsWith('MP_WXS_')) return sendJson(res, 400, { error: '文章标识无效' });
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
        if (!articleId.startsWith('MP_WXS_') || !text || text.length > 800) throw new Error('划线内容无效');
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
      await ensureFetcherConfig();
      const result = await runFetcher('subscribe', ['--add', articleUrl]);
      const match = result.output.match(/解析成功:(MP_WXS_\d+)(?: \(([^)]+)\))?/);
      if (result.code !== 0 || !match || !/已加入书架/.test(result.output)) return sendJson(res, 422, { error: '未能完成订阅', detail: result.output.slice(-1200), job });
      const [, bookId, parsedName] = match;
      const config = await readJson(CONFIG, { accounts: [] });
      if (!(config.accounts || []).some((account) => account.bookId === bookId)) {
        config.accounts = [...(config.accounts || []), { name: parsedName || bookId, bookId }];
        await writeJson(CONFIG, config);
      }
      return sendJson(res, 200, { ok: true, name: parsedName || bookId, bookId, management: await management() });
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

    const subscription = url.pathname.match(/^\/api\/subscriptions\/(MP_WXS_\d+)$/);
    if (subscription && req.method === 'DELETE') {
      const bookId = subscription[1];
      const payload = await readJsonBody(req);
      const deleteArchive = payload.deleteArchive === true;
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

server.listen(port, '127.0.0.1', () => console.log(`微信公众号知识库：http://localhost:${port}`));
