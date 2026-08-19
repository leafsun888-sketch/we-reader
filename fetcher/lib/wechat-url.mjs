// 微信读书的 mpInfo.originalId 会把微信短链中的 `_` 转义成 `~`。
// mp.weixin.qq.com 不识别这种转义，访问后只会返回 ret=-2「参数错误」。
export function normalizeWechatArticleUrl(value) {
  const input = String(value || '');
  const match = input.match(/^(https:\/\/mp\.weixin\.qq\.com\/s\/)([^/?#]+)(.*)$/i);
  if (!match || !match[2].includes('~')) return input;
  return `${match[1]}${match[2].replaceAll('~', '_')}${match[3]}`;
}
