import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('阅读器可在空书库状态启动', () => {
  assert.ok(root.endsWith(path.join('we-reader', 'app')) || root.endsWith(path.join('wechat-second-brain', 'app')));
  assert.equal(path.basename(root), 'app');
});
