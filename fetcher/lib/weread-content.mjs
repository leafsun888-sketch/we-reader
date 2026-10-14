import { evaluate, listTabs, createTab } from './cdp.mjs';
const originalIndexes = new Map();
let browserTarget;
let browserBlocked = false;

export async function fetchBrowserContent(session, sourceUrl) {
  const url = new URL(sourceUrl);
  if (url.hostname !== 'mp.weixin.qq.com' || !['http:', 'https:'].includes(url.protocol)) throw new Error('无效的微信原文链接');
  url.protocol = 'https:';
  url.hash = '';
  if (browserBlocked) throw new Error('微信原文需要手动验证码，暂停浏览器下载');
  const tabs = await listTabs(session);
  const same = tabs.find(tab => tab.url.replace(/^http:/, 'https:').split('#')[0] === url.href);
  if (same) browserTarget = same.targetId;
  else if (!browserTarget || !tabs.some(tab => tab.targetId === browserTarget)) browserTarget = await createTab(session, url.href);
  else {
    const { sessionId } = await session.send('Target.attachToTarget', { targetId: browserTarget, flatten: true });
    try { await session.send('Page.navigate', { url: url.href }, sessionId); }
    finally { await session.send('Target.detachFromTarget', { sessionId }); }
  }
  await new Promise(resolve => setTimeout(resolve, same ? 100 : 3000));
  const expression = `JSON.stringify((() => {
    const text = document.body?.innerText || '';
    if (location.pathname.includes('captcha') || /环境异常|请输入验证码|访问过于频繁/.test(text.slice(0, 2000))) return {captcha:true};
    if (/根据作者隐私设置|作者设置了关注后可见|仅关注用户可见/.test(text.slice(0, 1000))) return {error:'作者隐私设置限制，当前浏览器无法查看正文'};
    if (/参数错误|该内容已被发布者删除|此内容因违规无法查看/.test(text.slice(0, 1000))) return {error:'微信原文返回参数错误或已删除'};
    const node = document.querySelector('#js_content');
    if (!node || (!node.textContent.trim() && !node.querySelector('img'))) return {error:'浏览器未取得文章正文'};
    const content = node.cloneNode(true);
    content.querySelectorAll('script,iframe,object,embed').forEach(n => n.remove());
    return {content:content.outerHTML,images:[...new Set([...content.querySelectorAll('img')].map(img=>img.getAttribute('data-src')||img.getAttribute('data-original')||img.getAttribute('src')).filter(url=>url&&!url.startsWith('data:')))],author:document.querySelector('#js_author_name')?.textContent.trim()||'',method:'wechat-browser'};
  })())`;
  const result = JSON.parse(await evaluate(session, browserTarget, expression));
  if (result.captcha) {
    browserBlocked = true;
    await session.send('Target.activateTarget', {targetId:browserTarget});
    const error = new Error('微信原文需要手动验证码，已打开验证页面');
    error.code = 'VERIFICATION_REQUIRED';
    throw error;
  }
  if (result.error) throw new Error(result.error);
  return result;
}

// Parse downloaded HTML in an inert document; never navigate to or execute it.
export async function fetchWereadContent(session, targetId, reviewId, headers = {}, depth = 0) {
  if (!/^MP_WXS_\d+_/.test(reviewId || '')) throw new Error('缺少有效的微信读书 reviewId');
  const expression = `(async () => {
    const response = await fetch('/web/mp/content?reviewId=' + encodeURIComponent(${JSON.stringify(reviewId)}), {
      credentials: 'include', headers: ${JSON.stringify(headers)}, signal: AbortSignal.timeout(30000)
    });
    if (!response.ok) throw new Error('微信读书正文 HTTP ' + response.status);
    const html = await response.text();
    if (/^\\s*\\{/.test(html)) {
      const error = JSON.parse(html);
      throw new Error('微信读书正文 errCode=' + error.errCode);
    }
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const shared = doc.querySelector('#js_share_source[data-url]');
    if (shared) return JSON.stringify({ sharedUrl: shared.getAttribute('data-url'), sharedTitle: doc.querySelector('#original_panel_title')?.textContent.trim() });
    let content = doc.querySelector('#js_content');
    if (content && !content.textContent.trim() && !content.querySelector('img')) {
      content = doc.querySelector('#js_share_content') || content;
      content.id = 'js_content';
    }
    if (!content) throw new Error('微信读书未返回 #js_content，请检查登录或验证码');
    content.querySelectorAll('script,iframe,object,embed').forEach(node => node.remove());
    if (!content.textContent.trim() && !content.querySelector('img')) throw new Error('微信读书正文为空');
    const images = [...new Set([...content.querySelectorAll('img')].map(img => img.getAttribute('data-src') || img.getAttribute('data-original') || img.getAttribute('src')).filter(url => url && !url.startsWith('data:')))];
    return JSON.stringify({content: content.outerHTML, images, author: doc.querySelector('#js_author_name')?.textContent.trim() || ''});
  })()`;
  const result = JSON.parse(await evaluate(session, targetId, expression, 45000));
  if (!result.sharedUrl) return result;
  if (depth >= 2) throw new Error('转载原文跳转次数超过限制');
  const url = new URL(result.sharedUrl);
  if (url.hostname !== 'mp.weixin.qq.com') throw new Error('转载原文域名不正确');
  const biz = Buffer.from(url.searchParams.get('__biz') || '', 'base64').toString();
  if (!/^\d+$/.test(biz)) throw new Error('转载原文缺少公众号标识');
  const bookId = `MP_WXS_${biz}`;
  if (!originalIndexes.has(bookId)) {
    const expression = `fetch('/web/mp/articles?bookId=' + ${JSON.stringify(bookId)} + '&offset=0', {credentials:'include',headers:${JSON.stringify(headers)}}).then(r=>r.json()).then(o=>JSON.stringify({errCode:o.errCode,items:(o.reviews||[]).flatMap(g=>(g.subReviews||[]).map(s=>({id:s.review?.reviewId,title:s.review?.mpInfo?.title})))}))`;
    const index = JSON.parse(await evaluate(session, targetId, expression));
    if (index.errCode) return fetchBrowserContent(session, result.sharedUrl);
    originalIndexes.set(bookId, index.items);
  }
  const original = originalIndexes.get(bookId).find(item => item.title?.trim() === result.sharedTitle);
  if (!original?.id) return fetchBrowserContent(session, result.sharedUrl);
  await new Promise(resolve => setTimeout(resolve, 3000));
  return fetchWereadContent(session, targetId, original.id, headers, depth + 1);
}
