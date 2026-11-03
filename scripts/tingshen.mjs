// ============================================================
// 中国庭审公开网 CLI —— tingshen.mjs
//
// 用法:
//   node tingshen.mjs --no 川1703民初3924号          # 按案号检索（题目就是这个）
//   node tingshen.mjs --kw 金融借款合同纠纷          # 按案件名/法官名检索
//   node tingshen.mjs --no 川1703民初3924号 --page 2
//   node tingshen.mjs --self-test                    # 跑模拟题
//
// ── 逆向笔记 ────────────────────────────────────────────────
// 1. **普通检索接口是 GET，直连可用（无需登录、无 WAF）**：
//      http://tingshen.court.gov.cn/search/common
//        ?keywords=<案号或案件名或法官名>&pageNumber=1&pageSize=15&extType=
//    返回**服务端渲染的 HTML**（不是 JSON），结果在：
//      <div class="public-header2"><span class="tip">共有 <em>N</em> 场相关庭审</span>
//      <li class="public-result-info">
//        <span class="time">2021-09-16 14:40</span>
//        <span class="lead">[ 庭审回顾 ]</span>
//        <a class="case-mark">民事</a>
//        <a href="/live/23283151" class="title">金融借款合同纠纷</a>
//        <div class="info-court"><a href="/court/3117">达州市达川区人民法院</a>
//                                <span class="judge">审判员：何琼(副庭长)</span>
//    注意：**案号本身不在结果里显示**，只出现在检索条件里；结果只给 时间/类型/案由/
//    法院/法官/详情链接。所以"按案号查案件"= 用案号当 keywords，靠"命中 N 场"定位。
//
// 2. ⚠️ **高级检索（按案号精确字段）必须登录**：
//      /search/advance/common 的表单有 caseNo / caseCause / courtName / beginTime /
//      endTime / durationType(时长区间) / judge / cbr / party 等字段，
//      但点"检索"会弹「使用高级检索 请先登录 免费注册」遮罩，请求根本发不出去。
//      ⇒ 本脚本**只走普通检索**，用案号当关键词达到同样效果。
//      ⚠️ 反复点高级检索还会触发「由于操作过于频繁，请 5:00 后重新使用高级检索」限流。
//
// 3. ⚠️⚠️ **视频时长拿不到（未打通）**：详情页 `/live/<id>` 被 WAF 拦截。
//      · 纯 fetch：返回 HTTP 405 或 200 但只有一段 `var requestInfo = {...}` 的
//        瑞数/CF 类反爬壳（16KB，无任何案件内容）
//      · Playwright headless(msedge)：跳转到「滑动验证页面 / 访问验证」，
//        需拖滑块；且二次访问直接 net::ERR_HTTP_RESPONSE_CODE_FAILURE
//      · Playwright headed：同样卡在滑块，未做自动破解
//    ⇒ 本题"视频时长 30分40秒"这一项**无法用脚本验证**。
//      结果列表页不含时长，只有进详情页才有。
//      **人工兜底**：把脚本输出的 /live/<id> 链接在浏览器里打开，页面右侧
//      "庭审时长"字段即为答案；或看播放器总时长。
//
// 4. 首页 173KB 可直连，但「今日公开案件数」等统计是 JS 数字滚动，静态抓不到。
//
// ── 模拟题实测（node tingshen.mjs --self-test）────────────────
//   题：案号"川1703民初3924号"的案件视频时长为 30分40秒（答案 B 错误）
//   实测：检索 ✅ 命中 1 场
//         2021-09-16 14:40 | 庭审回顾 | 民事 | 金融借款合同纠纷
//         达州市达川区人民法院 | 审判员：何琼(副庭长) | /live/23283151
//         时长 ❌ 未取到（详情页被 WAF 滑块拦截）
//   ⇒ 只能确认"该案号存在且唯一"，**无法判定 30分40秒 对错**。
// ============================================================

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36 Edg/154.0.0.0';
const BASE = 'http://tingshen.court.gov.cn';

class Exit extends Error { constructor(c) { super('exit'); this.code = c; } }
const done = (code = 0) => { throw new Exit(code); };
const argv = process.argv.slice(2);
const has = (f) => argv.includes('--' + f);
const opt = (f, d = null) => { const i = argv.indexOf('--' + f); return i >= 0 ? argv[i + 1] : d; };

async function get(url, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, {
        headers: {
          'User-Agent': UA,
          'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
          'Accept-Language': 'zh-CN,zh;q=0.9',
          'Referer': BASE + '/',
        },
        redirect: 'follow',
      });
      const buf = Buffer.from(await r.arrayBuffer());
      return { status: r.status, text: new TextDecoder('utf-8').decode(buf), bytes: buf.length };
    } catch (e) { last = e; await new Promise((s) => setTimeout(s, 800 * (i + 1))); }
  }
  throw last;
}

const decode = (s) => String(s || '')
  .replace(/<[^>]+>/g, '')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .replace(/\s+/g, ' ').trim();

function parseResults(html) {
  const total = Number((html.match(/共有\s*<em>\s*(\d+)\s*<\/em>\s*场相关庭审/) || [])[1] || 0);
  const items = [];
  const blocks = html.split('<li class="public-result-info">').slice(1);
  for (const b of blocks) {
    const time = decode((b.match(/<span class="time">([\s\S]*?)<\/span>/) || [])[1]);
    const lead = decode((b.match(/<span class="lead">([\s\S]*?)<\/span>/) || [])[1]);
    const cat = decode((b.match(/<a class="case-mark[^"]*">([\s\S]*?)<\/a>/) || [])[1]);
    const href = (b.match(/<a href="(\/live\/\d+)" class="title"/) || [])[1] || '';
    const title = decode((b.match(/<a href="\/live\/\d+" class="title"[^>]*>([\s\S]*?)<\/a>/) || [])[1]);
    const court = decode((b.match(/<a href="\/court\/\d+"[^>]*>([\s\S]*?)<\/a>/) || [])[1]);
    const courtHref = (b.match(/<a href="(\/court\/\d+)"/) || [])[1] || '';
    const judge = decode((b.match(/<span class="judge"[^>]*>([\s\S]*?)<\/span>/) || [])[1]);
    if (!title && !href) continue;
    items.push({ time, lead, cat, title, court, courtHref, judge, url: href ? BASE + href : '' });
  }
  return { total, items };
}

async function searchByKeywords(kw, page = 1, size = 15) {
  const q = new URLSearchParams({ keywords: kw, pageNumber: String(page), pageSize: String(size), extType: '' });
  const { status, text, bytes } = await get(`${BASE}/search/common?${q}`);
  console.log(`\n=== 中国庭审公开网检索「${kw}」 ===`);
  console.log(`HTTP ${status} | ${bytes} 字节 | 第 ${page} 页 / 每页 ${size}`);
  if (status !== 200) { console.log('(检索失败)'); return { total: 0, items: [] }; }
  const { total, items } = parseResults(text);
  console.log(`共有 ${total} 场相关庭审${items.length ? `，本页 ${items.length} 条` : ''}`);
  if (!items.length) {
    const m = text.match(/没有找到[\s\S]{0,60}/);
    if (m) console.log('  ' + decode(m[0]));
  }
  items.forEach((it, i) => {
    console.log(`\n${String(i + 1).padStart(2)}. [${it.time}] ${it.lead} ${it.cat ? '| ' + it.cat : ''}`);
    console.log(`    案由: ${it.title || '(无)'}`);
    console.log(`    法院: ${it.court || '(无)'}${it.courtHref ? '  ' + BASE + it.courtHref : ''}`);
    if (it.judge) console.log(`    法官: ${it.judge}`);
    console.log(`    详情: ${it.url}`);
  });
  return { total, items };
}

// 尝试从详情页拿时长（大概率被 WAF 拦，返回 null）
async function tryDuration(liveUrl) {
  try {
    const { status, text } = await get(liveUrl, 1);
    if (status !== 200) return { ok: false, why: `HTTP ${status}` };
    if (/滑动验证|访问验证|requestInfo\s*=\s*\{/.test(text) && text.length < 20000) {
      return { ok: false, why: '被 WAF 拦截（返回验证页/反爬壳）' };
    }
    const m = text.match(/庭审时长[^0-9]{0,40}(\d{1,3})\s*(?:分钟|分)(?:[^0-9]{0,10}(\d{1,2})\s*秒)?/)
      || text.match(/(\d{1,2}):(\d{2}):(\d{2})/);
    return m ? { ok: true, raw: decode(m[0]) } : { ok: false, why: '页面无时长字段' };
  } catch (e) { return { ok: false, why: String(e.message || e).slice(0, 60) }; }
}

async function selfTest() {
  const t0 = Date.now();
  console.log('########## 模拟题：案号「川1703民初3924号」视频时长（答案 B 错误）##########');
  const { total, items } = await searchByKeywords('川1703民初3924号');
  const okSearch = total >= 1 && items.length >= 1;
  console.log(`\n[判定] 案号检索: ${okSearch ? `✅ 命中 ${total} 场` : '❌ 未命中'}`);
  let dur = { ok: false, why: '无详情链接' };
  if (items[0] && items[0].url) {
    dur = await tryDuration(items[0].url);
    console.log(`[判定] 视频时长: ${dur.ok ? '✅ ' + dur.raw : '❌ 未取到 — ' + dur.why}`);
  }
  console.log(`[判定] ${okSearch && dur.ok ? '✅ 可完整验证题目' : '⚠️ 仅能确认案号存在，时长需人工开链接查看'}`);
  console.log(`\n耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  return okSearch && dur.ok;
}

async function main() {
  if (has('self-test')) { await selfTest(); return; }
  const no = opt('no') || opt('case-no');
  const kw = opt('kw') || opt('keywords');
  const q = no || kw;
  if (q) {
    const r = await searchByKeywords(q, Number(opt('page', '1')), Number(opt('size', '15')));
    if (r.items[0] && has('duration')) {
      const d = await tryDuration(r.items[0].url);
      console.log(`\n时长: ${d.ok ? d.raw : '未取到 — ' + d.why}`);
    }
    return;
  }
  console.log(`中国庭审公开网 CLI

用法:
  node tingshen.mjs --no <案号>            # 按案号检索（推荐）
  node tingshen.mjs --kw <案件名/法官名>   # 按关键词检索
  node tingshen.mjs --no <案号> --duration # 额外尝试抓详情页时长（大概率被 WAF 拦）
  node tingshen.mjs --self-test

说明:
  · 高级检索（精确案号字段）必须登录，本脚本走普通检索，效果等价。
  · 视频时长只在 /live/<id> 详情页，该页有 WAF 滑块，脚本拿不到；
    请把输出的详情链接在浏览器打开人工看"庭审时长"。`);
  done(1);
}

main().catch((e) => {
  if (e instanceof Exit) { process.exitCode = e.code; return; }
  console.error('ERROR:', String(e && e.message || e).slice(0, 300));
  process.exitCode = 1;
});
