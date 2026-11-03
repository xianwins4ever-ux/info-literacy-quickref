// ============================================================
// 中国互联网联合辟谣平台 CLI —— piyao.mjs
//
// 用法:
//   node piyao.mjs --search 疫苗                    # 全站检索（标题）
//   node piyao.mjs --search 疫苗 --full             # 全文检索（content=）
//   node piyao.mjs --search 疫苗 --page 2 --size 20
//   node piyao.mjs --ft                             # 辟谣访谈列表（默认 35 条全量）
//   node piyao.mjs --ft --date 2023-12-15           # 按发布日期过滤（题目①就是这条）
//   node piyao.mjs --form                           # 谣言线索提交表单的字段限制（题目②）
//   node piyao.mjs --self-test                      # 跑两道模拟题
//
// ── 逆向笔记 ────────────────────────────────────────────────
// 1. ⚠️ **搜索页 frontsql.htm 只是个壳**。`/pysjk/frontsql.htm?kw=X` 返回的 HTML 里
//    没有任何结果，结果全靠 `/pysjk/rumer_search_https3.js` 里的 `getDate()` 发 AJAX。
//    真实接口（同源 Xinhua 搜索集群，JSONP 风格但直接 GET 就返回纯 JSON）：
//      https://so.news.cn/xhtvapp/rumourSearch
//        ?title=<kw>          ← 标题检索；换成 content=<kw> 就是全文检索
//        &pageNum=1&pageSize=10
//        &timeInterval=&startTime=&endTime=   ← 时间过滤（YYYY-MM-DD），空=不限
//        &typeName=           ← 分类
//        &sort=-2             ← 固定 -2
//        &callback=           ← 留空返回 JSON；填 cb 名返回 JSONP
//    返回 { code:200, content:{ totalCount, pageNum, pageSize, pageTotal,
//                               resultList:[{title,url,thirdCheckTime,summary,content,sourceDesc,typeDesc}] } }
//    注意 `title=` 与 `content=` 二选一（JS 里 isTitleKeyWorld 开关），同时传会互相干扰。
//
// 2. ⚠️ **辟谣访谈列表页 ft.htm 是 Xinhua "Xhwpage" 组件渲染的**，
//    首页只内联 20 条，滚动加载更多来自一个**静态 JSON**（不是 AJAX 接口）：
//      页面 DOM: <ul id="list" data="datasource:<32位id>">
//      数据文件: https://www.piyao.org.cn/ds_<32位id>.json
//    辟谣访谈当前 id = d525d824ec464b40bfc875309d1ec658（全量 35 条，一次拿完，
//    不用翻页）。⚠️ id 会随栏目改版变化，所以本脚本**每次都从 ft.htm 现抓 id**，
//    不硬编码，避免失效。
//    ⚠️ 早期条目的 title 字段里带 HTML（`<a href='...'>标题</a>`），
//    且 publishUrl 指向 xinhuanet.com —— 必须去标签 + HTML 实体解码后再输出。
//    ⚠️ publishTime 是"入库时间"而非"发布日期"，两者可能差 1 天
//    （如 2023-12-15 的访谈入库时间正是 2023-12-15，但 2023-12-16 两条
//    实际发布日期是 12-15）。按日期筛时用 publishTime 前 10 位即可，
//    实测与题目答案一致。
//
// 3. **谣言线索提交表单**在 `https://www.piyao.org.cn/xxjbrk.htm`（首页导航"举报入口"），
//    不是 /sq/（那是涉企专区）。限制写死在页面静态文案/placeholder 里：
//      · 附件：**上传附件不超过 10M，总数量不超过 10 个**，可用扩展名 jpg;png;jpeg
//        （input[type=file] 的 accept 里还多一个 .rar，但文案只写了三种图片）
//      · 内容正文 textarea placeholder：「请输入内容，字数不少于 20 字，不超过 1000 字」
//      · 标题 textarea placeholder：「25 个字以内」
//    题干里"不超过 5M""不超过 2000 字"都是错的 —— 正确是 10M / 1000 字。
//
// 4. 编码：本站 UTF-8，无 GBK 坑。全站可直连，无需 Playwright、无需登录。
//
// ── 模拟题实测（node piyao.mjs --self-test）──────────────────
//   题① 2023年12月15日发布的辟谣访谈包括（答案 AC）
//       实测输出：基层诊疗中的常见网络谣言 / 人工智能与网络辟谣：做真相的守护者
//       → 与 AC 一致 ✅
//   题② 关于谣言线索提交，说法不正确的是（答案 AD）
//       A 上传附件不超过5M      → 实际 10M      ⇒ A 错 ✅
//       D 输入内容字数不超过2000字 → 实际 1000 字 ⇒ D 错 ✅
// ============================================================

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36 Edg/154.0.0.0';
const BASE = 'https://www.piyao.org.cn';
const SEARCH_API = 'https://so.news.cn/xhtvapp/rumourSearch';

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
          'Accept': 'text/html,application/json,*/*;q=0.8',
          'Accept-Language': 'zh-CN,zh;q=0.9',
        },
        redirect: 'follow',
      });
      const buf = Buffer.from(await r.arrayBuffer());
      return { status: r.status, text: new TextDecoder('utf-8').decode(buf), bytes: buf.length };
    } catch (e) { last = e; await new Promise((s) => setTimeout(s, 800 * (i + 1))); }
  }
  throw last;
}

const stripTags = (s) => String(s || '')
  .replace(/<[^>]+>/g, '')
  .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&ldquo;/g, '“')
  .replace(/&rdquo;/g, '”').replace(/&amp;/g, '&')
  .replace(/\s+/g, ' ').trim();

// ---------- 1. 全站检索 ----------
async function search(kw, { full = false, page = 1, size = 10 } = {}) {
  const q = new URLSearchParams({
    [full ? 'content' : 'title']: kw,
    pageNum: String(page),
    pageSize: String(size),
    timeInterval: '', startTime: '', endTime: '',
    typeName: '', sort: '-2', callback: '',
  });
  const { status, text } = await get(`${SEARCH_API}?${q}`);
  let j;
  try { j = JSON.parse(text); } catch { console.log(`(接口返回非 JSON, HTTP ${status})`); console.log(text.slice(0, 400)); return null; }
  if (j.code !== 200) { console.log(`(接口 code=${j.code} ${j.message || ''})`); return null; }
  const c = j.content || {};
  const list = c.resultList || [];
  console.log(`\n=== 辟谣平台检索「${kw}」(${full ? '全文' : '标题'}) ===`);
  console.log(`命中 ${c.totalCount ?? 0} 篇 | 第 ${c.pageNum ?? 1}/${c.pageTotal ?? 1} 页 | 每页 ${c.pageSize ?? size}`);
  list.forEach((it, i) => {
    const date = String(it.thirdCheckTime || it.publishTime || '').slice(0, 10);
    const src = it.sourceDesc || it.sourceName || '';
    const cat = it.typeDesc || '';
    console.log(`${String(i + 1).padStart(2)}. [${date}] ${stripTags(it.title)}${cat ? '  <' + cat + '>' : ''}`);
    if (src) console.log(`      来源: ${src}`);
    if (it.url) console.log(`      ${it.url}`);
    const abs = stripTags(it.summary || '');
    if (abs) console.log(`      摘要: ${abs.slice(0, 90)}`);
  });
  return list;
}

// ---------- 2. 辟谣访谈列表（Xhwpage 静态数据源） ----------
async function fetchFtList() {
  const { status, text } = await get(`${BASE}/ft.htm`);
  if (status !== 200) throw new Error(`ft.htm HTTP ${status}`);
  // <ul id="list" ... data="datasource:<id>">
  const m = text.match(/id=["']list["'][^>]*data=["']datasource:([0-9a-f]{32})["']/i)
    || text.match(/data=["']datasource:([0-9a-f]{32})["']/i);
  if (!m) throw new Error('未在 ft.htm 中找到 datasource id（栏目可能改版）');
  const id = m[1];
  const { status: s2, text: t2 } = await get(`${BASE}/ds_${id}.json`);
  if (s2 !== 200) throw new Error(`ds_${id}.json HTTP ${s2}`);
  const j = JSON.parse(t2);
  const list = (j.datasource || []).map((it) => ({
    title: stripTags(it.showTitle || it.title),
    date: String(it.publishTime || '').slice(0, 10),
    time: it.publishTime || '',
    url: /^https?:/i.test(it.publishUrl || '') ? it.publishUrl : BASE + '/' + String(it.publishUrl || '').replace(/^\//, ''),
    source: it.sourceText || '',
  }));
  list.sort((a, b) => String(b.time).localeCompare(String(a.time)));
  return { id, list };
}

async function ft(dateFilter) {
  const { id, list } = await fetchFtList();
  const hit = dateFilter ? list.filter((x) => x.date === dateFilter) : list;
  console.log(`\n=== 辟谣访谈${dateFilter ? `（${dateFilter}）` : '（全量）'} ===`);
  console.log(`数据源: ${BASE}/ds_${id}.json | 共 ${list.length} 条${dateFilter ? `，该日 ${hit.length} 条` : ''}`);
  hit.forEach((x, i) => {
    console.log(`${String(i + 1).padStart(2)}. [${x.date}] ${x.title}`);
    console.log(`      ${x.url}`);
  });
  if (dateFilter && !hit.length) console.log('  (该日期无条目 —— 注意 publishTime 是入库时间，可试前后一天)');
  return hit;
}

// ---------- 3. 举报/线索提交表单限制 ----------
async function form() {
  const { status, text } = await get(`${BASE}/xxjbrk.htm`);
  if (status !== 200) throw new Error(`xxjbrk.htm HTTP ${status}`);
  const pick = (re) => { const m = text.match(re); return m ? stripTags(m[0]) : null; };
  const attach = pick(/上传附件不超过[^<]{0,40}/) || pick(/注：上传附件[^<]{0,60}/);
  const exts = pick(/可用扩展名[：:][^<]{0,40}/);
  const areas = [...text.matchAll(/<textarea[^>]*placeholder=["']([^"']*)["']/gi)].map((m) => m[1]);
  const fileAccept = [...text.matchAll(/<input[^>]*type=["']file["'][^>]*accept=["']([^"']+)["']/gi)].map((m) => m[1]);
  console.log('\n=== 谣言线索提交表单限制（xxjbrk.htm） ===');
  console.log(`附件:      ${attach || '(未找到)'}`);
  console.log(`扩展名:    ${exts || fileAccept.join(' / ') || '(未找到)'}`);
  console.log('文本框:');
  areas.filter(Boolean).forEach((a, i) => console.log(`  ${i + 1}. ${a}`));
  // 结论化输出（题目直接要用）
  const maxM = (attach || '').match(/(\d+)\s*M/i);
  const maxN = (attach || '').match(/不超过\s*(\d+)\s*个/);
  const body = areas.find((a) => /字数/.test(a)) || '';
  const w1 = body.match(/不少于\s*(\d+)\s*字/);
  const w2 = body.match(/不超过\s*(\d+)\s*字/);
  console.log('\n--- 结论 ---');
  console.log(`附件单文件上限: ${maxM ? maxM[1] + 'M' : '?'}   数量上限: ${maxN ? maxN[1] + '个' : '?'}`);
  console.log(`正文字数: 不少于 ${w1 ? w1[1] : '?'} 字，不超过 ${w2 ? w2[1] : '?'} 字`);
  const title = areas.find((a) => /个字以内/.test(a));
  if (title) console.log(`标题: ${title}`);
  return { attach, exts, areas, maxM: maxM && maxM[1], maxN: maxN && maxN[1], minWords: w1 && w1[1], maxWords: w2 && w2[1] };
}

// ---------- 4. 自测 ----------
async function selfTest() {
  const t0 = Date.now();
  console.log('########## 模拟题①：2023年12月15日发布的辟谣访谈 ##########');
  const hit = await ft('2023-12-15');
  const titles = hit.map((x) => x.title);
  const want = ['基层诊疗中的常见网络谣言', '人工智能与网络辟谣：做真相的守护者'];
  const ok1 = want.every((w) => titles.some((t) => t.includes(w)));
  console.log(`\n[判定] 期望含「${want.join(' / ')}」`);
  console.log(`[判定] ${ok1 ? '✅ 与答案 AC 一致' : '❌ 不一致'}`);

  console.log('\n########## 模拟题②：谣言线索提交说法 ##########');
  const f = await form();
  const aOk = f.maxM === '10';      // A 说 5M → 错
  const dOk = f.maxWords === '1000'; // D 说 2000 字 → 错
  console.log(`\n[判定] A「不超过5M」→ 实际 ${f.maxM}M ⇒ 该说法${aOk ? '错误 ✅' : '?'}`);
  console.log(`[判定] D「不超过2000字」→ 实际 ${f.maxWords}字 ⇒ 该说法${dOk ? '错误 ✅' : '?'}`);
  console.log(`[判定] ${aOk && dOk ? '✅ 与答案 AD 一致（两项都是错的）' : '❌ 与答案不符'}`);
  console.log(`\n耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  return ok1 && aOk && dOk;
}

async function main() {
  if (has('self-test')) { await selfTest(); return; }
  if (has('form')) { await form(); return; }
  if (has('ft')) { await ft(opt('date')); return; }
  const kw = opt('search') || opt('kw') || opt('q');
  if (kw) {
    await search(kw, { full: has('full'), page: Number(opt('page', '1')), size: Number(opt('size', '10')) });
    return;
  }
  console.log(`中国互联网联合辟谣平台 CLI

用法:
  node piyao.mjs --search <关键词> [--full] [--page N] [--size N]
  node piyao.mjs --ft [--date 2023-12-15]
  node piyao.mjs --form
  node piyao.mjs --self-test

  --search  全站检索（默认标题；--full 走全文）
  --ft      辟谣访谈列表（按日期倒序，一次拿全量）
  --date    配合 --ft，按发布日 YYYY-MM-DD 过滤
  --form    谣言线索提交表单的附件/字数限制`);
  done(1);
}

main().catch((e) => {
  if (e instanceof Exit) { process.exitCode = e.code; return; }
  console.error('ERROR:', String(e && e.message || e).slice(0, 300));
  process.exitCode = 1;
});
