import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const converter = path.join(root, 'vendor', 'readgzh.py');
const python = process.env.WE_READER_PYTHON || process.env.PYTHON || 'python3';

test('bundled converter turns verified article HTML into local Markdown', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'we-reader-readgzh-'));
  const html = path.join(temp, 'article.html');
  const out = path.join(temp, 'out');
  await fs.writeFile(html, `<!doctype html><html><head><title>备用标题</title></head><body>
    <script>var msg_title = "本地测试文章"; var nickname = "测试公众号"; var ct = "1786320000";</script>
    <div id="js_content"><h2>小节</h2><p>第一段 <a href="https://example.com">链接</a></p><ul><li>项目一</li></ul></div>
  </body></html>`);
  try {
    const result = spawnSync(python, [converter, '--html-file', html, '--source-url', 'https://mp.weixin.qq.com/s/example', '--out-dir', out], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    const markdown = await fs.readFile(payload.markdown, 'utf8');
    assert.match(markdown, /title: "本地测试文章"/);
    assert.match(markdown, /## 小节/);
    assert.match(markdown, /\[链接\]\(https:\/\/example.com\)/);
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});
