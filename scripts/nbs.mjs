// ============================================================
// 国家统计局「国家数据」CLI（年度数据）
//
// 用法:
//   node nbs.mjs --refresh                          # 建指标索引（约 1-3 分钟，之后走缓存）
//   node nbs.mjs "普通、职业本专科毕业生数"            # 指标名检索 + 打印时间序列
//   node nbs.mjs "毕业生" --cat 各级各类学校毕业生数    # 限定类目
//   node nbs.mjs "普通、职业本专科毕业生数" --year 2018
//   node nbs.mjs --list 教育                         # 列某大类下的类目
//   node nbs.mjs --headed                            # 有头调试
//
// 逆向要点 (2026-10-10 实测):
//   1. ⚠️ 站点已改版。旧版 easyquery.htm 被 WAF 封死：
//        403 Forbidden ... reason:UrlACL
//      新版入口 https://data.stats.gov.cn/dg/website/page.html#/pc/national/home
//   2. ⚠️ 新版有 **JS 挑战页**（"Please enable JavaScript and refresh the page"）。
//      纯 Node fetch 拿到的是挑战页 HTML，不是 JSON。必须：
//        · 用真实浏览器加载页面，让挑战脚本跑完
//        · 再在**页面上下文内**发请求
//      与 zxgk.mjs 同套路：stealth 参数 + 覆盖 UA + 页内 fetch。
//   3. 三个接口（均在 /dg/website/publicrelease/web/external/ 下）：
//        GET  new/queryIndexTreeAsync?pid=<父id>&code=3        指标树（pid 空=顶层）
//        GET  new/queryIndicatorsByCid?cid=<类目id>&dt=&name=   类目下指标
//        POST stream/esData                                     取数
//   4. esData 请求体（字段名必须完全一致，少一个就 500）：
//        {"cid","indicatorIds":[...],"daCatalogId":"",
//         "das":[{"text":"全国","value":"000000000000"}],
//         "showType":"1","dts":"","rootId":"884c062607104a91967b22742537f44f"}
//      rootId = 「年度数据」的 _id = 884c062607104a91967b22742537f44f
//      教育 _id = 7d6e10dffddf42a6821120b0b5cb93cd
//   5. 返回结构：树 {data:[{_id,name,isLeaf}]}；指标 {data:{total,list:[{_id,i_showname,ek,du_name}]}}；
//      数据 {data:[{name:"2018年", values:[{value,du_name}]}]}
//   6. ⚠️ 精度坑：esData 返回的是**按指标显示精度四舍五入后的字符串**。
//      例：「普通、职业本专科毕业生数」2018 返回 "753.3"（1 位小数），
//      真实值 753.3087。同表内不同指标精度不同（有的给 4 位）。
//      要精确值须交叉核对教育部统计公报。
// ============================================================

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';

// ---- 加载 playwright-core（本机浏览器只剩系统 Edge）----
const CANDIDATES = [
  'C:/Users/xianw/AppData/Roaming/npm/node_modules/@playwright/mcp/node_modules/playwright-core/index.js',
  'playwright-core',
];
let chromium = null;
for (const c of CANDIDATES) {
  try {
    const m = c.startsWith('C:') ? await import(pathToFileURL(c).href) : await import(c);
    chromium = (m.default ?? m).chromium;
    if (chromium) break;
  } catch { /* 下一个 */ }
}
if (!chromium) { console.error('找不到 playwright-core'); process.exit(1); }

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36 Edg/154.0.0.0';
const PAGE = 'https://data.stats.gov.cn/dg/website/page.html#/pc/national/home';
const PROFILE = process.env.NBS_PROFILE || 'C:/Users/xianw/.dsh/nbs-profile';
const CACHE = join(homedir(), '.dsh', 'nbs-index.json');
const ROOT_ID = '884c062607104a91967b22742537f44f';

const argv = process.argv.slice(2);
const has = (f) => argv.includes('--' + f);
const opt = (f, dflt = null) => { const i = argv.indexOf('--' + f); return i >= 0 ? argv[i + 1] : dflt; };
const kw = argv.find((a) => !a.startsWith('--') && argv[argv.indexOf(a) - 1]?.startsWith('--') !== true);
const headed = has('headed');

// ---- 页内 API 封装（通过 addInitScript 注入浏览器）----
// ⚠️ 必须写成**函数**并用 `page.addInitScript(fn, ...args)` 注入，原因有三：
//    1. 用 `page.evaluate(字符串)` 注入不稳定，且**页面一旦导航注入就丢失**
//       （曾导致 `window.__nbs` undefined 崩溃）；addInitScript 对每次导航都生效。
//    2. ⚠️ 浏览器上下文里**没有 `process`** —— 早期版本在 IIFE 里写
//       `Number(process.env.NBS_DELAY_CAT || 400)`，导致 IIFE 直接抛 ReferenceError、
//       `window.__nbs` 从未被赋值。**所有外部配置必须通过参数传入**，不能读 process.env。
//    3. 同理 ROOT_ID 也通过参数传（闭包变量在序列化后会丢失）。
const DLY_CAT = Number(process.env.NBS_DELAY_CAT || 400);
const DLY_GRP = Number(process.env.NBS_DELAY_GROUP || 900);

// ⚠️ addInitScript 只接受**一个**参数（传多个会报 "Too many arguments"），
//    所以配置统一包成一个对象传入。
function injectNbs(cfg) {
  const dlyCat = cfg.dlyCat, dlyGrp = cfg.dlyGrp, rootId = cfg.rootId;
  window.__nbs = (function () {
    const B = '/dg/website/publicrelease/web/external';
    const ROOT_ID = rootId;
    const H = { Accept: 'application/json' };
    const getJson = async (u) => {
      const r = await fetch(u, { headers: H });
      const t = await r.text();
      try { return JSON.parse(t); } catch { throw new Error('非JSON: ' + t.slice(0, 80)); }
    };
    const tree = async (pid) => {
      const j = await getJson(B + '/new/queryIndexTreeAsync?pid=' + encodeURIComponent(pid) + '&code=3');
      return (j.data || []).map((n) => ({ id: n._id, name: n.name }));
    };
    const inds = async (cid) => {
      const j = await getJson(B + '/new/queryIndicatorsByCid?cid=' + encodeURIComponent(cid) + '&dt=&name=');
      return ((j.data && j.data.list) || []).map((x) => ({ id: x._id, name: (x.i_showname || '').trim(), du: x.du_name, ek: x.ek }));
    };
    // ⚠️ 分省数据：das 里换成地区代码即可（实测 2026-10-17）
    //      das:[{text:'河南省', value:'410000000000'}] → 返回河南的分省序列
    //      value 用 12 位行政区划码（省 = 前2位 + 10个0），text 只作显示，可留空。
    const data = async (cid, ids, prov) => {
      const das = prov && prov.value
        ? [{ text: prov.text || '', value: prov.value }]
        : [{ text: '全国', value: '000000000000' }];
      const r = await fetch(B + '/stream/esData', {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json' }, H),
        body: JSON.stringify({ cid, indicatorIds: ids, daCatalogId: '', das, showType: '1', dts: '', rootId: ROOT_ID }),
      });
      const j = await r.json();
      const out = [];
      for (const d of (j.data || [])) {
        const v = (d.values || [])[0];
        if (v && v.value != null) out.push({ year: d.name, value: v.value, unit: v.du_name });
      }
      out.sort((a, b) => a.year.localeCompare(b.year));
      return out;
    };
    // ⚠️ 必须限速：实测连续 ~450 次请求后，站点会升级为「所有请求都返回 JS 挑战页」，
    //    连之前正常的浏览器会话也一起被拦，且需等待一段时间才恢复。
    //    故：① 间隔可调（默认 400/900ms）；② 支持按大类分批（--batch N / --only）。
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const DLY_CAT = dlyCat, DLY_GRP = dlyGrp;
    // onlyList: 要抓的大类名数组；传空/null = 全部
    // ⚠️ 返回 { idx, errors, emptyCats } —— **必须把失败显式报出来**。
    //    早期版本用 `.catch(() => [])` 吞掉异常，结果遇到风控时"静默抓到 0 条"，
    //    看起来成功、实际什么都没抓到 —— 这是比赛里最危险的失败模式。
    const buildIndex = async (onlyList) => {
      const idx = [];
      const errors = [];
      const emptyCats = [];
      const lvl2 = await tree(ROOT_ID);
      const want = Array.isArray(onlyList) && onlyList.length ? new Set(onlyList) : null;
      for (const c2 of lvl2) {
        if (want && !want.has(c2.name)) continue;
        // ⚠️ 必须区分两种情况：
        //    tree() 抛异常  → 接口返回挑战页/网络问题 → 真失败，记 error，下次重试
        //    tree() 返回 [] → 该大类**本身没有子类目**（如「社会消费品零售总额」）
        //                     → 不是失败，不该报错、也不该无限重试
        let lvl3;
        try { lvl3 = await tree(c2.id); }
        catch (e) { errors.push(`${c2.name}: 取类目树失败（${String(e).slice(0, 60)}）`); continue; }
        if (!lvl3.length) { emptyCats.push(c2.name); continue; }
        let okCnt = 0, failCnt = 0;
        for (const c3 of lvl3) {
          let list = [];
          try { list = await inds(c3.id); }
          catch { failCnt++; }
          if (list.length) okCnt++;
          for (const it of list) idx.push({ cat2: c2.name, cat3: c3.name, cid: c3.id, id: it.id, name: it.name, du: it.du, ek: it.ek });
          await sleep(DLY_CAT);
        }
        if (okCnt === 0) errors.push(`${c2.name}: 全部 ${lvl3.length} 个类目均失败（疑似触发风控）`);
        else if (failCnt > lvl3.length / 2) errors.push(`${c2.name}: 过半类目失败（${failCnt}/${lvl3.length}）`);
        await sleep(DLY_GRP);
      }
      return { idx, errors, emptyCats };
    };
    const listCats = async () => (await tree(ROOT_ID)).map((n) => n.name);
    return { tree, inds, data, buildIndex, listCats, ROOT_ID };
  })();
  return 'nbs-ready';
}

// ⚠️ 该站有 JS 挑战页，且**风控是按接口路径生效的**（实测）：
//      stream/esData                          → 通常可用（取数）
//      new/queryIndexTreeAsync                → 请求量大后会被拦（建索引用）
//      new/queryIndicatorsByCid               → 同上
//    因此**就绪探测不能依赖 tree 接口** —— 否则建索引被拦时，连"取数"也会被误判为不可用。
//    改为只探测「注入是否成功」；具体请求失败由调用方显式报错（不静默吞）。
async function openReady(profileDir) {
  const ctx = await chromium.launchPersistentContext(profileDir, {
    channel: 'msedge', headless: !headed, locale: 'zh-CN', userAgent: UA,
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const page = ctx.pages()[0] || await ctx.newPage();
  // addInitScript 对**每次导航**都生效，彻底避免"导航后注入丢失"
  await page.addInitScript(injectNbs, { dlyCat: DLY_CAT, dlyGrp: DLY_GRP, rootId: ROOT_ID });
  for (let attempt = 0; attempt < 4; attempt++) {
    await page.goto(PAGE, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(3000 + attempt * 2000);
    const ok = await page.evaluate(
      () => !!window.__nbs && typeof window.__nbs.listCats === 'function' && typeof window.__nbs.data === 'function'
    ).catch(() => false);
    if (ok) return { ctx, page };
    process.stderr.write(`[warn] 第 ${attempt + 1} 次注入未就绪，重试…\n`);
  }
  await ctx.close().catch(() => {});
  return null;
}

async function withPage(fn) {
  let s = await openReady(PROFILE);
  if (!s) {                                  // 换全新 profile 再试一轮
    const fresh = PROFILE + '-fresh-' + Date.now();
    process.stderr.write(`[warn] 换全新 profile：${fresh}\n`);
    s = await openReady(fresh);
  }
  if (!s) { console.error('无法通过 JS 挑战，请稍后重试或改用 --headed'); process.exit(3); }
  try {
    return await fn(s.page);
  } finally {
    await s.ctx.close().catch(() => {});
  }
}

const t0 = Date.now();

// ---------- 建索引 ----------
// --only <大类>    只抓指定大类（可重复，或逗号分隔）
// --refresh        只抓**尚未覆盖**的大类（真正的增量；不是重抓全部）
// --batch <N>      配合 --refresh：本次最多抓 N 个大类（防触发风控，可分多次跑）
// --missing        只列出还没抓的大类，不抓
if (has('refresh') || has('only') || has('missing')) {
  const existing = existsSync(CACHE) ? JSON.parse(readFileSync(CACHE, 'utf8')) : [];
  const covered = new Set(existing.map((r) => r.cat2));

  // ⚠️ tree/inds 类接口是**按路径限流**的：请求量大后被拦，返回 JS 挑战页。
  //    这里必须给出人话提示，而不是抛一段 HTML。
  let allCats;
  try {
    allCats = await withPage((page) => page.evaluate(() => window.__nbs.listCats()));
  } catch (e) {
    console.error('❌ 无法获取大类列表 —— 大概率是触发了风控（接口返回 JS 挑战页）。');
    console.error('   对策：等 3~10 分钟再试；期间"查询"功能（--year 等）通常仍可用。');
    console.error('   原始错误：' + String(e).replace(/\s+/g, ' ').slice(0, 160));
    process.exit(4);
  }

  let targets;
  if (has('only')) {
    targets = String(opt('only')).split(',').map((s) => s.trim()).filter(Boolean);
    const bad = targets.filter((t) => !allCats.includes(t));
    if (bad.length) {
      console.error(`(无此大类) ${bad.join(', ')}`);
      console.error('可选：' + allCats.join(' / '));
      process.exit(2);
    }
  } else {
    const missing = allCats.filter((c) => !covered.has(c));
    if (has('missing')) {
      console.log(`全部大类 ${allCats.length} 个，已覆盖 ${covered.size} 个，未覆盖 ${missing.length} 个：`);
      for (const m of missing) console.log('  ' + m);
      if (covered.size) { console.log('\n已覆盖：'); for (const c of covered) console.log('  ' + c); }
      process.exit(0);
    }
    // ⚠️ 安全默认：不带 --batch 时每次只抓 3 个大类。
    //    实测一次性抓 4+ 个大类会累积到风控阈值（~450 请求）而被封。
    //    要抓更多请显式传 --batch N（自行承担风险），或分多次运行。
    const batch = parseInt(opt('batch', '3'), 10);
    targets = batch > 0 ? missing.slice(0, batch) : missing;
    if (!targets.length) {
      console.log(`✅ 全部 ${allCats.length} 个大类均已覆盖，无需抓取。`);
      process.exit(0);
    }
    console.log(`未覆盖 ${missing.length} 个，本次抓取 ${targets.length} 个：${targets.join(' / ')}`);
    if (missing.length > targets.length) {
      console.log(`（剩余 ${missing.length - targets.length} 个：休息一会儿再跑一次，或加 --batch N）`);
    }
  }

  const res = await withPage((page) => page.evaluate(
    async (list) => await window.__nbs.buildIndex(list), targets));
  const fresh = res.idx || [];
  const errors = res.errors || [];
  const emptyCats = res.emptyCats || [];

  // 「本身就没有子类目」的大类：写一条哨兵记录标记已覆盖，避免每次 --refresh 都白跑一遍。
  // 哨兵 name 为空串，不会命中任何关键词检索，不污染查询结果。
  const sentinels = emptyCats.map((c) => ({ cat2: c, cat3: '', cid: '', id: '', name: '', du: '', ek: '', __empty: true }));

  // ⚠️ 只把**真正抓到数据**的大类算作"已覆盖"，失败的留在 missing 里下次重试。
  //    否则失败的大类会被标记为已覆盖，之后再也不会重抓（静默缺数据）。
  const cats = new Set([...fresh.map((r) => r.cat2), ...emptyCats]);
  const merged = existing.filter((r) => !cats.has(r.cat2)).concat(fresh, sentinels);
  mkdirSync(dirname(CACHE), { recursive: true });
  writeFileSync(CACHE, JSON.stringify(merged), 'utf8');

  if (emptyCats.length) {
    console.log(`\nℹ️ 以下大类本身没有子类目，已标记为已覆盖（不再重试）：${emptyCats.join(' / ')}`);
  }
  if (errors.length) {
    console.log('\n⚠️ 以下大类未抓全（下次 --refresh 会自动重试）：');
    for (const e of errors) console.log('   · ' + e);
  }
  console.log(`本次抓取 ${fresh.length} 条（${[...cats].join('/') || '无'}）；索引累计 ${merged.length} 条`);
  console.log(`大类覆盖 ${new Set(merged.map((r) => r.cat2)).size} / ${allCats.length} 个`);
  if (!kw && !has('list')) { console.log(`ELAPSED = ${((Date.now() - t0) / 1000).toFixed(1)}s`); process.exit(0); }
}

const idx = existsSync(CACHE) ? JSON.parse(readFileSync(CACHE, 'utf8')) : null;
if (!idx) { console.error('缺少索引。先运行: node nbs.mjs --refresh'); process.exit(1); }

if (has('list')) {
  const cat = opt('list');
  // 过滤掉哨兵记录（cat3 为空串，代表"该大类本身没有子类目"）
  const names = [...new Set(idx.filter((r) => r.cat2 === cat && r.cat3).map((r) => r.cat3))];
  if (!names.length) { console.log(`(无此大类) 可选：${[...new Set(idx.map(r=>r.cat2))].join(' / ')}`); process.exit(2); }
  console.log(`「${cat}」下的类目（${names.length}）:`);
  for (const n of names) console.log('  ' + n);
  process.exit(0);
}

if (!kw) { console.error('用法: node nbs.mjs "<指标关键词>" [--cat <类目>] [--year YYYY] [--json] | --list <大类> | --refresh'); process.exit(1); }

let hits = idx.filter((r) => r.name.includes(kw));
const cf = opt('cat');
if (cf) hits = hits.filter((r) => r.cat3.includes(cf));
if (!hits.length) { console.log(`(无匹配指标) 「${kw}」`); process.exit(2); }

console.log(`=== 匹配 ${hits.length} 个指标（取第 1 个）===`);
for (const h of hits.slice(0, 6)) console.log(`  [${h.cat2} > ${h.cat3}] ${h.name}`);

const target = hits[0];

// ---- 地区代码（分省数据）----
// 用法: --prov 河南   或   --prov 410000000000
const PROV_CODES = {
  北京: '110000000000', 天津: '120000000000', 河北: '130000000000', 山西: '140000000000',
  内蒙古: '150000000000', 辽宁: '210000000000', 吉林: '220000000000', 黑龙江: '230000000000',
  上海: '310000000000', 江苏: '320000000000', 浙江: '330000000000', 安徽: '340000000000',
  福建: '350000000000', 江西: '360000000000', 山东: '370000000000', 河南: '410000000000',
  湖北: '420000000000', 湖南: '430000000000', 广东: '440000000000', 广西: '450000000000',
  海南: '460000000000', 重庆: '500000000000', 四川: '510000000000', 贵州: '520000000000',
  云南: '530000000000', 西藏: '540000000000', 陕西: '610000000000', 甘肃: '620000000000',
  青海: '630000000000', 宁夏: '640000000000', 新疆: '650000000000',
};
const provArg = opt('prov');
let prov = null;
if (provArg) {
  const key = String(provArg).replace(/[省市自治区壮族回族维吾尔]/g, '');
  if (/^\d{12}$/.test(provArg)) {
    prov = { text: '', value: provArg };
  } else if (PROV_CODES[key]) {
    prov = { text: provArg, value: PROV_CODES[key] };
  } else {
    const k2 = Object.keys(PROV_CODES).find((k) => provArg.startsWith(k) || k.startsWith(key));
    if (k2) prov = { text: provArg, value: PROV_CODES[k2] };
  }
  if (!prov) {
    console.error(`(无此地区) ${provArg}`);
    console.error('可用：' + Object.keys(PROV_CODES).join(' / '));
    process.exit(2);
  }
}

const rows = await withPage((page) => page.evaluate(
  async ([cid, id, pv]) => await window.__nbs.data(cid, [id], pv), [target.cid, target.id, prov]));

if (has('json')) { console.log(JSON.stringify({ indicator: target.name, rows }, null, 2)); process.exit(0); }

console.log(`\n=== ${target.name} ${prov ? '[' + (prov.text || prov.value) + ']' : '[全国]'} ===`);
const wantYear = opt('year');
if (wantYear) {
  const r = rows.find((x) => x.year.startsWith(wantYear));
  console.log(r ? `  ${r.year} : ${r.value} ${r.unit || ''}` : `  (无 ${wantYear} 年数据)`);
} else {
  for (const r of rows) console.log(`  ${r.year} : ${r.value} ${r.unit || ''}`);
}
console.log(`ELAPSED = ${((Date.now()-t0)/1000).toFixed(1)}s`);
