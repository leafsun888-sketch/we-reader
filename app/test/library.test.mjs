import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serverFile = path.join(appRoot, 'server.mjs');

const reservePort = () => new Promise((resolve, reject) => {
  const socket = net.createServer();
  socket.once('error', reject);
  socket.listen(0, '127.0.0.1', () => {
    const { port } = socket.address();
    socket.close((error) => error ? reject(error) : resolve(port));
  });
});
const waitFor = async (predicate, timeout = 5000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error('Timed out waiting for test server');
};
const json = async (base, endpoint, options) => {
  const response = await fetch(base + endpoint, options);
  return { response, body: await response.json() };
};

test('HTTP API 保存本地阅读数据，并准确报告正文归档部分失败', { timeout: 15000 }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'we-reader-api-'));
  const data = path.join(root, 'data');
  const fetcher = path.join(root, 'fetcher');
  const articleId = 'MP_WXS_101_1';
  const markdown = path.join(data, '文章', '测试号', '2026-08-10 测试文章', '2026-08-10 测试文章.md');
  await fs.mkdir(path.dirname(markdown), { recursive: true });
  await fs.mkdir(path.join(fetcher, 'bin'), { recursive: true });
  await fs.writeFile(markdown, '# 测试文章\n\n正文。\n');
  await fs.mkdir(path.join(data, '数据'), { recursive: true });
  await fs.writeFile(path.join(data, '数据', 'library.json'), JSON.stringify({
    updatedAt: '2026-08-10T08:00:00.000Z',
    sources: [{ name: '测试号', bookId: 'MP_WXS_101', items: [{ rid: articleId, title: '测试文章', url: 'https://mp.weixin.qq.com/s/test', t: 1786320000 }] }],
  }));
  await fs.writeFile(path.join(data, '数据', 'archive-status.json'), JSON.stringify({
    archived: { [articleId]: { account: '测试号', title: '测试文章', url: 'https://mp.weixin.qq.com/s/test', markdown: '文章/测试号/2026-08-10 测试文章/2026-08-10 测试文章.md' } },
    failures: {},
  }));
  await fs.writeFile(path.join(fetcher, 'config.json'), JSON.stringify({ accounts: [{ name: '测试号', bookId: 'MP_WXS_101' }], maxRunsPerDay: 2, chromePort: 9222 }));
  const fakeFetcher = path.join(fetcher, 'bin', 'fake-weread.mjs');
  await fs.writeFile(fakeFetcher, `
const args = process.argv.slice(2);
if (args.includes('--add')) {
  console.error('解析成功:MP_WXS_202 (新测试号) ← 测试');
  console.error('已加入书架:MP_WXS_202');
  process.exit(0);
}
console.error('WE_READER_RESULT:' + JSON.stringify({ outcome: 'partial', stage: 'archive', message: '目录已更新，但有 1 篇正文未能归档。', archive: { failed: 1 } }));
process.exit(4);
`);

  const port = await reservePort();
  const child = spawn(process.execPath, [serverFile], {
    cwd: appRoot,
    env: { ...process.env, PORT: String(port), WE_READER_DATA_DIR: data, WE_READER_FETCHER_DIR: fetcher, WE_READER_FETCHER_BIN: fakeFetcher },
    stdio: 'ignore',
  });
  t.after(async () => {
    child.kill();
    await fs.rm(root, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${port}`;
  await waitFor(async () => (await fetch(base + '/api/library').catch(() => null))?.ok);

  const library = await json(base, '/api/library');
  assert.equal(library.body.sources[0].items[0].rid, articleId);

  const article = await json(base, `/api/articles/${articleId}`);
  assert.equal(article.response.status, 200);
  assert.match(article.body.markdown, /正文/);

  const favorite = await json(base, '/api/favorites', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: [articleId] }) });
  assert.equal(favorite.response.status, 200);
  assert.deepEqual((await json(base, '/api/favorites')).body.ids, [articleId]);

  const subscribe = await json(base, '/api/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: 'https://mp.weixin.qq.com/s/new' }) });
  assert.equal(subscribe.response.status, 200);
  assert.equal(subscribe.body.bookId, 'MP_WXS_202');

  const refresh = await json(base, '/api/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(refresh.response.status, 202);
  const finalJob = await waitFor(async () => {
    const result = await json(base, '/api/job');
    return result.body.status === 'running' ? null : result.body;
  });
  assert.equal(finalJob.status, 'partial');
  assert.match(finalJob.message, /正文未能归档/);
});
