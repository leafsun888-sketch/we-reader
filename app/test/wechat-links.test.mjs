import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const script = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const urlHelper = script.slice(script.indexOf('const publicArticleUrl ='), script.indexOf('const articleById ='));
const renderer = script.slice(script.indexOf('function articleRow('), script.indexOf('function longformRow('));
const render = (url) => vm.runInNewContext(`${urlHelper}\n${renderer}\narticleRow(input)`, {
  input: { rid: 'MP_WXS_123_example', platform: 'wechat', title: '示例文章', source: '示例公众号', url, t: 1 },
  state: { favorites: new Set() }, articleId: a => a.rid, esc: String, dt: () => '今天',
});

test('WeChat titles open real external originals, not the local reader', () => {
  const url = 'https://mp.weixin.qq.com/s?__biz=abc&mid=1&idx=1&sn=abcdef';
  const html = render(url);
  assert.ok(html.includes(`href="${url}"`));
  assert.ok(html.includes('target="_blank"'));
  assert.equal(html.includes('data-local-article'), false);
});
test('unresolved WR1 identifiers never become clickable fake original URLs', () => {
  const html = render('https://mp.weixin.qq.com/s/WR1' + 'a'.repeat(70));
  assert.equal(html.includes('href='), false);
  assert.ok(html.includes('原文链接待解析'));
});
