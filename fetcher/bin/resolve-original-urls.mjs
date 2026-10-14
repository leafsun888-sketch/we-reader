#!/usr/bin/env node
// Only repairs original URLs; never fetches indexes, downloads images, or charges quota.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectChrome, listTabs, captureArticleRequestHeaders } from '../lib/cdp.mjs';
import { resolveSourceUrls } from '../lib/original-urls.mjs';
import { canonicalWechatArticleUrl } from '../lib/wechat-url.mjs';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const data = path.join(project, 'data/数据');
const cfg = JSON.parse(await fs.readFile(path.join(project, 'fetcher/config.json'), 'utf8'));
const library = JSON.parse(await fs.readFile(path.join(data, 'library.json'), 'utf8'));
const session = await connectChrome({ port: cfg.chromePort, profileDir: path.resolve(project, 'fetcher', cfg.chromeProfileDir), autoLaunch: false });
try {
  const reader = (await listTabs(session)).find(tab => tab.url.includes('weread.qq.com/web/mp/reader/'));
  if (!reader) throw new Error('请先打开专用微信读书阅读器');
  const headers = await captureArticleRequestHeaders(session, reader.targetId);
  const result = await resolveSourceUrls(session, reader.targetId, headers, library.sources, path.join(data, 'wechat-original-urls.json'), cfg.requestIntervalMs);
  const backup = path.join(data, 'url-repair-backups', new Date().toISOString().replaceAll(':', '-'));
  await fs.mkdir(backup, { recursive: true, mode: 0o700 });
  const files = [path.join(data, 'library.json'), path.join(project, 'fetcher/data/latest.json'), path.join(data, 'latest.json'), path.join(data, 'archive-status.json')];
  for (const [index, file] of files.entries()) {
    const raw = await fs.readFile(file, 'utf8').catch(() => null);
    if (raw === null) continue;
    const value = JSON.parse(raw);
    let changed = 0;
    function repair(node, id) {
      if (!node || typeof node !== 'object') return;
      const key = node.rid || id;
      const url = canonicalWechatArticleUrl(result.cache.byId?.[key]?.url);
      if (typeof node.url === 'string' && url && node.url !== url) {
        node.url = url;
        delete node.urlNeedsResolution;
        changed++;
      }
      for (const [childId, child] of Object.entries(node)) repair(child, childId);
    }
    repair(value);
    if (!changed) continue;
    if (file.endsWith('/library.json')) value.updatedAt = new Date().toISOString();
    await fs.writeFile(path.join(backup, `${index}-${path.basename(file)}`), raw, { mode: 0o600 });
    const temp = `${file}.tmp-${process.pid}`;
    await fs.writeFile(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
    await fs.rename(temp, file);
    console.log(`${path.relative(project, file)}：修复 ${changed} 条原文链接`);
  }
  console.log(JSON.stringify({ resolved: result.resolved, failed: result.failed, total: result.total }));
  if (result.failed) process.exitCode = 2;
} finally { session.close(); }
