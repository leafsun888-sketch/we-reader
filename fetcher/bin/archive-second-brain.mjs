#!/usr/bin/env node
// 把 Second Brain 微信公众号书库归档成可离线阅读的 Markdown + 图片。
// 目录：微信公众号/文章/<公众号名>/<YYYY-MM-DD 标题>/<YYYY-MM-DD 标题>.md

import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { connectChrome, listTabs, captureArticleRequestHeaders } from '../lib/cdp.mjs';
import { fetchWereadContent, fetchBrowserContent } from '../lib/weread-content.mjs';
import { normalizeWechatArticleUrl } from '../lib/wechat-url.mjs';
import { isWechatSource } from '../lib/source-platform.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VAULT_ROOT = path.resolve(ROOT, '..', 'data');
const LIBRARY = path.join(VAULT_ROOT, '数据', 'library.json');
const ARCHIVE = path.join(VAULT_ROOT, '文章');
const STAGING = path.join(VAULT_ROOT, '.incoming');
const STATUS = path.join(VAULT_ROOT, '数据', 'archive-status.json');
const PYTHON = process.env.WE_READ_PYTHON || process.env.PYTHON || 'python3';
const READER = process.env.READGZH_SCRIPT || path.join(ROOT, 'vendor', 'readgzh.py');
const argv = process.argv.slice(2);
const indexOf = argv.indexOf('--limit');
const limit = indexOf >= 0 ? Number(argv[indexOf + 1]) : 0;
const articleIdIndex = argv.indexOf('--article-id');
const requestedArticleId = articleIdIndex >= 0 ? String(argv[articleIdIndex + 1] || '') : '';

const safe = (value) => String(value || 'untitled')
  .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-')
  .replace(/\s+/g, ' ')
  .trim()
  .replace(/[. ]+$/g, '') || 'untitled';
const digest = (value) => createHash('sha256').update(value).digest('hex').slice(0, 10);
const bounded = (value, maxBytes = 180) => {
  let result = '';
  for (const char of safe(value)) {
    if (Buffer.byteLength(result + char, 'utf8') > maxBytes) break;
    result += char;
  }
  return result;
};
const escapeHtml = (value) => String(value || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const dateOf = (time) => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
}).formatToParts(new Date(time * 1000)).reduce((result, part) => {
  if (part.type !== 'literal') result[part.type] = part.value;
  return result;
}, {});
const day = (time) => { const parts = dateOf(time); return `${parts.year}-${parts.month}-${parts.day}`; };
const run = (command, args) => new Promise((resolve) => {
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.on('close', (code) => resolve({ code, stdout, stderr }));
  child.on('error', (error) => resolve({ code: -1, stdout, stderr: error.message }));
});
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const isInvalidWechatExport = (markdown) => /^---[\s\S]*?title:\s*"WeChat Article"[\s\S]*?---[\s\S]*(?:参数错误|String\.prototype\.html)/m.test(markdown);
const archivePaths = (article) => {
  const title = safe(article.title);
  const filename = `${day(article.t)} ${bounded(title)}${Buffer.byteLength(title) > 180 ? ' ' + digest(article.rid || article.url) : ''}`;
  const targetDir = path.join(ARCHIVE, safe(article.account), filename);
  return { filename, targetDir, targetMd: path.join(targetDir, `${filename}.md`) };
};
const emitProgress = (completed, total, archived, failed) => {
  console.error(`WE_READ_ARCHIVE_PROGRESS ${JSON.stringify({ completed, total, archived, failed })}`);
};

const library = JSON.parse(await fs.readFile(LIBRARY, 'utf8'));
const articles = library.sources
  .filter(isWechatSource)
  .flatMap((source) => source.items.map((item) => ({
    ...item,
    url: normalizeWechatArticleUrl(item.url),
    account: source.name,
  })))
  .sort((a, b) => b.t - a.t);
await fs.mkdir(ARCHIVE, { recursive: true });
await fs.mkdir(STAGING, { recursive: true });
let status = existsSync(STATUS) ? JSON.parse(await fs.readFile(STATUS, 'utf8')) : { archived: {}, failures: {} };
const pendingArticles = articles.filter((article) => {
  if (status.archived?.[article.rid || article.url]?.incomplete) return true;
  const saved = status.archived?.[article.rid || article.url]?.markdown;
  if (saved && existsSync(path.join(VAULT_ROOT, saved))) return false;
  return !existsSync(archivePaths(article).targetMd);
});
const selectedArticles = requestedArticleId
  ? pendingArticles.filter((article) => (article.rid || article.url) === requestedArticleId)
  : pendingArticles;
const queue = limit > 0 ? selectedArticles.slice(0, limit) : selectedArticles;
let archived = 0, skipped = articles.length - pendingArticles.length, failed = 0, completed = 0;
emitProgress(completed, queue.length, archived, failed);

const cfg = JSON.parse(await fs.readFile(path.join(ROOT, 'config.json'), 'utf8'));
const session = queue.length ? await connectChrome({ port: cfg.chromePort, profileDir: path.resolve(ROOT, cfg.chromeProfileDir), autoLaunch: true }) : null;
try {
const reader = session && (await listTabs(session)).find(tab => tab.url.includes('weread.qq.com/web/mp/reader/'));
if (session && !reader) throw new Error('请先打开专用 Chrome 的公众号阅读器并完成登录验证');
const headers = session ? await captureArticleRequestHeaders(session, reader.targetId) : {};
for (const article of queue) {
  let { targetDir, targetMd, filename } = archivePaths(article);
  const key = article.rid || article.url;
    try {
      const tempRoot = await fs.mkdtemp(path.join(STAGING, `${digest(key)}-`));
      console.log(`下载 ${article.account} · ${String(article.title).slice(0, 100)}`);
      let fetched;
      try { fetched = await fetchWereadContent(session, reader.targetId, article.rid, headers); }
      catch (error) {
        if (error.code === 'VERIFICATION_REQUIRED') throw error;
        fetched = await fetchBrowserContent(session, article.url);
      }
      // Keep converter filenames small; restore the complete indexed title below.
      const htmlFile = path.join(tempRoot, 'article.html');
      await fs.writeFile(htmlFile, `<html><head><meta charset="utf-8"><meta property="og:title" content="${escapeHtml(bounded(article.title, 150))}"></head><body><a id="js_name">${escapeHtml(article.account)}</a><span id="js_author_name">${escapeHtml(fetched.author)}</span>${fetched.content}</body></html>`, { mode: 0o600 });
      const result = await run(PYTHON, [READER, '--html-file', htmlFile, '--source-url', article.url, '--out-dir', tempRoot]);
      if (result.code !== 0) throw new Error((result.stderr || result.stdout).trim());
      const output = JSON.parse(result.stdout);
      const sourceDir = path.dirname(output.markdown);
      let converted = await fs.readFile(output.markdown, 'utf8');
      if (isInvalidWechatExport(converted)) throw new Error('微信未返回文章正文（参数错误页），未写入本地书库');
      converted = converted.replace(/^title:.*$/m, () => `title: ${JSON.stringify(article.title)}`)
        .replace(/^published_at:.*$/m, () => `published_at: ${JSON.stringify(day(article.t))}`);
      const assetNames = await fs.readdir(path.join(sourceDir, 'assets')).catch(() => []);
      for (const [index, url] of (fetched.images || []).entries()) {
        const name = assetNames.find(name => name.startsWith(`image-${String(index + 1).padStart(2, '0')}.`));
        if (name) converted = converted.split(url).join(`assets/${name}`);
      }
      await fs.writeFile(output.markdown, converted);
      const metadata = JSON.parse(await fs.readFile(output.metadata, 'utf8'));
      await fs.writeFile(output.metadata, JSON.stringify({ ...metadata, title: article.title, published_at: day(article.t) }, null, 2));
      // Preserve incomplete previous directories; install into a distinct directory.
      if (existsSync(targetDir)) {
        filename += ` ${digest(key)}-${path.basename(tempRoot)}`;
        targetDir = path.join(path.dirname(targetDir), filename);
        targetMd = path.join(targetDir, `${filename}.md`);
      }
      await fs.mkdir(path.dirname(targetDir), { recursive: true });
      await fs.rename(sourceDir, targetDir);
      await fs.rename(path.join(targetDir, path.basename(output.markdown)), targetMd);
      status.archived[key] = { account: article.account, title: article.title, url: article.url, markdown: path.relative(VAULT_ROOT, targetMd), archivedAt: new Date().toISOString(), method: 'weread-content', contentMethod: fetched.method || 'weread-content' };
      delete status.failures[key];
      archived += 1;
      console.log(`已归档：${path.relative(VAULT_ROOT, targetMd)}`);
    } catch (error) {
      failed += 1;
      status.failures[key] = { account: article.account, title: article.title, url: article.url, error: `归档失败：${error.message}`, attemptedAt: new Date().toISOString() };
      console.error(status.failures[key].error);
      if (error.code === 'VERIFICATION_REQUIRED') {
        await fs.writeFile(STATUS, JSON.stringify(status, null, 2) + '\n', 'utf8');
        process.exitCode = 2;
        break;
      }
    }
  status.updatedAt = new Date().toISOString();
  const statusTemp = `${STATUS}.tmp-${process.pid}`;
  await fs.writeFile(statusTemp, JSON.stringify(status, null, 2) + '\n', 'utf8');
  await fs.rename(statusTemp, STATUS);
  completed += 1;
  emitProgress(completed, queue.length, archived, failed);
  await sleep(3000);
}
} finally { session?.close(); }

console.log(JSON.stringify({ archived, skipped, failed, archive: ARCHIVE }, null, 2));
