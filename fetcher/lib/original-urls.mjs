import fs from 'node:fs/promises';
import path from 'node:path';
import { evaluate } from './cdp.mjs';
import { canonicalWechatArticleUrl, needsWechatUrlResolution } from './wechat-url.mjs';

export async function fetchOriginalUrl(session, targetId, reviewId, headers) {
  if (!/^MP_WXS_\d+_/.test(reviewId || '')) throw new Error('无效的文章 ID');
  const expression = `(async()=>{
    const response=await fetch('/web/mp/content?reviewId='+encodeURIComponent(${JSON.stringify(reviewId)}),{credentials:'include',headers:${JSON.stringify(headers)},signal:AbortSignal.timeout(30000)});
    if(!response.ok) throw new Error('正文接口 HTTP '+response.status);
    const html=await response.text();
    if(/^\\s*\\{/.test(html)) throw new Error('正文接口 errCode='+JSON.parse(html).errCode);
    const doc=new DOMParser().parseFromString(html,'text/html');
    if(/环境异常|请输入验证码|访问过于频繁/.test((doc.body?.textContent||'').slice(0,2000))) throw new Error('需要手动验证码，停止解析原文地址');
    return JSON.stringify([...doc.head.querySelectorAll('link[rel="canonical"],meta[property="og:url"]')].map(n=>n.getAttribute('href')||n.getAttribute('content')));
  })()`;
  const candidates = JSON.parse(await evaluate(session, targetId, expression, 45000));
  const url = candidates.map(canonicalWechatArticleUrl).find(Boolean);
  if (!url) throw new Error('正文未提供有效的 canonical/og:url 原文地址');
  return url;
}

export async function resolveSourceUrls(session, targetId, headers, sources, cacheFile, intervalMs = 3000) {
  const cache = await fs.readFile(cacheFile, 'utf8').then(JSON.parse).catch(() => ({ byId: {} }));
  const items = sources.filter(s => (s.platform || 'wechat') === 'wechat').flatMap(s => s.items || []).filter(needsWechatUrlResolution).sort((a, b) => b.t - a.t);
  let resolved = 0, failed = 0;
  for (const item of items) {
    let requested = false;
    try {
      let url = canonicalWechatArticleUrl(cache.byId?.[item.rid]?.url);
      if (!url) {
        requested = true;
        url = await fetchOriginalUrl(session, targetId, item.rid, headers);
        cache.byId ||= {};
        cache.byId[item.rid] = { url, resolvedAt: new Date().toISOString(), method: 'weread-canonical' };
        await fs.mkdir(path.dirname(cacheFile), { recursive: true });
        const temp = `${cacheFile}.tmp-${process.pid}`;
        await fs.writeFile(temp, JSON.stringify(cache, null, 2) + '\n', { mode: 0o600 });
        await fs.rename(temp, cacheFile);
      }
      item.url = url;
      delete item.urlNeedsResolution;
      resolved++;
    } catch (error) {
      item.urlNeedsResolution = true;
      failed++;
      console.error(`原文地址待解析：${item.title} · ${error.message}`);
      if (/errCode=-20(?:10|41)|HTTP (?:401|403|429)|需要手动验证码/.test(error.message)) {
        for (const pending of items) if (needsWechatUrlResolution(pending)) pending.urlNeedsResolution = true;
        throw error;
      }
    } finally {
      if (requested) await new Promise(resolve => setTimeout(resolve, Math.max(3000, intervalMs)));
    }
    console.error(`原文地址 ${resolved + failed}/${items.length} · 成功 ${resolved} · 待重试 ${failed}`);
  }
  return { resolved, failed, total: items.length, cache };
}
