// ============================================================
// 国家药品监督管理局 数据查询 CLI（医疗器械 / 药品通用）
//
// 用法:
//   node nmpa.mjs "国械注准20163401733"
//   node nmpa.mjs "上海荣盛生物药业股份有限公司"
//   node nmpa.mjs "国械注准20163401733" --all        # 同时查现行库+历史库
//   node nmpa.mjs "国械注准20163401733" --ds 历史     # 只查历史库
//
// 逆向要点 (2026-10-10 实测):
//   1. 站点已迁移: www.nmpa.gov.cn/datasearch → datasearch.nmpa.gov.cn/datasearch
//      旧地址会跳到 /datasearch/url_change.html。裸访问根路径 403，必须带完整路径。
//   2. 三个接口（全 GET）:
//        /datasearch/data/nmpadata/search      列表
//        /datasearch/data/nmpadata/countNums   计数
//        /datasearch/data/nmpadata/queryDetail 详情
//      ⚠️ search 用【单数】itemId；countNums 用【复数】itemIds —— 写错报 404/参数为空。
//   3. 必须带三个请求头，否则 500：
//        timestamp: <毫秒>
//        sign:      md5( encodeURIComponent( qs + '&' + appSecret ) )
//        token:     'false'（未登录）
//      其中 qs 是把参数【按 key 字典序】拼成 k=v&k=v（不含 sign/token），
//      appSecret 明文写在页面全局 window.appSecret = "nmpasecret2020"。
//   4. 返回是【列式】结构：f0=注册证编号 f1=注册人名称 f2=产品名称 f3=详情id。
//      列含义由 config/<itemId>.json 定义，各库不同。
//   5. 数据集 itemId（从首页下拉框选中时抓 config 请求得到）：
//        境内医疗器械（注册）           ff80808183cad7500183cb66fe690285
//        境内医疗器械（注册历史数据）   ff80808183cad7500183cb676ebf02b0
//      ⚠️ 关键：过期的注册证会从「注册」库移到「历史数据」库。
//         查不到时先换库，别以为没这个证。
//   6. 纯 Node 可跑，无需浏览器（无瑞数/无验证码）。
// ============================================================

import { createHash } from 'node:crypto';
import { playwrightCandidates, isFsPath, resolveProfile } from './_env.mjs';

const SECRET = 'nmpasecret2020';
const BASE = 'https://datasearch.nmpa.gov.cn/datasearch/data/nmpadata/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36 Edg/154.0.0.0';

const DATASETS = {
  current: { id: 'ff80808183cad7500183cb66fe690285', name: '境内医疗器械（注册）' },
  history: { id: 'ff80808183cad7500183cb676ebf02b0', name: '境内医疗器械（注册历史数据）' },
};

const md5 = (s) => createHash('md5').update(s, 'utf8').digest('hex');

// 参数按 key 字典序拼 qs（对齐页面 getSign 的行为）
function buildQs(params) {
  return Object.keys(params).sort()
    .map((k) => `${k}=${params[k]}`)
    .join('&');
}

// ⚠️ 坑：页面 jsonMD5ToStr 的替换发生在 encodeURIComponent **之后**（顺序搞反就签名失败）。
//   原生 encodeURIComponent 不编码 ( ) ! ~，所以编码完再把这四个字符换成 %XX。
//     md5( encodeURIComponent(qs + '&' + secret)
//            .replace(/\(/g,'%28').replace(/\)/g,'%29')
//            .replace(/!/g,'%21').replace(/~/g,'%7E') )
//   实测：公司名等纯中文检索值「先替换后编码」也能过，但含半角括号时必失败 —— 会报
//   「对不起，请求签名验证失败!」。
function makeSign(qs) {
  const s = encodeURIComponent(qs + '&' + SECRET)
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29')
    .replace(/!/g, '%21')
    .replace(/~/g, '%7E');
  return md5(s);
}

// ---- 浏览器回退（当纯 Node fetch 被 WAF 拦时启用）----
// ⚠️ 2026-10-10 实测：NMPA 的 WAF 会**按客户端类型**区别对待：
//      浏览器内 fetch  → 200 JSON ✅
//      纯 Node fetch   → **412 Precondition Failed** ❌（即使 UA/Referer 都伪装了）
//    所以本 CLI 的策略是：**先试纯 Node（快，~3s）；失败再自动回退到浏览器**。
//    浏览器路径同样使用上面逆向出的签名算法，只是把请求放到页面上下文里发。
let _browserCtx = null;

async function getBrowserPage() {
  if (_browserCtx) return _browserCtx.page;
  const { pathToFileURL } = await import('node:url');
  const CANDIDATES = [...playwrightCandidates(), 'playwright-core'];
  let chromium = null;
  for (const c of CANDIDATES) {
    try {
      const m = isFsPath(c) ? await import(pathToFileURL(c).href) : await import(c);
      chromium = (m.default ?? m).chromium;
      if (chromium) break;
    } catch { /* 下一个 */ }
  }
  if (!chromium) throw new Error('找不到 playwright-core，无法回退到浏览器');

  const ctx = await chromium.launchPersistentContext(
    resolveProfile('nmpa-profile', 'NMPA_PROFILE'),
    {
      channel: 'msedge', headless: true, locale: 'zh-CN', userAgent: UA,
      // ⚠️⚠️ 只加这个启动参数，**绝对不要**再用 addInitScript 去改 navigator.webdriver！
      //   实测三组对照（同一请求，只改浏览器配置）：
      //     无 stealth 参数                        → navigator.webdriver = true      → 400 ❌
      //     stealth 参数 + addInitScript 改成 undefined → navigator.webdriver = undefined → 400 ❌
      //     **仅 stealth 参数**                     → navigator.webdriver = false     → 200 ✅
      //   即：**用 defineProperty 篡改 webdriver 反而会被 WAF 识破**（属性存在但值为 undefined
      //   是个明显的异常特征）。`--disable-blink-features=AutomationControlled` 让它自然变成
      //   `false` 才是正常浏览器的样子。
      //   （注意：万方那边需要 addInitScript，各站策略不同，不要盲目统一。）
      args: ['--disable-blink-features=AutomationControlled'],
    });
  const page = ctx.pages()[0] || await ctx.newPage();
  await page.goto('https://datasearch.nmpa.gov.cn/datasearch/home-index.html',
    { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(3500);
  _browserCtx = { ctx, page };
  return page;
}

async function closeBrowser() {
  if (_browserCtx) { await _browserCtx.ctx.close().catch(() => {}); _browserCtx = null; }
}

async function apiViaBrowser(path, params) {
  const page = await getBrowserPage();

  // ⚠️ 关键保护：必须先确认页面真的在 NMPA 域下。
  //    若 goto 未完成/被跳走，相对路径 fetch 会解析到错误的 origin，
  //    表现为 **HTTP 400 + 空 body**（WAF 直接拒）。
  const cur = page.url();
  if (!cur.includes('datasearch.nmpa.gov.cn')) {
    await page.goto('https://datasearch.nmpa.gov.cn/datasearch/home-index.html',
      { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(3000);
  }
  const now = page.url();
  if (!now.includes('datasearch.nmpa.gov.cn')) {
    throw new Error(`浏览器未停在 NMPA 域（当前 ${now.slice(0, 60)}），无法发请求`);
  }

  const p = { ...params, timestamp: String(Date.now()) };
  const qs = buildQs(p);
  const sign = makeSign(qs);
  const out = await page.evaluate(async ([pathname, query, sig, ts]) => {
    const url = '/datasearch/data/nmpadata/' + pathname + '?' + query;
    const r = await fetch(url, {
      headers: { Accept: 'application/json, text/plain, */*', timestamp: ts, sign: sig, token: 'false' },
    });
    const t = await r.text();
    try { return { json: JSON.parse(t) }; }
    catch { return { err: `非JSON(${r.status}): ${t.slice(0, 100)}`, status: r.status, url: url.slice(0, 160) }; }
  }, [path, qs, sign, p.timestamp]);

  if (out.err) throw new Error(`${out.err} | url=${out.url}`);
  return out.json;
}

async function api(path, params) {
  const p = { ...params, timestamp: String(Date.now()) };
  const qs = buildQs(p);
  const url = BASE + path + '?' + qs;
  const res = await fetch(url, {
    headers: {
      Accept: 'application/json, text/plain, */*',
      timestamp: p.timestamp,
      sign: makeSign(qs),
      token: 'false',
      'User-Agent': UA,
      Referer: 'https://datasearch.nmpa.gov.cn/datasearch/home-index.html',
    },
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON */ }
  if (json) return json;

  // 纯 Node 被拦（典型：412 + HTML 挑战页）→ 自动回退到浏览器重试一次
  process.stderr.write(`[fallback] 纯 Node 被拦（HTTP ${res.status}），改用浏览器重试…\n`);
  return await apiViaBrowser(path, params);
}

async function search(ds, keyword, pageSize = 20) {
  const j = await api('search', {
    itemId: ds.id, isSenior: 'N', searchValue: keyword, pageNum: 1, pageSize,
  });
  if (j.code !== 200) throw new Error(j.message || `code=${j.code}`);
  const d = j.data || {};
  const list = d.list || d.rows || [];
  return { total: d.total ?? d.totalSize ?? list.length, rows: list };
}

// ---------- CLI ----------
const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith('--')));
const keyword = argv.find((a) => !a.startsWith('--'));
const dsFlag = argv.includes('--ds') ? argv[argv.indexOf('--ds') + 1] : null;

if (!keyword) {
  console.error('用法: node nmpa.mjs "<注册证编号|注册人名称|产品名称>" [--all] [--ds 历史|现行]');
  process.exit(1);
}

let targets;
if (dsFlag) {
  targets = [String(dsFlag).includes('历史') ? DATASETS.history : DATASETS.current];
} else if (flags.has('--all')) {
  targets = [DATASETS.current, DATASETS.history];
} else {
  targets = [DATASETS.current, DATASETS.history]; // 默认两个都查，避免漏掉已过期的证
}

let hit = 0;
let failed = 0;          // 请求层面失败（412/超时等）的库数
let queried = 0;         // 成功拿到应答的库数
const t0 = Date.now();
for (const ds of targets) {
  let r;
  try {
    r = await search(ds, keyword);
    queried++;
  } catch (e) {
    failed++;
    console.error(`[${ds.name}] ❌ 查询失败: ${String(e.message).slice(0, 120)}`);
    continue;
  }
  console.log(`=== ${ds.name} | 命中 ${r.total} 条 ===`);
  if (!r.total) { console.log('  (无记录)'); continue; }
  for (const x of r.rows) {
    hit++;
    console.log(`  ${x.f0 || '-'}`);
    console.log(`      注册人 : ${x.f1 || '-'}`);
    console.log(`      产品名 : ${x.f2 || '-'}`);
    console.log(`      详情id : ${x.f3 || '-'}`);
  }
}
console.log(`ELAPSED = ${((Date.now() - t0) / 1000).toFixed(1)}s`);
await closeBrowser();

// ⚠️ 必须把「被拦截」和「真的查无此证」区分开。
//    早期版本无论何种原因没命中，都打印"两个库都无记录"——
//    遇到 412 风控时会**把拦截伪装成"查无此证"**，比赛里会直接导致误判。
if (hit) process.exit(0);

if (queried === 0) {
  console.error('\n🚫 所有查询都被拒绝（纯 Node 与浏览器回退均失败）。');
  console.error('   这**不代表**该证号不存在！请稍后重试，或手动访问：');
  console.error('   https://datasearch.nmpa.gov.cn/datasearch/home-index.html');
  process.exit(4);
}

if (failed > 0) {
  console.error(`\n⚠️ 有 ${failed} 个库查询失败（被拦截），结果不完整，不能据此判定"不存在"。`);
  process.exit(4);
}

console.log('提示：两个库均正常应答且无记录 —— 该证号确实不存在。');
console.log('      可换关键词（去掉"国械注准"前缀只留数字），或核对编号。');
process.exit(2);
