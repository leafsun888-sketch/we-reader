#!/usr/bin/env node

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.resolve(ROOT, '..', 'data');
const ARTICLES = path.join(DATA, '文章');
const LIBRARY = path.join(DATA, '数据', 'library.json');
const ARCHIVE_STATUS = path.join(DATA, '数据', 'archive-status.json');

const library = JSON.parse(await fs.readFile(LIBRARY, 'utf8'));
const twitterSources = (library.sources || []).filter((source) => source.platform === 'twitter');
const twitterIds = new Set(twitterSources.flatMap((source) =>
  (source.items || []).map((item) => String(item.rid || item.url || '')).filter(Boolean)
));

const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const trashRoot = path.join(os.homedir(), '.Trash', `We-Read-Twitter-误归档-${timestamp}`);
const moved = [];

async function markdownFiles(directory) {
  const found = [];
  async function walk(current) {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const child = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(child);
      else if (entry.isFile() && entry.name.endsWith('.md')) found.push(child);
    }
  }
  await walk(directory);
  return found;
}

for (const source of twitterSources) {
  const wrongDirectory = path.join(ARTICLES, source.name);
  let stat;
  try { stat = await fs.stat(wrongDirectory); } catch { continue; }
  if (!stat.isDirectory()) continue;

  const markdown = await markdownFiles(wrongDirectory);
  if (!markdown.length) throw new Error(`拒绝移动空目录：${wrongDirectory}`);
  for (const file of markdown) {
    const head = (await fs.readFile(file, 'utf8')).slice(0, 1200);
    if (!/^source:\s*"https:\/\/(?:x|twitter)\.com\//mi.test(head)) {
      throw new Error(`目录含有非 X 归档，拒绝自动移动：${file}`);
    }
  }

  await fs.mkdir(trashRoot, { recursive: true });
  const target = path.join(trashRoot, source.name);
  await fs.rename(wrongDirectory, target);
  moved.push({ source: source.name, markdown: markdown.length, target });
}

const status = JSON.parse(await fs.readFile(ARCHIVE_STATUS, 'utf8'));
let removedArchived = 0;
let removedFailures = 0;
for (const key of Object.keys(status.archived || {})) {
  if (!twitterIds.has(key)) continue;
  delete status.archived[key];
  removedArchived += 1;
}
for (const key of Object.keys(status.failures || {})) {
  if (!twitterIds.has(key)) continue;
  delete status.failures[key];
  removedFailures += 1;
}
status.updatedAt = new Date().toISOString();
const temporary = `${ARCHIVE_STATUS}.${process.pid}.tmp`;
await fs.writeFile(temporary, `${JSON.stringify(status, null, 2)}\n`, 'utf8');
await fs.rename(temporary, ARCHIVE_STATUS);

process.stdout.write(`${JSON.stringify({ moved, removedArchived, removedFailures }, null, 2)}\n`);
