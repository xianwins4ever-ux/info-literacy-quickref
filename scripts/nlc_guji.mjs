// ============================================================
// 国家图书馆「中华古籍资源库」CLI（浏览器检索 + HTTP 详情）
//
// 用法:
//   node nlc_guji.mjs "南岑吴氏宗谱"
//   node nlc_guji.mjs "南岑吴氏宗谱" --st 10024 --top 3
//   node nlc_guji.mjs "契丹文" --st 102 --classification qid
//   node nlc_guji.mjs --detail "searchType=1002&indexName=data_512&fid=027042015010263"
//
// 为什么单独一个脚本（而不是并进 nlc.mjs）:
//   ⚠️ **民国图书库（data_416）是服务端渲染，纯 HTTP 0.25 秒就能抓**（见 nlc.mjs）；
//      但**中华古籍资源库（searchType=10024/1002/37/102）是 Vue 异步渲染**，
//      纯 HTTP 拿到的 HTML 里**没有结果条目**（只有壳）。实测：
//        - `words=` 参数 → 不生效
//        - `searchWord=` 参数 → 参数对，但纯 HTTP 仍拿不到（结果由 JS 注入）
//        - 浏览器填框/带参导航 → 能拿到
//      所以古籍库必须走浏览器。详情页则两种都行（服务端渲染）。
//
// 逆向要点（2026-10-17 实测）:
//   1. 检索 URL:
//        http://read.nlc.cn/allSearch/searchList?searchType=<ST>&showType=1&pageNo=1&searchWord=<词>
//      可选 `&classification=<文种码>`（仅 searchType=102 民族文字古籍用）
//   2. **searchType 对照表**（题目里反复出现）—— ⚠️ 2026-10-17 关键修正：
//        **1002  = 数字古籍（中华古籍资源库）★正确检索入口**
//        10024 = 「数字古籍」的另一个入口（indexName=data_892），
//                ⚠️ 实测**相关性极差**：「南岑吳氏宗譜」返回 2123 条，前 12 条全是别的宗谱，
//                目标记录根本不在前面 —— **不要用 10024 检索**。
//        37    = 西夏文献（西夏碎金）—— 页面简介写「包括西夏文献数据 120 余条」
//        102   = 民族文字古籍特藏
//      实测对照（同一个词「南岑吳氏宗譜」）：
//        searchType=10024 → 2123 条，前 12 条无目标
//        searchType=1002  → 9255 条，但**第 1 条就是目标**
//                           [027042015010263] 南岑吴氏宗谱 东阳吴氏 清乾隆14年(1749) ✅
//      所以 1002 虽然总条数更多，但**排序更相关**，是正确入口。
//   3. **民族文字古籍文种码**（classification）:
//        qid=契丹文 xix=西夏文 tib=藏文 uio=回鹘文 sog=粟特文 mon=蒙古文
//        mch=满文 nuc=女真文 khl=佉卢字 agk=焉耆-龟兹文 kho=于阗文 cht=察合台文
//        tai=傣文 shu=水文 qita=多文种合璧
//   4. 详情页（服务端渲染，可纯 HTTP）:
//        http://read.nlc.cn/allSearch/searchDetail?searchType=<ST>&showType=1&indexName=<IDX>&fid=<FID>
//      ⚠️ 古籍详情页**不是** `<label>` 结构，而是「字段：值」纯文本行 + 「第N册 在线阅读」列表。
//         **「共有几册」= 数「第N册」的个数**（实测南岑吴氏宗谱 = 第1册/第2册 = 2 册）。
//   5. 该库是**分词 OR 匹配**，噪音很大（「南岑吴氏宗谱」返回 2123 条，前几条全是别的宗谱）。
//      → 必须按书名/出版时间**逐条核对**，不能只看第一条。
// ============================================================

import { pathToFileURL } from 'node:url';
import { playwrightCandidates, isFsPath, resolveProfile } from './_env.mjs';

const CAND = [...playwrightCandidates(), 'playwright-core'];
let chromium = null;
for (const c of CAND) {
  try {
    const m = isFsPath(c) ? await import(pathToFileURL(c).href) : await import(c);
    chromium = (m.default ?? m).chromium;
    if (chromium) break;
  } catch { /* next */ }
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36 Edg/154.0.0.0';
const ORIGIN = 'http://read.nlc.cn';
const PROFILE = resolveProfile('nlc-profile', 'NLC_PROFILE');

const argv = process.argv.slice(2);
const has = (f) => argv.includes('--' + f);
const opt = (f, d = null) => { const i = argv.indexOf('--' + f); return i >= 0 ? argv[i + 1] : d; };

class Exit extends Error { constructor(c) { super('exit'); this.code = c; } }
const done = (c = 0) => { throw new Exit(c); };

// ---- 详情页解析（纯 HTTP）----
function parseAncientDetail(html) {
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, '\n')
    .replace(/&nbsp;/g, ' ')
    .split('\n').map((s) => s.replace(/[ \t\u00a0]+/g, ' ').trim()).filter(Boolean);

  const fields = {};
  for (let i = 0; i < text.length; i++) {
    const m = text[i].match(/^([^：:]{2,8})[：:]\s*(.*)$/);
    if (m) {
      const k = m[1].trim();
      let v = m[2].trim();
      if (!v && text[i + 1] && !/^[^：:]{2,8}[：:]/.test(text[i + 1]) && text[i + 1].length < 60) v = text[i + 1];
      if (v) fields[k] = v;
    }
  }
  const vols = [...new Set((html.match(/第\s*(\d+)\s*册/g) || [])
    .map((s) => Number(s.replace(/[^\d]/g, ''))))].sort((a, b) => a - b);
  // 标题：详情页 <div class="title"> 或第一个非导航行
  let title = (html.match(/<div class="title">\s*([\s\S]*?)<\/div>/) || [, ''])[1]
    .replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
  return { title, fields, volCount: vols.length, vols };
}

async function fetchDetail(query, tries = 3) {
  const url = `${ORIGIN}/allSearch/searchDetail?${query}`;
  let lastErr;
  // ⚠️ read.nlc.cn 偶发 UND_ERR_CONNECT_TIMEOUT（机器负载高时），加超时 + 重试
  for (let i = 0; i < tries; i++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 12000);
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9', Referer: ORIGIN + '/' },
        signal: ac.signal,
      });
      const html = await res.text();
      clearTimeout(timer);
      return { url, ...parseAncientDetail(html), htmlLen: html.length };
    } catch (e) {
      clearTimeout(timer);
      lastErr = e;
      if (i < tries - 1) await new Promise((r) => setTimeout(r, 800 * (i + 1)));
    }
  }
  throw lastErr;
}

async function main() {
  if (has('detail')) {
    const q = opt('detail');
    const t0 = Date.now();
    const d = await fetchDetail(q);
    console.log(`=== 详情 ${d.url} ===`);
    console.log(`  标题 : ${d.title || '(未取到)'}`);
    for (const [k, v] of Object.entries(d.fields)) console.log(`  ${k} : ${v}`);
    if (d.volCount) console.log(`  ★册数 : ${d.volCount} 册（${d.vols.join(', ')}）`);
    console.log(`ELAPSED = ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    return;
  }

  const keyword = argv.find((a) => !a.startsWith('--') && argv[argv.indexOf(a) - 1]?.startsWith('--') !== true);
  if (!keyword) {
    console.error(`国家图书馆中华古籍资源库 CLI

用法:
  node nlc_guji.mjs "<书名>" [--st 10024] [--classification qid] [--top 5]
  node nlc_guji.mjs --detail "searchType=1002&indexName=data_512&fid=027042015010263"

  --st <searchType>    1002=数字古籍(默认，正确入口) 10024=数字古籍(备用，相关性差)
                       37=西夏文献 102=民族文字古籍
  --classification     文种码（102 用）：qid契丹文 xix西夏文 tib藏文 uio回鹘文 ...
  --top <N>            进前 N 条详情（默认 3）
  --filter <词>        只保留标题/详情含该词的条目
  --fast               只列检索结果，不进详情

示例:
  node nlc_guji.mjs "南岑吴氏宗谱"
  node nlc_guji.mjs "契丹文" --st 102 --classification qid`);
    done(1);
  }

  const ST = opt('st', '1002');
  const CLS = opt('classification');
  const TOP = parseInt(opt('top', '3'), 10);
  const FILTER = opt('filter');
  const FAST = has('fast');

  const t0 = Date.now();
  const url = `${ORIGIN}/allSearch/searchList?searchType=${ST}&showType=1&pageNo=1`
    + `&searchWord=${encodeURIComponent(keyword)}`
    + (CLS ? `&classification=${CLS}` : '');

  let items = [];
  let total = null;

  if (chromium) {
    const ctx = await chromium.launchPersistentContext(PROFILE, {
      channel: 'msedge', headless: true, locale: 'zh-CN', userAgent: UA,
      args: ['--disable-blink-features=AutomationControlled'],
    });
    try {
      const page = ctx.pages()[0] || await ctx.newPage();
      await page.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); });
      await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 }).catch(() => {});
      await page.waitForTimeout(5000);
      const r = await page.evaluate(() => {
        const txt = document.body.innerText.replace(/\s+/g, ' ');
        const m = txt.match(/共\s*([\d,]+)\s*条/);
        const out = [];
        for (const a of document.querySelectorAll('a[href*="fid="]')) {
          const href = a.getAttribute('href') || '';
          const fm = href.match(/fid=([A-Za-z0-9]+)/);
          if (!fm) continue;
          const idx = (href.match(/indexName=([A-Za-z0-9_]+)/) || [, ''])[1];
          const st2 = (href.match(/searchType=(\d+)/) || [, ''])[1];
          const text = (a.innerText || '').replace(/\s+/g, ' ').trim();
          out.push({ fid: fm[1], indexName: idx, searchType: st2, href, text });
        }
        return { total: m ? m[1] : null, items: out };
      });
      total = r.total;
      // 去重（同一 fid 可能出现多次）
      const seen = new Set();
      items = r.items.filter((x) => (seen.has(x.fid) ? false : (seen.add(x.fid), true)));
    } finally {
      await ctx.close().catch(() => {});
    }
  } else {
    console.error('⚠️ 找不到 playwright-core，古籍库检索必须用浏览器');
    done(1);
  }

  console.log(`=== 古籍库检索「${keyword}」 @ searchType=${ST}${CLS ? ' classification=' + CLS : ''} ===`);
  console.log(`共 ${total ?? '?'} 条（解析出 ${items.length} 条）`);

  let shown = items;
  if (FILTER) shown = shown.filter((x) => (x.text + x.fid).includes(FILTER));
  for (const it of shown.slice(0, 15)) {
    console.log(`  [${it.fid}] ${it.text.slice(0, 110)}`);
  }

  // ⚠️ 2026-10-17 修复：`--filter` 原来只过滤**列表显示**，
  //    但 `--top N` 取详情时用的是**未过滤**的 items，导致「filter 了却还是进第一条」。
  //    现在先过滤，再用过滤后的列表取详情。
  const detailPool = FILTER ? items.filter((x) => (x.text + x.fid).includes(FILTER)) : items;
  if (!FAST && detailPool.length) {
    console.log(`\n--- 前 ${Math.min(TOP, detailPool.length)} 条详情${FILTER ? '（已按 filter 筛选）' : ''} ---`);
    for (const it of detailPool.slice(0, TOP)) {
      const q = `searchType=${it.searchType || ST}&showType=1`
        + (it.indexName ? `&indexName=${it.indexName}` : '') + `&fid=${it.fid}`;
      try {
        const d = await fetchDetail(q);
        console.log(`\n  [${it.fid}] ${d.title || it.text.slice(0, 60)}`);
        // 常用字段优先，其余按原顺序（古籍详情字段各库不同，全列出来最保险）
        const PRI = ['责任者', '出版者', '出版时间', '出版发行项', '版本项', '类型',
          '善本书号', '四部分类号', '版本书目史注', '存卷', '格式', '馆藏信息', '主题'];
        const seen = new Set();
        for (const k of PRI) {
          if (d.fields[k]) { console.log(`      ${k} : ${d.fields[k]}`); seen.add(k); }
        }
        for (const [k, v] of Object.entries(d.fields)) {
          if (seen.has(k)) continue;
          if (/^当前位置$|^分享到$|^电话$/.test(k)) continue;
          if (String(v).length < 300) console.log(`      ${k} : ${v}`);
        }
        if (d.volCount) console.log(`      ★册数 : ${d.volCount} 册（${d.vols.join(', ')}）`);
      } catch (e) {
        console.log(`  [${it.fid}] 详情失败: ${String(e).slice(0, 80)}`);
      }
      await new Promise((r) => setTimeout(r, 300));
    }
  } else if (!FAST && FILTER && !detailPool.length) {
    console.log(`\n(--filter "${FILTER}" 在当前页没有匹配项；试试换词，或去掉 filter 看全部) `);
  }
  console.log(`ELAPSED = ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

main().catch((e) => {
  if (e instanceof Exit) { process.exitCode = e.code; return; }
  console.error('ERROR: ' + String(e && e.stack || e).slice(0, 400));
  process.exitCode = 1;
});
