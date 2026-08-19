#!/usr/bin/env node
// 将 weread-mp-fetcher 最近一次抓取结果导出到 Obsidian Second Brain。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeWechatArticleUrl } from '../lib/wechat-url.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INPUT = path.join(ROOT, 'data', 'latest.json');
const OUTPUT = path.resolve(ROOT, '..', 'data');

if (!fs.existsSync(INPUT)) {
  console.error(`找不到抓取结果：${INPUT}`);
  process.exit(2);
}

const inputData = JSON.parse(fs.readFileSync(INPUT, 'utf8'));
const normalizeSource = (source) => ({
  ...source,
  items: (source.items || []).map((item) => ({ ...item, url: normalizeWechatArticleUrl(item.url) })),
});
const data = { ...inputData, sources: (inputData.sources || []).map(normalizeSource) };
const fetchedAt = new Date(data.fetchedAt);
const format = (date, options) => new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  hour12: false,
  ...options,
}).format(date);
const day = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric', month: '2-digit', day: '2-digit',
}).formatToParts(fetchedAt).reduce((out, part) => {
  if (part.type !== 'literal') out[part.type] = part.value;
  return out;
}, {});
const dateKey = `${day.year}-${day.month}-${day.day}`;
const fetchedLabel = format(fetchedAt, {
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit',
});
const xml = (value) => String(value)
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&apos;');
const md = (value) => String(value).replaceAll('[', '\\[').replaceAll(']', '\\]');
const articleTime = (timestamp) => format(new Date(timestamp * 1000), {
  month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
});

const articles = data.sources.flatMap((source) => source.items.map((item) => ({
  ...item,
  source: source.name,
}))).sort((a, b) => b.t - a.t);

fs.mkdirSync(path.join(OUTPUT, '日报'), { recursive: true });
fs.mkdirSync(path.join(OUTPUT, '数据'), { recursive: true });

// library.json 是阅读器的长期书库：按公众号和文章 ID 合并，保留历史文章。
const libraryPath = path.join(OUTPUT, '数据', 'library.json');
const existingLibrary = fs.existsSync(libraryPath)
  ? JSON.parse(fs.readFileSync(libraryPath, 'utf8'))
  : { sources: [] };
const oldSources = new Map((existingLibrary.sources || []).map(normalizeSource).map((source) => [source.bookId, source]));
for (const source of data.sources) {
  const previous = oldSources.get(source.bookId) || { ...source, items: [] };
  const itemById = new Map((previous.items || []).map((item) => [item.rid || item.url, item]));
  for (const item of source.items) itemById.set(item.rid || item.url, item);
  oldSources.set(source.bookId, {
    name: source.name,
    bookId: source.bookId,
    items: [...itemById.values()].sort((a, b) => b.t - a.t),
  });
}
const library = {
  updatedAt: data.fetchedAt,
  sources: [...oldSources.values()].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN')),
};

const report = [
  '---',
  `title: 微信公众号日报 ${dateKey}`,
  `created: ${fetchedLabel}`,
  `article_count: ${articles.length}`,
  '---',
  '',
  `# 微信公众号日报 · ${dateKey}`,
  '',
  `本次于 ${fetchedLabel} 抓取，共 ${articles.length} 篇。链接均指向微信公众号原文。`,
  '',
  ...data.sources.flatMap((source) => [
    `## ${source.name}（${source.items.length} 篇）`,
    '',
    ...source.items.map((item) => `- [${md(item.title)}](${item.url}) · ${articleTime(item.t)}`),
    '',
  ]),
].join('\n');

const rss = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<rss version="2.0">',
  '  <channel>',
  '    <title>Second Brain · 微信公众号</title>',
  '    <link>http://localhost:8031/wechat-reader/feed.xml</link>',
  `    <description>通过微信读书抓取的 ${data.sources.length} 个微信公众号文章</description>`,
  `    <lastBuildDate>${fetchedAt.toUTCString()}</lastBuildDate>`,
  '    <generator>weread-mp-fetcher + Second Brain</generator>',
  ...articles.flatMap((item) => [
    '    <item>',
    `      <title>${xml(`[${item.source}] ${item.title}`)}</title>`,
    `      <link>${xml(item.url)}</link>`,
    `      <guid isPermaLink="true">${xml(item.url)}</guid>`,
    `      <pubDate>${new Date(item.t * 1000).toUTCString()}</pubDate>`,
    `      <description>${xml(`公众号：${item.source}`)}</description>`,
    '    </item>',
  ]),
  '  </channel>',
  '</rss>',
  '',
].join('\n');

const sources = data.sources.map((source) => `- ${source.name}（${source.items.length} 篇）`).join('\n');
const entry = [
  '---',
  'title: 微信公众号',
  '---',
  '',
  '# 微信公众号',
  '',
  `最近更新：${fetchedLabel}，共 ${articles.length} 篇。`,
  '',
  `- 今日阅读：[[日报/${dateKey}]]`,
  '- RSS 文件：[feed.xml](feed.xml)',
  '- RSS 订阅地址：`http://localhost:8031/wechat-reader/feed.xml`',
  '',
  '## 当前订阅',
  '',
  sources,
  '',
  '> 文章目录由微信读书抓取；RSS 与日报会在下次抓取后覆盖更新，历史日报会保留。',
  '',
].join('\n');

fs.writeFileSync(path.join(OUTPUT, '日报', `${dateKey}.md`), report, 'utf8');
fs.writeFileSync(path.join(OUTPUT, 'feed.xml'), rss, 'utf8');
fs.writeFileSync(path.join(OUTPUT, '入口.md'), entry, 'utf8');
fs.writeFileSync(path.join(OUTPUT, '数据', 'latest.json'), JSON.stringify(data, null, 2) + '\n', 'utf8');
fs.writeFileSync(libraryPath, JSON.stringify(library, null, 2) + '\n', 'utf8');

console.log(JSON.stringify({ output: OUTPUT, date: dateKey, articles: articles.length }, null, 2));
