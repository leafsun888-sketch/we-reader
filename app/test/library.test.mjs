import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const libraryPath = process.env.WE_READ_LIBRARY || fileURLToPath(new URL('../../data/数据/library.json', import.meta.url));

test('Second Brain 多来源书库可供阅读器加载', { skip: !fs.existsSync(libraryPath) }, () => {
  const library = JSON.parse(fs.readFileSync(libraryPath, 'utf8'));
  assert.ok(Array.isArray(library.sources));
  assert.ok(library.sources.length > 0);
  for (const source of library.sources) {
    assert.ok(source.name);
    assert.ok(source.bookId);
    assert.ok(Array.isArray(source.items));
    for (const item of source.items) {
      assert.ok(item.title);
      if (source.platform === 'youtube') assert.match(item.url, /^https:\/\/(?:www\.)?youtube\.com\/watch\?/);
      else if (source.platform === 'twitter') assert.match(item.url, /^https:\/\/x\.com\/[A-Za-z0-9_]+\/status\/\d+$/);
      else assert.match(item.url, /^https:\/\/mp\.weixin\.qq\.com\/s\//);
      assert.equal(typeof item.t, 'number');
    }
    if (source.platform === 'twitter') {
      for (let index = 1; index < source.items.length; index += 1) {
        assert.ok(source.items[index - 1].t >= source.items[index].t, `${source.name} 的推文没有按时间倒序保存`);
      }
      for (const item of source.items) {
        const createdAt = Date.parse(item.createdAt || '') / 1000;
        if (Number.isFinite(createdAt)) assert.ok(Math.abs(createdAt - item.t) <= 2, `${item.rid} 的 t 与 createdAt 不一致`);
      }
    }
  }
});
