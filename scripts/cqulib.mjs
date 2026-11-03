// ============================================================
// 重庆大学图书馆 · 纸本馆藏检索 CLI  —— cqulib.mjs
//
// 用途：题名 → 馆藏地名称 / 索书号 / 条码号 / 复本数 / 在馆状态。
//       对应题型：「《XXX》（某年，N 个复本）的馆藏地名称有哪些」
//
// 用法:
//   node cqulib.mjs --title "文明的冲突与世界秩序的重建"
//   node cqulib.mjs --title "文明的冲突" --year 2010
//   node cqulib.mjs --title "文明的冲突" --all          # 列出所有版本 + 各自馆藏
//   node cqulib.mjs --title "文明的冲突" --json
//
// 逆向笔记（实测 2026-10）——本站是「纯 JSON API」，可完全脱离浏览器：
//
//   ⚠️ 坑 0：直接 `fetch('http://lib.cqu.edu.cn/index')` 拿到的只是 2.4 KB 的 Vue 壳；
//      而**用 Playwright（带 msedge UA）访问会返回 403 Forbidden**。
//      反过来，Node fetch 带完整 Edg UA 头却可以拿到壳页 —— 真正的数据全在
//      `/gateway/...` JSON 接口里，所以本脚本**完全不用 Playwright**，只用 fetch。
//
//   ① 取令牌（匿名即可，无需登录）：
//        POST https://lib.cqu.edu.cn/jwt/api/Auth/AccessToken
//        Content-Type: application/json
//        body: {"orgCode":"cqu","OrgTokenLink":"https://lib.cqu.edu.cn/jwt/api/Auth/AccessToken"}
//        → data.token（JWT，约 2 小时有效）
//      之后所有 /gateway/* 请求带 `Authorization: Bearer <token>`。
//
//   ② 检索：
//        POST https://lib.cqu.edu.cn/gateway/articlesearch/api/search/asset-search@4
//        body 结构（这是网页端实际发的）：
//          {
//            "rule": { "ruleBody": "TKS=@TKS_x_0_f",
//                      "ruleParameters": [{ "key": "@TKS_x_0_f", "value": "<关键词>" }] },
//            "filterRule": { "ruleBody": "MO=[@MO_54774311_0_f][*](TY=[@TY_65711344_0_f][+]TY=[@TY_79389151_1_f])",
//                            "ruleParameters": [ {"key":"@MO_54774311_0_f","value":"1"},
//                                                {"key":"@TY_65711344_0_f","value":"1"},
//                                                {"key":"@TY_79389151_1_f","value":"2"} ] },
//            "requestAggsType": 1, "pageIndex": 1, "pageSize": 20, "keywords": "<关键词>"
//          }
//        → data.hits.total（命中数）/ data.hits.source[]（记录数组）
//
//      ⚠️ 坑 1（最坑）：**filterRule 里的 key 名必须原样照抄**（`@MO_54774311_0_f` 等）。
//         自己编一个 `@MO_11111111_0_f`、或者只保留 MO 去掉 TY，接口都直接返回
//         **HTTP 500 / statusCode 500**（无错误信息），极难排查。
//         也就是说：这个 filter 是「服务端预置模板」，只能整块用，不能裁剪。
//
//      ⚠️ 坑 2：`requestAggsType` 必须 = **1**。传 2 时 `hits.total` 有值但
//         `hits.source` 恒为空数组（前端靠它只取聚合，取记录会空）。
//
//      ⚠️ 坑 3：字段代码（来自 search-box-configure 接口，symbol → 中文）：
//         TKS 篇关摘 / T 标题 / K 关键词 / A 作者 / S 摘要 / O 作者单位 /
//         TS 丛书名 / P 出版物名称 / PU 出版社 / LC 中图分类号 / CC 学科分类号 /
//         F 基金 / BT 标题 / IB ISBN / BN 索书号 / DI DOI
//      实测：`T`（标题）配上面的 filter 时，**完整书名会命中 0 条**（分词+精确匹配问题），
//         换成短词（如「文明的冲突」）才返回图书列表；`TKS` 则能命中「摘要里提到书名」的书。
//         → 本脚本因此实现「逐级降级」：TKS 全名 → T 全名 → T 去书名号 → T 取前 6 字 → T 取前 4 字。
//
//   ③ 馆藏明细（关键一步，检索结果里**没有**馆藏地）：
//        POST https://lib.cqu.edu.cn/gateway/opac/api/search-collection-status/collection-status-by-ids
//        body: {"data":["<bookId>"],"pageIndex":1,"pageSize":10}
//        → data.data.displayColumns[]：每个元素
//             { title:"馆藏地名称", fieldName:"roomName", values:[...] }
//             { title:"馆藏地址", fieldName:"roomAddress", values:[...] }
//             { title:"索书号",  fieldName:"indexNumber", values:[...] }
//             { title:"条码号",  fieldName:"stripNumber", values:[...] }
//             { title:"状态",    fieldName:"stateName", values:[...] }
//          → **values 数组的下标 i 就是第 i 个复本**，长度即复本数。
//        bookId 来自检索结果的 `sourceCollection[0].bookId`（不是 `id`！`id` 是文章 id，
//        详情接口 /search/detail@4?id= 用的才是 id，两者别混）。
//
//   ④ 复本数 / 索书号：检索记录里的 `copy_cnt` / `call_num` 字段**是 null**，
//      必须从 ③ 的 displayColumns 里数数组长度、取 indexNumber 才准。
//
//   ⑤ 编码 UTF-8；⚠️ 不要用 process.exit()，用 process.exitCode。
//
// 实测验证（2026-10-18 实跑）：
//   题：《文明的冲突与世界秩序的重建》（2010年，6个复本）馆藏地名称
//   预期答案 BCD：社科阅览室 / 人文社科图书馆 / A区理工密集书库
//   ⚠️ 结果：**未能复现该题**。当前馆藏库里「文明的冲突」只有两个版本：
//       2013 版（bookId 2021386517747620）→ 2 个复本（人文社科图书馆 / 社科借阅）
//       2017 版（bookId 690619941921948611）→ 2 个复本（人文社科图书馆 / 社科借阅）
//      按作者「亨廷顿」全量 27 条里，2010 年的只有《谁是美国人?》《文化的重要作用》，
//      **没有 2010 版《文明的冲突与世界秩序的重建》，也没有 6 复本的记录**。
//      → 脚本链路（取 token → 检索 → 取 bookId → 拉馆藏明细 → 数复本数）**全部跑通**，
//        输出的是站点当前真实数据；该题答案可能与题库快照时点不一致，
//        或原题指的是其他版本/另一条书目记录。答题时以脚本实时输出为准。
//   另测：2017 版实跑输出 —— 复本数 2，馆藏地「人文社科图书馆 / 社科借阅」，
//        索书号 D5 2017 78，条码 CQU3780866(在馆) / CQU3780871(已借出)。
// ============================================================

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36 Edg/154.0.0.0';
const BASE = 'https://lib.cqu.edu.cn';

class Exit extends Error {
  constructor(code) { super('exit'); this.code = code; }
}
const done = (code = 0) => { throw new Exit(code); };

const argv = process.argv.slice(2);
const has = (f) => argv.includes('--' + f);
const opt = (f, d = null) => { const i = argv.indexOf('--' + f); return i >= 0 ? argv[i + 1] : d; };

const HDR = {
  'User-Agent': UA,
  'Content-Type': 'application/json',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'zh-CN,zh;q=0.9',
  'Origin': BASE,
  'Referer': BASE + '/index',
};

// 预置 filter 模板 —— key 名必须原样照抄，改一个字符就 500
const FILTER = {
  ruleBody: 'MO=[@MO_54774311_0_f][*](TY=[@TY_65711344_0_f][+]TY=[@TY_79389151_1_f])',
  ruleParameters: [
    { key: '@MO_54774311_0_f', value: '1' },   // MO=1 限定「馆藏纸本」
    { key: '@TY_65711344_0_f', value: '1' },   // TY=1 图书
    { key: '@TY_79389151_1_f', value: '2' },   // TY=2 期刊
  ],
};

async function getToken() {
  const r = await fetch(BASE + '/jwt/api/Auth/AccessToken', {
    method: 'POST',
    headers: HDR,
    body: JSON.stringify({ orgCode: 'cqu', OrgTokenLink: BASE + '/jwt/api/Auth/AccessToken' }),
  });
  const j = await r.json();
  const t = j?.data?.token;
  if (!t) throw new Error('取 token 失败: ' + JSON.stringify(j).slice(0, 200));
  return t;
}

async function search(token, field, kw, pageSize = 40) {
  const body = {
    aggsField: null, usePreference: false, sortTypes: '',
    rule: { ruleBody: `${field}=@Q_0_f`, ruleParameters: [{ key: '@Q_0_f', value: kw }] },
    filterRule: FILTER,
    sort: '', sortMode: null,
    searchFilterRule: { ruleBody: '', ruleParameters: [] },
    rf: { ruleBody: '', ruleParameters: [] },
    requestAggsType: 1,
    pageIndex: 1, pageSize,
    keywords: kw, useCE: null, useSynonym: null,
  };
  const r = await fetch(BASE + '/gateway/articlesearch/api/search/asset-search@4', {
    method: 'POST',
    headers: { ...HDR, Authorization: 'Bearer ' + token },
    body: JSON.stringify(body),
  });
  let j;
  try { j = await r.json(); } catch { return { status: r.status, total: null, items: [] }; }
  const d = j?.data || {};
  return { status: j.statusCode ?? r.status, total: d.hits?.total ?? null, items: d.hits?.source || [] };
}

// 馆藏明细：displayColumns 的 values 下标 = 复本序号
async function holdings(token, bookId) {
  const r = await fetch(BASE + '/gateway/opac/api/search-collection-status/collection-status-by-ids', {
    method: 'POST',
    headers: { ...HDR, Authorization: 'Bearer ' + token },
    body: JSON.stringify({ data: [String(bookId)], pageIndex: 1, pageSize: 20 }),
  });
  let j;
  try { j = await r.json(); } catch { return { copies: [], count: 0 }; }
  const inner = j?.data?.data || j?.data || {};
  const cols = inner.displayColumns || [];
  const by = {};
  for (const c of cols) by[c.fieldName] = c.values || [];
  const n = Math.max(0, ...Object.values(by).map((v) => v.length));
  const copies = [];
  for (let i = 0; i < n; i++) {
    copies.push({
      roomName: by.roomName?.[i] || '',
      roomAddress: by.roomAddress?.[i] || '',
      indexNumber: by.indexNumber?.[i] || '',
      stripNumber: by.stripNumber?.[i] || '',
      stateName: by.stateName?.[i] || '',
    });
  }
  return { copies, count: copies.length };
}

function bookIdOf(it) {
  return it?.sourceCollection?.[0]?.bookId || it?.bookId || '';
}

// 逐级降级检索：完整书名常常命中 0 条，必须缩短
function variants(title) {
  const clean = title.replace(/[《》〈〉"“”']/g, '').trim();
  const out = [];
  const push = (v) => { if (v && !out.includes(v)) out.push(v); };
  push(title); push(clean);
  if (clean.length > 8) push(clean.slice(0, 8));
  if (clean.length > 6) push(clean.slice(0, 6));
  if (clean.length > 4) push(clean.slice(0, 4));
  return out;
}

async function main() {
  if (has('help') || argv.length === 0) {
    console.log(`重庆大学图书馆 · 纸本馆藏检索 CLI

用法:
  node cqulib.mjs --title "文明的冲突与世界秩序的重建"
  node cqulib.mjs --title "文明的冲突" --year 2010
  node cqulib.mjs --title "文明的冲突" --all
  node cqulib.mjs --title "文明的冲突" --json

  --title <书名>   题名检索（自动降级短词）
  --year  <年>     只保留该出版年
  --all            列出全部命中版本（含各自馆藏）
  --json           机器可读`);
    done(argv.length === 0 ? 1 : 0);
  }

  const title = opt('title');
  if (!title) { console.error('需要 --title <书名>'); done(1); }
  const AS_JSON = has('json');
  const wantYear = opt('year');
  const all = has('all');

  const t0 = Date.now();
  const token = await getToken();

  // 1) 逐级降级找到非空结果（T 标题优先，TKS 兜底，最后用作者）
  let used = null;
  let items = [];
  for (const v of variants(title)) {
    for (const field of ['T', 'TKS']) {
      const r = await search(token, field, v);
      if (r.status === 200 && r.items.length) {
        used = { field, kw: v, total: r.total };
        items = r.items;
        break;
      }
    }
    if (items.length) break;
  }
  // 作者兜底（书名匹配不到时，用 --author 按作者拉全量再人工筛）
  if (!items.length && opt('author')) {
    const r = await search(token, 'A', opt('author'));
    if (r.status === 200 && r.items.length) {
      used = { field: 'A', kw: opt('author'), total: r.total };
      items = r.items;
    }
  }

  if (!items.length) {
    if (AS_JSON) console.log(JSON.stringify({ ok: false, title, ms: Date.now() - t0 }, null, 2));
    else console.log(`\n未检索到《${title}》的纸本馆藏（已尝试 ${variants(title).length * 2} 种检索式）`);
    done(2);
  }

  // 2) 按年份过滤（可选）
  let pick = items;
  if (wantYear) {
    const y = String(wantYear);
    const f = items.filter((it) => String(it.pub_year_display ?? it.pub_year ?? '') === y);
    if (f.length) pick = f;
  }

  // 3) 拉馆藏（--all 则全部版本，否则只取最匹配的前 3 条）
  const targets = all ? pick : pick.slice(0, 3);
  const out = [];
  for (const it of targets) {
    const bid = bookIdOf(it);
    const h = bid ? await holdings(token, bid) : { copies: [], count: 0 };
    out.push({
      title: it.title,
      year: it.pub_year_display ?? it.pub_year ?? '',
      author: it.author || '',
      publisher: it.publisher || '',
      isbn: it.isbn || '',
      bookId: bid,
      articleId: it.id,
      copyCount: h.count,
      copies: h.copies,
      locations: [...new Set(h.copies.map((c) => c.roomName).filter(Boolean))],
      callNumbers: [...new Set(h.copies.map((c) => c.indexNumber).filter(Boolean))],
    });
  }
  const ms = Date.now() - t0;

  if (AS_JSON) {
    console.log(JSON.stringify({ ok: true, title, used, results: out, ms }, null, 2));
    done(0);
  }

  console.log(`\n=== 重庆大学图书馆 · 纸本馆藏（检索式 ${used.field}="${used.kw}"，总命中 ${used.total}）===`);
  for (const r of out) {
    console.log(`\n  《${r.title}》  ${r.year}  ${r.author}`);
    console.log(`    出版: ${r.publisher}  ISBN: ${r.isbn}`);
    console.log(`    复本数: ${r.copyCount}   索书号: ${r.callNumbers.join(' / ') || '(无)'}`);
    if (r.locations.length) console.log(`    馆藏地: ${r.locations.join(' / ')}`);
    for (const c of r.copies) {
      console.log(`      - ${c.roomName} | ${c.indexNumber} | ${c.stripNumber} | ${c.stateName} | ${c.roomAddress}`);
    }
  }
  console.log(`\n耗时 ${(ms / 1000).toFixed(1)}s`);
  done(0);
}

main().catch((e) => {
  if (e instanceof Exit) { process.exitCode = e.code; return; }
  console.error(String((e && e.stack) || e).slice(0, 800));
  process.exitCode = 1;
});
