// 注入到微信读书页面里执行的两段 JS。
//
// 之所以是「字符串拼出来」而不是独立 .js 文件:它们不在 Node 里跑,
// 而是被送进浏览器标签页执行,需要把配置(公众号列表、请求间隔)先烘焙进去。

/**
 * 页面状态探针 —— 决定「现在能不能抓」。
 *
 * 只读页面状态,不发任何业务请求,所以随便跑、不消耗每日额度。
 *
 * 返回 verdict:
 *   ready   → 可以抓
 *   captcha → 弹了验证码,交给用户手动完成(见 README「验证码」一节)
 *   loading → 还在加载/验证码正在准备,等几秒重探
 *   blank   → 页面被拦截,本轮放弃
 */
export const PROBE_JS = `(function(){
  var txt = (document.body && document.body.innerText || '').replace(/\\s+/g,' ').trim();
  var title = document.title || '';
  var onReader = location.pathname.indexOf('/web/mp/reader/') === 0;

  // 腾讯防水墙(TCaptcha)的节点。
  // ⚠️ 别写死 #tcaptcha_iframe 这类"看起来标准"的 id —— 实测真实 id 带 _dy 后缀
  //    (tcaptcha_iframe_dy / tcaptcha_wrapper_transform_dy),精确 id 一个都匹配不上。
  var capSel = '[id*="captcha"], [class*="tcaptcha"], iframe[src*="captcha"]';

  // ⚠️ 只认**仍然可见**的节点。验证码过关后 TCaptcha 不删 DOM,只把父容器透明掉:
  //    实测 iframe 自身 opacity:1 看着可见,是它的父 DIV opacity:0。
  //    只用 querySelector 判存在性 → 验证码过完之后会永远被判成 captcha,再也抓不了。
  var capVisible = [].slice.call(document.querySelectorAll(capSel)).some(function(n){
    for (var cur = n; cur; cur = cur.parentElement) {
      var s = getComputedStyle(cur);
      if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) return false;
    }
    var r = n.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  });

  // ⚠️ 验证码弹出前,页面会先把 TCaptcha 加载进来。实测开标签页后轮询 30 秒全是
  //    loading,验证码在那之后约 10 秒才弹 —— 但那 30 秒里 window.TencentCaptcha
  //    早就是 function 了。没这个旗标就会把"马上要弹验证码"误判成"被拦截了"。
  var capArming = typeof window.TencentCaptcha === 'function';

  var verdict;
  if (capVisible)                verdict = 'captcha';
  else if (!onReader)            verdict = 'wrong_page';
  else if (/公众号/.test(title)) verdict = 'ready';
  else if (capArming)            verdict = 'loading';
  else if (txt.length < 50)      verdict = 'loading';
  else                           verdict = 'blank';

  return JSON.stringify({
    verdict: verdict, title: title, len: txt.length,
    capArming: capArming, onReader: onReader
  });
})()`;

/**
 * 抓取脚本 —— 首次建库分页取历史文章；之后只追上次同步后的增量。
 *
 * ⚠️ 必须在阅读器页(/web/mp/reader/<hash>)的上下文里执行。
 *    在微信读书首页发同样的请求会返回 -2041,那不是限流,是上下文校验。
 *
 * @param {Array<{name:string, bookId:string, since?:number, knownIds?:string[]}>} accounts
 * @param {number} intervalMs 每个号之间的间隔,别调太小
 * @param {{initialArticleLimit?:number, forceHistoryLimit?:number, maxIncrementalPages?:number}} options
 */
export function buildFetchJs(accounts, intervalMs = 3000, options = {}) {
  const list = JSON.stringify(accounts.map((a) => [a.name, a.bookId, Number(a.since || 0), a.knownIds || []]));
  const initialLimit = Math.max(1, Number(options.initialArticleLimit || 50));
  const forceHistoryLimit = Math.max(0, Number(options.forceHistoryLimit || 0));
  const maxIncrementalPages = Math.max(1, Number(options.maxIncrementalPages || 8));
  return `(function(){
  var MPS = ${list};
  var GAP = ${Number(intervalMs)};
  var INITIAL_LIMIT = ${initialLimit};
  var FORCED_HISTORY_LIMIT = ${forceHistoryLimit};
  var MAX_INCREMENTAL_PAGES = ${maxIncrementalPages};
  var FALLBACK_PAGE_STEP = 20;

  function flatten(o){
    var out = [];
    (o.reviews || []).forEach(function(grp){
      // ⚠️ 一次群发 = 一个 reviews 条目,里面的 subReviews 才是一篇篇文章。
      //    只取 subReviews[0] 会丢掉同一次群发的其余文章(高频错误,有的号一天 3-4 篇)。
      (grp.subReviews || []).forEach(function(s){
        var r = s.review || {}, mi = r.mpInfo || {};
        if (!mi.title) return;
        // 微信读书把微信短链里的下划线转义为波浪号；直接拼接会得到微信 ret=-2 参数错误页。
        var originalId = String(mi.originalId || '').replace(/~/g, '_');
        out.push({
          t: r.createTime || grp.createTime || 0,
          title: mi.title,
          url: originalId ? ('https://mp.weixin.qq.com/s/' + originalId) : '',
          rid: r.reviewId || ''
        });
      });
    });
    out.sort(function(a,b){ return b.t - a.t; });
    return out;
  }

  function pause(){ return new Promise(function(ok){ setTimeout(ok, GAP); }); }

  function one(i, acc){
    if (i >= MPS.length) return Promise.resolve(acc);
    var name = MPS[i][0], bookId = MPS[i][1], since = Number(MPS[i][2] || 0);
    var known = {};
    (MPS[i][3] || []).forEach(function(id){ known[id] = true; });
    var fullHistory = FORCED_HISTORY_LIMIT > 0 || !since;
    var targetCount = FORCED_HISTORY_LIMIT || INITIAL_LIMIT;
    var offset = 0, page = 0, gathered = [], gatheredIds = {};

    function add(items){
      items.forEach(function(item){
        var key = item.rid || item.url || (item.t + ':' + item.title);
        if (!gatheredIds[key]) { gatheredIds[key] = true; gathered.push(item); }
      });
    }
    function finish(){
      var items = fullHistory ? gathered.slice(0, targetCount) : gathered;
      acc.push({name:name, bookId:bookId, items:items, pages:page, mode:fullHistory ? 'history' : 'incremental'});
      return pause().then(function(){ return one(i + 1, acc); });
    }
    function next(){
      return fetch('/web/mp/articles?bookId=' + bookId + '&offset=' + offset, {credentials:'include'})
        .then(function(r){ return r.json(); })
        .then(function(o){
          if (o.errCode) { acc.push({name:name, bookId:bookId, err:'errCode=' + o.errCode}); return pause().then(function(){ return one(i + 1, acc); }); }
          page += 1;
          var pageItems = flatten(o);
          if (fullHistory) add(pageItems);
          else add(pageItems.filter(function(item){
            var key = item.rid || item.url || (item.t + ':' + item.title);
            return item.t >= since && !known[key];
          }));
          var reachedKnownTime = !fullHistory && pageItems.some(function(item){ return item.t < since; });
          var exhausted = !pageItems.length || !(o.reviews || []).length;
          var enough = fullHistory && gathered.length >= targetCount;
          var pageLimit = !fullHistory && page >= MAX_INCREMENTAL_PAGES;
          if (enough || exhausted || reachedKnownTime || pageLimit) return finish();
          // offset 按接口返回的群发条目数前进；只有接口没给 reviews 时才退回默认页长，
          // 否则小页直接跳 20 会漏掉中间的历史群发。
          offset += (o.reviews || []).length || FALLBACK_PAGE_STEP;
          return pause().then(next);
        })
        .catch(function(e){ acc.push({name:name, bookId:bookId, err:String(e).slice(0,80)}); return pause().then(function(){ return one(i + 1, acc); }); });
    }
    return next();
  }

  return one(0, []).then(function(a){
    return JSON.stringify({onReader: location.pathname.indexOf('/web/mp/reader/') === 0, sources: a});
  });
})()`;
}

/**
 * 列出当前账号在微信读书里已订阅的公众号。
 *
 * 关键:返回里顺带给出每个号的 **readerUrl**。
 * 书架接口每个条目都带 deepLink,形如 `.../book-detail?type=1&v=<hash>`,
 * 而这个 `v` 和阅读器页 URL 尾部的那串 hash **完全相同**(实测逐字符一致)。
 * 所以 readerUrl = "https://weread.qq.com/web/mp/reader/" + v。
 *
 * 这条发现让用户不必再手动去浏览器地址栏复制 URL。
 * ⚠️ 那串 hash 不能自己拼:前后缀是**每个号各不相同**的校验位
 *    (实测同一账号下四个号的前缀两两不同,后缀也不同),
 *    照着一个号的前后缀给另一个号拼出来的 URL 打开是「加载失败」。
 *
 * 本接口在微信读书**首页**就能调用,不需要阅读器页上下文。
 */
export const LIST_SHELF_JS = `fetch("/web/shelf/sync?synckey=0&teenmode=0&album=1",{credentials:"include"})
  .then(function(r){return r.json()})
  .then(function(o){
    return JSON.stringify((o.books||[])
      .filter(function(b){ return String(b.bookId||"").indexOf("MP_WXS_") === 0 })
      .map(function(b){
        var m = String(b.deepLink||"").match(/[?&]v=([^&]+)/);
        return {
          name: b.title,
          bookId: b.bookId,
          readerUrl: m ? ("https://weread.qq.com/web/mp/reader/" + m[1]) : null
        };
      }));
  })`;

/**
 * 把公众号加进书架(订阅)。同样在首页就能调用。
 * 重复添加已在书架里的号是幂等的,不会出错。
 */
export function buildAddToShelfJs(bookIds) {
  return `fetch("/mp/shelf/addToShelf",{
    method:"POST", credentials:"include",
    headers:{"Content-Type":"application/json;charset=UTF-8"},
    body: JSON.stringify({bookIds: ${JSON.stringify(bookIds)}})
  }).then(function(r){ return r.text() })`;
}
