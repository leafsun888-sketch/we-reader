import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalWechatArticleUrl, needsWechatUrlResolution } from '../lib/wechat-url.mjs';

test('WR1 identifiers must be resolved rather than treated as public short links', () => {
  const url = 'https://mp.weixin.qq.com/s/WR1' + 'a'.repeat(70);
  assert.equal(needsWechatUrlResolution({ url }), true);
  assert.equal(canonicalWechatArticleUrl(url), '');
});
test('canonical links retain exact article identity and discard tracking parameters', () => {
  const input = 'http://mp.weixin.qq.com/s?__biz=MTIzNDU2Nzg5MA==&mid=1234567890&idx=1&sn=0123456789abcdef0123456789abcdef&chksm=track#rd';
  const url = new URL(canonicalWechatArticleUrl(input));
  assert.equal(url.protocol, 'https:');
  assert.equal(url.searchParams.get('__biz'), 'MTIzNDU2Nzg5MA==');
  assert.equal(url.searchParams.get('sn'), '0123456789abcdef0123456789abcdef');
  assert.equal(url.searchParams.has('chksm'), false);
  assert.equal(url.hash, '');
});
test('reject missing parameters, other hosts and credential-bearing links', () => {
  for (const url of ['https://mp.weixin.qq.com/s?__biz=abc&mid=123', 'https://example.com/s/abcdefghijklmnopqrstuv', 'https://user@mp.weixin.qq.com/s/abcdefghijklmnopqrstuv', 'javascript:alert(1)']) assert.equal(canonicalWechatArticleUrl(url), '');
});
test('legacy short links still work and restore the tilde escape', () => {
  assert.equal(canonicalWechatArticleUrl('https://mp.weixin.qq.com/s/abc~efghijklmnopqrstuv'), 'https://mp.weixin.qq.com/s/abc_efghijklmnopqrstuv');
  assert.equal(needsWechatUrlResolution({ url: 'https://mp.weixin.qq.com/s/abcdefghijklmnopqrstuv' }), false);
});
