#!/usr/bin/env node
// 把 Second Brain 微信公众号书库归档成可离线阅读的 Markdown + 图片。
// 目录：微信公众号/文章/<公众号名>/<YYYY-MM-DD 标题>/<YYYY-MM-DD 标题>.md

import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VAULT_ROOT = path.resolve(ROOT, '..', 'data');
const LIBRARY = path.join(VAULT_ROOT, '数据', 'library.json');
const ARCHIVE = path.join(VAULT_ROOT, '文章');
const STAGING = path.join(VAULT_ROOT, '.incoming');
const STATUS = path.join(VAULT_ROOT, '数据', 'archive-status.json');
const PYTHON = process.env.WE_READER_PYTHON || 'python3';
const readerCandidates = [
  process.env.WE_READER_READGZH,
  path.join(ROOT, 'vendor', 'readgzh.py'),
  path.join(os.homedir(), '.codex', 'skills', 'readgzh', 'scripts', 'readgzh.py'),
].filter(Boolean);
const READER = readerCandidates.find((candidate) => existsSync(candidate));
const argv = process.argv.slice(2);
const indexOf = argv.indexOf('--limit');
const limit = indexOf >= 0 ? Number(argv[indexOf + 1]) : 0;

const safe = (value) => String(value || 'untitled')
  .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-')
  .replace(/\s+/g, ' ')
  .trim()
  .replace(/[. ]+$/g, '') || 'untitled';
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

const library = JSON.parse(await fs.readFile(LIBRARY, 'utf8'));
if (!READER) throw new Error('找不到 readgzh.py。请设置 WE_READER_READGZH=/path/to/readgzh.py 后重试。');
const articles = library.sources.flatMap((source) => source.items.map((item) => ({ ...item, account: source.name })))
  .sort((a, b) => b.t - a.t);
await fs.mkdir(ARCHIVE, { recursive: true });
await fs.mkdir(STAGING, { recursive: true });
let status = existsSync(STATUS) ? JSON.parse(await fs.readFile(STATUS, 'utf8')) : { archived: {}, failures: {} };
let archived = 0, skipped = 0, failed = 0;

for (const article of articles) {
  if (limit > 0 && archived + failed >= limit) break;
  const filename = `${day(article.t)} ${safe(article.title)}`;
  const targetDir = path.join(ARCHIVE, safe(article.account), filename);
  const targetMd = path.join(targetDir, `${filename}.md`);
  const key = article.rid || article.url;
  if (existsSync(targetMd)) {
    skipped += 1;
    continue;
  }
  const tempRoot = path.join(STAGING, safe(key));
  await fs.mkdir(tempRoot, { recursive: true });
  console.log(`下载 ${article.account} · ${article.title}`);
  const result = await run(PYTHON, [READER, article.url, '--out-dir', tempRoot]);
  if (result.code !== 0) {
    failed += 1;
    status.failures[key] = { account: article.account, title: article.title, url: article.url, error: (result.stderr || result.stdout).trim(), attemptedAt: new Date().toISOString() };
    console.error(`失败：${article.title} — ${status.failures[key].error}`);
  } else {
    try {
      const output = JSON.parse(result.stdout);
      const sourceDir = path.dirname(output.markdown);
      const converted = await fs.readFile(output.markdown, 'utf8');
      if (isInvalidWechatExport(converted)) throw new Error('微信未返回文章正文（参数错误页），未写入本地书库');
      await fs.mkdir(path.dirname(targetDir), { recursive: true });
      await fs.rename(sourceDir, targetDir);
      await fs.rename(path.join(targetDir, path.basename(output.markdown)), targetMd);
      status.archived[key] = { account: article.account, title: article.title, url: article.url, markdown: path.relative(VAULT_ROOT, targetMd), archivedAt: new Date().toISOString() };
      delete status.failures[key];
      archived += 1;
      console.log(`已归档：${path.relative(VAULT_ROOT, targetMd)}`);
    } catch (error) {
      failed += 1;
      status.failures[key] = { account: article.account, title: article.title, url: article.url, error: `归档失败：${error.message}`, attemptedAt: new Date().toISOString() };
      console.error(status.failures[key].error);
    }
  }
  status.updatedAt = new Date().toISOString();
  await fs.writeFile(STATUS, JSON.stringify(status, null, 2) + '\n', 'utf8');
  await sleep(900);
}

console.log(JSON.stringify({ archived, skipped, failed, archive: ARCHIVE }, null, 2));
