// 微信读书的 mpInfo.originalId 会把微信短链中的 `_` 转义成 `~`。
// mp.weixin.qq.com 不识别这种转义，访问后只会返回 ret=-2「参数错误」。
export function normalizeWechatArticleUrl(value) {
  const input = String(value || '');
  const match = input.match(/^(https:\/\/mp\.weixin\.qq\.com\/s\/)([^/?#]+)(.*)$/i);
  if (!match || !match[2].includes('~')) return input;
  return `${match[1]}${match[2].replaceAll('~', '_')}${match[3]}`;
}

// WR1 is a WeRead identifier, not a public WeChat short-link token.
export function needsWechatUrlResolution(item) {
  return Boolean(item.urlNeedsResolution || /^https:\/\/mp\.weixin\.qq\.com\/s\/WR1[^/?#]{30,}/i.test(item.url || ''));
}

export function canonicalWechatArticleUrl(value) {
  try {
    const url = new URL(normalizeWechatArticleUrl(value));
    if (!['https:', 'http:'].includes(url.protocol) || url.hostname !== 'mp.weixin.qq.com' || url.username || url.password) return '';
    if (url.pathname === '/s') {
      const biz = url.searchParams.get('__biz');
      const mid = url.searchParams.get('mid');
      const idx = url.searchParams.get('idx');
      const sn = url.searchParams.get('sn');
      if (!/^[A-Za-z0-9+/=]+$/.test(biz || '') || !/^\d+$/.test(mid || '') || !/^\d+$/.test(idx || '') || !/^[a-f0-9]{32}$/i.test(sn || '')) return '';
      const clean = new URL('https://mp.weixin.qq.com/s');
      for (const key of ['__biz', 'mid', 'idx', 'sn']) clean.searchParams.set(key, url.searchParams.get(key));
      return clean.href;
    }
    if (/^\/s\/[A-Za-z0-9_-]{22}$/.test(url.pathname)) {
      url.protocol = 'https:';
      url.search = '';
      url.hash = '';
      return url.href;
    }
  } catch { /* Invalid or missing original URL. */ }
  return '';
}
