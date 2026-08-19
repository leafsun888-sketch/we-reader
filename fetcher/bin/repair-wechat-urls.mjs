#!/usr/bin/env node
// 修复历史 JSON 中被微信读书从 `_` 转义成 `~` 的公众号短链。
// 默认只预览；显式传 --write 才会原子写回。文章 ID 和其他字段保持不变。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeWechatArticleUrl } from '../lib/wechat-url.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROJECT = path.resolve(ROOT, '..');
const write = process.argv.includes('--write');
const files = [
  path.join(ROOT, 'data', 'latest.json'),
  path.join(PROJECT, 'data', '数据', 'latest.json'),
  path.join(PROJECT, 'data', '数据', 'library.json'),
  path.join(PROJECT, 'data', '数据', 'archive-status.json'),
];

function repair(node) {
  let changed = 0;
  if (Array.isArray(node)) {
    for (const item of node) changed += repair(item);
    return changed;
  }
  if (!node || typeof node !== 'object') return changed;
  if (typeof node.url === 'string') {
    const normalized = normalizeWechatArticleUrl(node.url);
    if (normalized !== node.url) {
      node.url = normalized;
      changed += 1;
    }
  }
  for (const value of Object.values(node)) changed += repair(value);
  return changed;
}

const results = [];
for (const file of files) {
  if (!fs.existsSync(file)) continue;
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  const changed = repair(value);
  if (write && changed) {
    const temporary = `${file}.repairing-${process.pid}`;
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.renameSync(temporary, file);
  }
  results.push({ file: path.relative(PROJECT, file), changed });
}

console.log(JSON.stringify({ mode: write ? 'write' : 'dry-run', files: results, total: results.reduce((sum, item) => sum + item.changed, 0) }, null, 2));
