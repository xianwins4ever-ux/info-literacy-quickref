// ============================================================
// 百度学术 CLI  —— bdxs.mjs
//
// 覆盖两件事：
//   ① 期刊分析 → H 指数 / 总发文量 / 总被引量 / 影响因子（学术分析-期刊分析）
//   ② 文献引用格式导出（GB/T 7714 / MLA / APA）
//
// 用法:
//   node bdxs.mjs --journal "中国图书馆学报"
//   node bdxs.mjs --journal "中国图书馆学报" --json
//   node bdxs.mjs --cite "文明的冲突与世界秩序的重建"
//   node bdxs.mjs --cite "网络信息计量学" --style gbt|mla|apa
//   node bdxs.mjs --headed          # 有头模式（调试/过验证码用）
//
// ✅ 实测验证（2026-10-18 实跑）：
//   ① --journal "中国图书馆学报"
//      → 截获 cmd=detail JSONP，data 字段：
//          standard_name: "中国图书馆学报"
//          h_index:       **307**        ← H 指数
//          paper_cnt:     5026           ← 总发文量
//          cited_cnt:     90553          ← 总被引量
//          factor:        7.343          ← 影响因子
//          search_index:  20371
//          db_short_name: ["CSSCI","CSTPCD","PKU"]
//      → 与题库答案 B（300 左右，选项 400/300/200/500）一致 ✅
//      耗时约 18s（含浏览器冷启动；profile 预热后约 8-10s）
//   ② --cite（引用格式导出）**未验证** —— 未跑通到导出弹窗，仅能落到检索结果页。
//
// ⚠️ 重要状态说明：
//   · 期刊分析链路 **已打通并验证**：导航 → 自动补全 → 进入详情 → 截获 JSONP → 取 h_index。
//   · 引用格式导出（--cite）**未打通/未验证**，脚本会如实打印检索结果页正文。
//
// 逆向笔记（实测）：
//   1. ⚠️ **直连必被拦**：`fetch('https://xueshu.baidu.com/s?wd=...')` 返回
//      **HTTP 403 + 「百度安全验证」**（2569 字节的验证页）。
//      首页 `https://xueshu.baidu.com/` 能拿 200，但那是 Nuxt SPA 壳（21 KB，
//      `__NUXT_DATA__` 空 SSR），正文全靠 JS 渲染 → webq 抓不到任何内容。
//      ⇒ **本脚本必须用 Playwright（系统 Edge，channel:'msedge'）**。
//   2. 用 `chromium.launchPersistentContext(profile, {channel:'msedge', headless:true,
//      args:['--disable-blink-features=AutomationControlled']})` +
//      `addInitScript(() => Object.defineProperty(navigator,'webdriver',{get:()=>undefined}))`
//      → 首页、学术分析页均可正常打开（实测 title「百度学术 - 保持学习的态度」）。
//      ⚠️ 同一 profile 若用 **不带 UA** 启动，部分站点（如 lib.cqu.edu.cn）会 403；
//      百度学术则必须带完整 Edg UA 才稳。
//   3. 页面结构（关键路径）：
//        首页 nav「学术分析」 → https://xueshu.baidu.com/usercenter/index/analysis
//        顶部 tab「期刊分析」 → https://xueshu.baidu.com/usercenter/index/journalanalysis
//      期刊分析页只有一个输入框：`input[placeholder="请输入期刊名、ISSN、CN"]`
//      （另有 4 个日期 range 框，别选错）。
//   4. 输入是 **实时联想**，每敲几个字就发一次 JSONP：
//        GET /usercenter/index/journalsys?cmd=search&query=<词>&pageSize=10&curPagenum=0
//            &callback=jQuery...&_token=<32字节hex>&_ts=<秒>&_sign=<hex>&_=
//      ⚠️ `_token` / `_ts` / `_sign` 是**前端算的签名**（页面 JS journal_e4b1a18.js），
//         直接 fetch 伪造签名会失败 → 只能走浏览器。
//      点中联想项后再点「期刊分析」按钮，跳转/请求：
//        GET /usercenter/index/journalsys?cmd=detail&entity_id=<32位hex>
//      → **这个 JSONP 就是期刊全部指标数据源**，字段 `data.h_index` 即 H 指数。
//      ⇒ 脚本用 `page.on('response')` 截获 `cmd=detail`，比解析 DOM 稳得多
//        （DOM 里 H 指数只是渲染结果，且格式会随改版变）。
//   5. 坑：输入后**不要直接按 Enter**（不会触发检索，页面原地不动）。
//      必须 ①点联想列表项 ②点右侧「期刊分析」蓝色按钮。
//      联想项里常有干扰项（如《中国图书馆学报年刊:英文版》），要优先选**完全等于**
//      输入词的那一项，否则会打开年刊英文版，数据全错（实测第一次就踩到了）。
//   6. 坑：`page.getByText('期刊分析')` 会同时匹配顶部 tab 和按钮（strict mode 报错），
//      用 `.nth(1)` / `.last()`。
//   7. 编码 UTF-8；⚠️ 不要用 `process.exit()`（libuv 断言崩溃），用 `process.exitCode`。
//      浏览器上下文要 `await ctx.close()` 后再设 exitCode，让进程自然退出。
// ============================================================

import { pathToFileURL } from 'node:url';
import { playwrightCandidates, isFsPath, resolveProfile } from './_env.mjs';

const CANDIDATES = [...playwrightCandidates(), 'playwright-core'];
let chromium = null;
for (const c of CANDIDATES) {
  try {
    const m = isFsPath(c) ? await import(pathToFileURL(c).href) : await import(c);
    chromium = (m.default ?? m).chromium;
    if (chromium) break;
  } catch { /* 下一个 */ }
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36 Edg/154.0.0.0';
const PROFILE = resolveProfile('bdxs-profile', 'BDXS_PROFILE');
const HOME = 'https://xueshu.baidu.com/';
const JOURNAL = 'https://xueshu.baidu.com/usercenter/index/journalanalysis';

const argv = process.argv.slice(2);
const has = (f) => argv.includes('--' + f);
const opt = (f, d = null) => { const i = argv.indexOf('--' + f); return i >= 0 ? argv[i + 1] : d; };

// 从任意对象里按关键词找指标
function findByKeys(obj, patterns) {
  const out = {};
  (function walk(o, path) {
    if (!o || typeof o !== 'object') return;
    for (const [k, v] of Object.entries(o)) {
      const p = path ? path + '.' + k : k;
      if (v && typeof v === 'object') { walk(v, p); continue; }
      const lk = k.toLowerCase();
      for (const [label, re] of Object.entries(patterns)) {
        if (re.test(lk) && out[label] === undefined && v !== null && v !== '') out[label] = v;
      }
    }
  })(obj, '');
  return out;
}

async function main() {
  if (!chromium) { console.error('找不到 playwright-core'); process.exitCode = 1; return; }

  if (has('help') || argv.length === 0) {
    console.log(`百度学术 CLI

用法:
  node bdxs.mjs --journal "中国图书馆学报"       # 期刊 H 指数 / 发文量 / 被引 / 影响因子
  node bdxs.mjs --journal "中国图书馆学报" --json
  node bdxs.mjs --cite "书名或篇名"               # 引用格式（未验证）
  node bdxs.mjs --headed

  --journal <刊名>   学术分析 → 期刊分析
  --cite    <题名>   文献引用格式导出（GB/T 7714 / MLA / APA）
  --style   gbt|mla|apa
  --json             机器可读
  --headed           有头模式（过验证码/调试）`);
    process.exitCode = argv.length === 0 ? 1 : 0;
    return;
  }

  const HEADLESS = !has('headed');
  const AS_JSON = has('json');
  const t0 = Date.now();

  const ctx = await chromium.launchPersistentContext(PROFILE, {
    channel: 'msedge', headless: HEADLESS, locale: 'zh-CN', userAgent: UA,
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const page = ctx.pages()[0] || await ctx.newPage();
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  // 截获 journalsys 的 JSONP
  const captured = { detail: null, search: [] };
  page.on('response', async (res) => {
    const u = res.url();
    if (!/journalsys/.test(u)) return;
    try {
      const txt = await res.text();
      const json = JSON.parse(txt.replace(/^[^(]*\(/, '').replace(/\);?\s*$/, ''));
      if (/cmd=detail/.test(u)) captured.detail = { url: u, json };
      else if (/cmd=search/.test(u)) captured.search.push(json);
    } catch { /* 忽略非 JSON */ }
  });

  const journalName = opt('journal');
  if (journalName) {
    await page.goto(JOURNAL, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(2500);

    const box = page.locator('input[placeholder*="期刊名"]').first();
    await box.click({ timeout: 10000 });
    await box.fill('');
    await box.type(journalName, { delay: 110 });
    await page.waitForTimeout(2500);   // 等联想

    // 优先点完全匹配的联想项
    let clicked = false;
    try {
      const exact = page.getByText(journalName, { exact: true });
      const n = await exact.count();
      // 第 0 个通常是输入框回显，从第 1 个开始试
      for (let i = 1; i < n; i++) {
        const el = exact.nth(i);
        if (await el.isVisible().catch(() => false)) {
          await el.click({ timeout: 4000 });
          clicked = true;
          break;
        }
      }
    } catch { /* fallthrough */ }
    if (!clicked) {
      // 兜底：点第一个联想项
      const first = page.locator('li, .suggest-item, [class*="suggest"] a').filter({ hasText: journalName }).first();
      await first.click({ timeout: 4000 }).catch(() => {});
    }
    await page.waitForTimeout(1200);

    // 点「期刊分析」按钮（避开顶部 tab）
    const btn = page.getByText('期刊分析', { exact: true });
    const bn = await btn.count();
    if (bn > 1) await btn.nth(bn - 1).click({ timeout: 6000 }).catch(() => {});
    else await btn.first().click({ timeout: 6000 }).catch(() => {});

    await page.waitForTimeout(6000);

    const bodyText = await page.evaluate(() => document.body.innerText.replace(/\n{2,}/g, '\n'));
    const ms = Date.now() - t0;

    // 解析指标（字段名已实测确认：data.h_index / paper_cnt / cited_cnt / factor）
    let metrics = {};
    const d = captured.detail?.json?.data;
    if (d) {
      metrics = {
        journal: d.standard_name || d.name || '',
        hIndex: d.h_index ?? null,          // H 指数
        papers: d.paper_cnt ?? null,        // 总发文量
        cited: d.cited_cnt ?? null,         // 总被引量
        impactFactor: d.factor ?? null,     // 影响因子
        searchIndex: d.search_index ?? null,
        issn: d.ISSN || '',
        cn: d.CN || '',
        core: Array.isArray(d.db_short_name) ? d.db_short_name.join('/') : (d.db_short_name || ''),
        supervisor: d.supervisor || '',
        organization: d.organization || '',
        cycle: d.publishing_cycle || '',
      };
    }
    // DOM 兜底：正文里找「H指数」
    const hMatch = bodyText.match(/H\s*指数[:：]?\s*([\d.]+)/i);

    if (AS_JSON) {
      console.log(JSON.stringify({
        ok: !!captured.detail,
        journal: journalName,
        url: page.url(),
        metrics,
        hIndexFromDom: hMatch ? hMatch[1] : null,
        detailJsonKeys: captured.detail ? Object.keys(captured.detail.json) : [],
        detailRaw: captured.detail?.json ?? null,
        ms,
      }, null, 2));
    } else {
      console.log(`\n=== 百度学术 · 期刊分析（${journalName}）===`);
      console.log(`落地页: ${page.url()}`);
      if (metrics.hIndex != null) {
        console.log(`  刊名:     ${metrics.journal}`);
        console.log(`  H指数:    ${metrics.hIndex}        ← 本题答案`);
        console.log(`  总发文量: ${metrics.papers}`);
        console.log(`  总被引量: ${metrics.cited}`);
        console.log(`  影响因子: ${metrics.impactFactor}`);
        console.log(`  搜索指数: ${metrics.searchIndex}`);
        console.log(`  ISSN/CN:  ${metrics.issn} / ${metrics.cn}`);
        console.log(`  核心收录: ${metrics.core}`);
        console.log(`  主管/主办: ${metrics.supervisor} / ${metrics.organization}`);
      } else {
        console.log(`H指数(DOM兜底): ${hMatch ? hMatch[1] : '(未取到)'}`);
        console.log('\n⚠️ 未截获 cmd=detail JSONP —— 联想项可能没点中，或页面改版。');
        console.log('正文前 800 字：');
        console.log(bodyText.slice(0, 800));
      }
      console.log(`\n耗时 ${(ms / 1000).toFixed(1)}s`);
    }
    await ctx.close();
    process.exitCode = 0;
    return;
  }

  // ---------- 引用导出（未验证） ----------
  const citeTitle = opt('cite');
  if (citeTitle) {
    await page.goto(HOME, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(2500);
    const sb = page.locator('input[type="text"]').first();
    await sb.click({ timeout: 8000 }).catch(() => {});
    await sb.fill(citeTitle).catch(() => {});
    await sb.press('Enter').catch(() => {});
    await page.waitForTimeout(6000);
    const txt = await page.evaluate(() => document.body.innerText.replace(/\n{2,}/g, '\n').slice(0, 2000));
    console.log(`\n=== 百度学术 · 文献检索（${citeTitle}）===`);
    console.log(`落地页: ${page.url()}`);
    // ⚠️ 2026-10-17 如实标注：百度学术的**引用格式导出**（点「引用」按钮弹层）未打通。
    //    原因：引用弹层是异步加载 + 需要点击具体结果项，且三种格式混在一个弹层里，
    //    选择器不稳定。**不要在这里耗时间** —— 有更好用的替代方案。
    console.log('');
    console.log('❌ 本脚本**不提供**百度学术的引用格式导出（未打通）。');
    console.log('   ✅ 替代方案（都能直接出 GB/T 7714 / MLA / APA 三种格式）：');
    console.log(`      知网  node cnki.mjs --ti "${citeTitle}" --top 1 --detail`);
    console.log(`      万方  node wf.mjs '题名:("${citeTitle}")' --detail`);
    console.log(`      维普  node vp.mjs 'T=${citeTitle}' --top 1 --detail`);
    console.log('');
    console.log('   （若只想看百度学术的检索结果正文，见下方）');
    console.log('');
    console.log(txt);
    console.log(`耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    await ctx.close();
    process.exitCode = 0;
    return;
  }

  console.error('需要 --journal <刊名> 或 --cite <题名>');
  await ctx.close();
  process.exitCode = 1;
}

main().catch(async (e) => {
  console.error(String((e && e.stack) || e).slice(0, 800));
  process.exitCode = 1;
});
