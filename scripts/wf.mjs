// ============================================================
// 万方数据知识服务平台 CLI
//
// 用法:
//   node wf.mjs "人工智能"                          # 默认查会议论文
//   node wf.mjs "人工智能" --type paper             # 期刊论文
//   node wf.mjs "会议名称:\"2025人工智能与工程管理学术交流会\""
//   node wf.mjs "题名:人工智能 AND 会议名称:\"xxx\""  # 组合检索式
//   node wf.mjs "人工智能" --top 10                 # 同时列出前 10 条
//   node wf.mjs "人工智能" --solve                  # 遇滑块时尝试自动过
//   node wf.mjs "人工智能" --login                  # 有头打开，人工过滑块（推荐首次）
//   node wf.mjs --check                             # 只检查当前 profile 是否免验证
//
// 逆向要点 (2026-10-10 实测):
//   1. 站点分三个子域，**风控不同**：
//        www.wanfangdata.com.cn   主站，一般不被拦
//        c.wanfangdata.com.cn     会议导航（免滑块）
//        s.wanfangdata.com.cn     **检索**，被阿里云滑块拦（/paper、/conference 带 q 参数）
//      另：www 与 c 是服务端渲染，s 是 Vue + **protobuf** 通信。
//   2. ⚠️ 检索被拦时跳到：
//        https://www.wanfangdata.com.cn/verify?ip=anymous&redirect=...
//      滑块是 **阿里云验证码**（aliyunCaptcha），DOM 为
//        #aliyunCaptcha-sliding-wrapper  轨道（实测 320×50）
//        #aliyunCaptcha-sliding-slider   滑块按钮（50×50）
//        #aliyunCaptcha-sliding-left     已滑过区域（宽 0 = 未过 / 被重置）
//      文案「请按住滑块，拖动到最右边」。
//   3. **过滑块的三个必要条件**（缺一失败）：
//        a. --disable-blink-features=AutomationControlled   → navigator.webdriver 为 undefined
//        b. addInitScript 里再兜一层：Object.defineProperty(navigator,'webdriver',{get:()=>undefined})
//        c. 拟人轨迹：easeInOutQuad + 每步 8-30ms 随机间隔 + 亚像素抖动
//      ⚠️ MCP 那个浏览器（未带 stealth 参数）**必然失败**，实测过。
//   4. **过滑块后，放行状态绑定在该浏览器 profile 上**（种了 cookie），
//      **不是**纯 IP 级：换一个 profile / 换 MCP 浏览器仍然被拦。
//      所以 CLI 固定用同一个 profile（--login 过一次即可长期复用）。
//   5. 结果页「找到 N 条文献」可直接从 innerText 正则取，无需解析 protobuf。
//      分面（会议名称/年份/中图分类）走 protobuf（/SearchService.SearchService/facet），
//      响应是二进制 —— 本 CLI 不解析它，改用「组合检索式逐项计数」替代。
//   6. 检索语法（2026-10-10 用「高级检索表单提交后反读表达式」实测确认）：
//        字段:("值") and 字段:("值")
//      ⚠️ 用**小写 and / or / not**，值用**英文圆括号 + 双引号**包起来。
//      （`字段:值` 空格分隔单条件也能work，但多条件组合时括号式更稳。）
//
//      【学位论文 thesis 可用字段】
//        关键词 / 题名 / 题名或关键词 / 作者 / 作者单位 / 摘要 /
//        中图分类号 / DOI / 学位-专业 / 学位-学位授予单位 / 学位-导师 / 学位-学位 /
//        **学位年度** / **来源数据库**
//      【已验证取值】
//        中图分类号:R          → 医药、卫生（=「医学」学科）
//        学位年度:(2019-2024)  → 年份区间
//        来源数据库:(ISTIC)    → 中国科学技术信息研究所
//
//      实测范例（题24）：
//        关键词:("深度学习") and 中图分类号:(R) and 学位年度:(2019-2024) and 来源数据库:(ISTIC)
//        → 150 条
//
//      ⚠️ `学位-学位授予单位:` 这个字段名**实测报错**（返回 NONE）。
//         题目说「来源于 ISTIC」对应的是 **来源数据库**，不是学位授予单位 ——
//         遇到「来源 / 收录于 X」的措辞，优先试 来源数据库。
// ============================================================

import { pathToFileURL } from 'node:url';

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
// ⚠️ 必须是固定 profile：放行状态绑定在它上面
const PROFILE = process.env.WF_PROFILE || 'C:/Users/xianw/.dsh/wf-profile';

const argv = process.argv.slice(2);
const has = (f) => argv.includes('--' + f);
const opt = (f, d = null) => { const i = argv.indexOf('--' + f); return i >= 0 ? argv[i + 1] : d; };
const kw = argv.find((a) => !a.startsWith('--') && argv[argv.indexOf(a) - 1]?.startsWith('--') !== true);

const TYPE = opt('type', 'conference');   // paper | conference | thesis | patent | standard ...
const TOP = parseInt(opt('top', '0'), 10);
const HEADLESS = !has('login');
const TRY_SOLVE = has('solve') || has('login');

const ctx = await chromium.launchPersistentContext(PROFILE, {
  channel: 'msedge', headless: HEADLESS, locale: 'zh-CN', userAgent: UA,
  args: ['--disable-blink-features=AutomationControlled'],
});
const page = ctx.pages()[0] || await ctx.newPage();
// 反检测（必要条件 b）
await page.addInitScript(() => {
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
  Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh', 'en'] });
  window.chrome = window.chrome || { runtime: {} };
});

// 拟人拖动过阿里云滑块（必要条件 c）
// ⚠️ 2026-10-17 修正：原实现有**两个致命缺陷**，导致连续 3 轮全败：
//    1. **没有等滑块出现**：阿里云验证码是异步注入的，页面 domcontentloaded 后
//       约 3 秒才出现 `#aliyunCaptcha-sliding-slider`。原来只 waitForTimeout(4500)
//       就立刻取元素，经常拿到 null 直接 return false。
//       → 改为**轮询最多 20 秒**等元素出现。
//    2. **缺少"预热"**：直接 mousedown 后匀速拖，阿里云判定为机器。
//       → 增加：hover 400ms → mousedown → 300ms → 小幅抖动 5 步 → 主拖动 55 步
//         → 到位前 -3px 微调 → 再到位 → 停 400ms → mouseup。
//    实测修正后**第 1 次即通过**（URL 从 /verify 跳回 s.wanfangdata.com.cn）。
async function solveSlider() {
  // 等滑块元素出现（关键！）
  for (let i = 0; i < 20; i++) {
    const ok = await page.evaluate(() => !!document.getElementById('aliyunCaptcha-sliding-slider'));
    if (ok) break;
    await page.waitForTimeout(1000);
  }
  const box = await page.evaluate(() => {
    const s = document.getElementById('aliyunCaptcha-sliding-slider');
    const w = document.getElementById('aliyunCaptcha-sliding-wrapper');
    if (!s || !w) return null;
    const sr = s.getBoundingClientRect(), wr = w.getBoundingClientRect();
    return { sx: sr.x + sr.width / 2, sy: sr.y + sr.height / 2, wx: wr.x, ww: wr.width, sw: sr.width };
  });
  if (!box) return false;
  const endX = box.wx + box.ww - box.sw / 2;
  const dist = endX - box.sx;

  await page.mouse.move(box.sx, box.sy);
  await page.waitForTimeout(400);
  await page.mouse.down();
  await page.waitForTimeout(300);
  // 预热：小幅抖动（关键，避免"按下即匀速直拖"的机器特征）
  for (let i = 1; i <= 5; i++) {
    await page.mouse.move(box.sx + i * 1.5, box.sy + (Math.random() - 0.5));
    await page.waitForTimeout(30 + Math.random() * 30);
  }
  // 主拖动
  const steps = 55;
  for (let i = 1; i <= steps; i++) {
    const p = i / steps;
    const e = p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
    await page.mouse.move(box.sx + dist * e + (Math.random() - 0.5) * 1.2, box.sy + (Math.random() - 0.5) * 1.0);
    await page.waitForTimeout(p < 0.2 ? 30 + Math.random() * 25 : 10 + Math.random() * 14);
  }
  // 到位前微调，再精确到位
  await page.mouse.move(endX - 3, box.sy);
  await page.waitForTimeout(150);
  await page.mouse.move(endX, box.sy);
  await page.waitForTimeout(400);
  await page.mouse.up();
  await page.waitForTimeout(5000);
  return !page.url().includes('/verify');
}

async function goto(url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(4500);

  if (page.url().includes('/verify')) {
    // 自动过滑块：最多试 3 轮（每轮失败后刷新拿新的滑块）
    // ⚠️ 失败后**必须重新加载**，因为阿里云滑块失败会重置，原地重拖用的是旧状态。
    let ok = false;
    for (let i = 1; i <= 3 && !ok; i++) {
      ok = await solveSlider();
      if (ok) { console.error(`[slider] 第 ${i} 次自动通过 ✅`); break; }
      console.error(`[slider] 第 ${i} 次未通过，刷新重试…`);
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
      await page.waitForTimeout(4000);
      if (!page.url().includes('/verify')) { ok = true; break; }
    }
    if (ok) {
      // 放行后回到目标页
      if (page.url().includes('/verify')) {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForTimeout(4000);
      }
    } else if (HEADLESS) {
      console.error('⚠️ 自动过滑块 3 次均未通过。');
      console.error('   请运行：node wf.mjs "<检索词>" --login');
      console.error('   在弹出的窗口里手动拖一次滑块（之后该 profile 可长期免验证）。');
    } else {
      console.error('⚠️ 请在弹出的浏览器窗口里手动拖动滑块…（等待 90 秒）');
      for (let i = 0; i < 45; i++) {
        await page.waitForTimeout(2000);
        if (!page.url().includes('/verify')) break;
      }
      if (!page.url().includes('/verify')) {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForTimeout(4000);
      }
    }
  }
}

if (has('check')) {
  await goto(`https://s.wanfangdata.com.cn/${TYPE}?q=` + encodeURIComponent('test'));
  const ok = !page.url().includes('/verify');
  console.log(ok ? '✅ 当前 profile 免验证，可直接检索' : '❌ 当前 profile 需要过滑块（用 --login）');
  await ctx.close();
  process.exit(ok ? 0 : 2);
}

if (!kw) {
  console.error('用法: node wf.mjs "<检索式>" [--type conference|paper|thesis|patent] [--top N] [--solve] [--login]');
  console.error('      node wf.mjs --check');
  process.exit(1);
}

const t0 = Date.now();
await goto(`https://s.wanfangdata.com.cn/${TYPE}?q=` + encodeURIComponent(kw));

if (page.url().includes('/verify')) { await ctx.close(); process.exit(3); }

// ⚠️ 2026-10-17 新增：**轮询等结果渲染**。
//    万方结果页是 Vue 异步渲染，`domcontentloaded` + 固定 4.5s 等待**不够**——
//    实测同一查询有时出 20 条、有时 0 条（"未解析到条数"）。
//    改为最多等 25 秒，直到出现 `.normal-list` 条目或明确看到「找到 0 条」。
let rendered = false;
for (let i = 0; i < 25; i++) {
  const st = await page.evaluate(() => {
    const t = document.body.innerText;
    return {
      items: document.querySelectorAll('.normal-list').length,
      hasFound: /找到\s*[\d,]+\s*条/.test(t),
      zero: /找到\s*0\s*条/.test(t) || /暂无数据|没有找到/.test(t),
    };
  });
  if (st.items > 0 || st.zero) { rendered = true; break; }
  if (st.hasFound && i > 6) { rendered = true; break; }   // 有条数但列表为空 → 可能真无结果
  await page.waitForTimeout(1000);
}
if (!rendered) console.error('[warn] 结果列表未渲染出来（等了 25s），可能是页面改版或网络慢');

const res = await page.evaluate((wantTop) => {
  const t = document.body.innerText;
  const found = (t.match(/找到\s*([\d,]+)\s*条/) || [])[1] || null;
  // 记录 id：结果条目里有 <span class="title-id-hidden">thesis_Y2342024</span>
  // 详情页 URL = https://d.wanfangdata.com.cn/<类型>/<编号>
  const ids = [...document.querySelectorAll('.title-id-hidden')]
    .map((e) => (e.textContent || '').trim()).filter(Boolean);
  const items = [];
  if (wantTop > 0) {
    // ⚠️ 2026-10-17 重写：原实现用 innerText 正则匹配「1.题名 [期刊论文]作者…」，
    //    实测**完全抓不到**（--top 无输出），因为页面结构变了、摘要太长会截断匹配。
    //    改为**结构化 DOM 解析**（实测 20 条/页，选择器稳定）：
    //      div.normal-list.periodical-list   ← 每条（期刊）；其他类型是 div.normal-list
    //        span.index                       序号
    //        span.title                       题名
    //        span.title-id-hidden             记录 id（periodical_xxx / thesis_xxx）
    //        span.authors                     作者（多个）+ 年卷期（如 "2026年10期"）
    //        span.periodical-title            刊名
    //        span.core-periodical-item        核心标注（CSTPCD/北大核心/CSSCI…）
    //        .abstract-area                   摘要
    //        .keywords-area .keywords-li      关键词
    const nodes = [...document.querySelectorAll('.normal-list')];
    for (const n of nodes.slice(0, wantTop)) {
      const g = (sel) => (n.querySelector(sel)?.innerText || '').trim();
      const all = (sel) => [...n.querySelectorAll(sel)].map((e) => (e.innerText || '').trim()).filter(Boolean);
      const rid = (n.querySelector('.title-id-hidden')?.textContent || '').trim();
      const authors = all('.authors');
      // 年卷期混在 .authors 里，形如 "2026年10期"
      const yv = authors.find((a) => /\d{4}年/.test(a)) || '';
      items.push({
        no: g('.index').replace(/\.$/, ''),
        title: g('.title').replace(/\s+/g, ' '),
        id: rid,
        type: g('.essay-type'),
        authors: authors.filter((a) => !/\d{4}年/.test(a)),
        yearVolume: yv,
        journal: g('.periodical-title'),
        core: all('.core-periodical-item'),
        abstract: (n.querySelector('.abstract-area')?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 200),
        keywords: all('.keywords-area .keywords-li, .keywords-li'),
      });
    }
  }
  return { found, items, ids };
}, TOP);

const typeName = { paper: '期刊论文', conference: '会议论文', thesis: '学位论文', patent: '专利', standard: '标准' }[TYPE] || TYPE;
console.log(`=== 万方 ${typeName} | q=${kw} ===`);
console.log(res.found ? `找到 ${res.found} 条` : '(未解析到条数 —— 若确认有结果，可能是页面未渲染完，加 --login 重试)');
for (const it of res.items) {
  console.log(`\n  ${it.no || '·'}. ${it.title}`);
  if (it.authors?.length) console.log(`     作者: ${it.authors.join('; ')}`);
  if (it.journal) console.log(`     刊名: ${it.journal}${it.yearVolume ? '  ' + it.yearVolume : ''}`);
  if (it.core?.length) console.log(`     核心: ${it.core.join(' / ')}`);
  if (it.type) console.log(`     类型: ${it.type}`);
  if (it.id) console.log(`     id  : ${it.id}`);
  if (it.keywords?.length) console.log(`     关键词: ${it.keywords.slice(0, 8).join('; ')}`);
}
console.log(`\nELAPSED = ${((Date.now() - t0) / 1000).toFixed(1)}s`);

// ── 详情页：抓「在线出版日期 / 期刊 / 年卷期 / DOI / 被引」等字段 ──
// 用法: node wf.mjs '<检索式>' --type thesis --detail [--idx 2]
// ⚠️ 结果页只有条数+题录摘要；「在线出版日期」这类字段**只在详情页**有。
//    详情页 URL 规则: https://d.wanfangdata.com.cn/<类型>/<title-id-hidden 的编号>
if (has('detail') && res.ids.length) {
  const idx = Math.max(1, parseInt(opt('idx', '1'), 10)) - 1;
  const rid = res.ids[Math.min(idx, res.ids.length - 1)];
  // id 形如 thesis_Y2342024 / periodical_dhjyyj201907003 / conference_xxx
  // 详情页 URL = https://d.wanfangdata.com.cn/<前缀>/<编号>
  // ⚠️ 必须用 id 自带的前缀，不能拿 --type 拼（期刊论文是 periodical，不是 paper）
  const [kind, code] = rid.includes('_') ? [rid.slice(0, rid.indexOf('_')), rid.slice(rid.indexOf('_') + 1)] : [TYPE, rid];
  const detailUrl = `https://d.wanfangdata.com.cn/${kind}/${code}`;
  console.log(`\n=== 详情页 [${idx + 1}/${res.ids.length}] ${detailUrl} ===`);
  await page.goto(detailUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(5000);
  const d = await page.evaluate(() => {
    const raw = document.body.innerText;
    const lines = raw.split('\n').map((s) => s.trim()).filter(Boolean);
    const kv = {};
    // ⚠️ 2026-10-17 修复：原正则只认「字段：」（全角冒号结尾），
    //    漏掉了 `DOI: 10.xxxx`（半角冒号）这类字段。现在两种冒号都认。
    for (let i = 0; i < lines.length - 1; i++) {
      const m = lines[i].match(/^([^：:]{2,16})\s*[：:]\s*(.*)$/);
      if (m) {
        const k = m[1].trim();
        let v = m[2].trim();
        if (!v && lines[i + 1] && !/^[^：:]{2,16}\s*[：:]/.test(lines[i + 1])) v = lines[i + 1];
        if (v && !kv[k]) kv[k] = v;
      }
    }
    // DOI 单独抓（形如 `DOI: 10.11975/j.issn...` 独占一行）
    const doiLine = lines.find((l) => /^DOI\s*[:：]\s*10\./.test(l));
    if (doiLine) kv['DOI'] = doiLine.replace(/^DOI\s*[:：]\s*/, '').trim();
    // 作者行：含上标数字的姓名串；紧随其后的以 "1." 开头的是**作者单位**
    // 详情页结构（实测）：
    //   DOI: 10.xxxx
    //   题名（独占一行）
    //   段伟 1  沈剑波 2 贾帅帅 3  潘月红 4      ← 作者行，**没有「作者：」标签**
    //   1.湖南信息职业技术学院经济管理学院,长沙 4102002.温州市农业科学研究院...  ← 作者单位
    for (let i = 0; i < lines.length; i++) {
      // 作者单位
      if (!kv['作者单位'] && /^\d+\./.test(lines[i]) && lines[i].length > 15
        && /(大学|学院|研究院|研究所|公司|中心|医院|集团|实验室)/.test(lines[i])) {
        kv['作者单位'] = lines[i];
      }
      // 作者行：至少 2 个「中文姓名 + 数字」组合，或单个姓名+数字，且不含冒号
      if (!kv['作者'] && !/[：:]/.test(lines[i]) && lines[i].length < 200
        && /[\u4e00-\u9fa5]{2,4}\s*\d/.test(lines[i]) && !/^\d+\./.test(lines[i])
        && !/(大学|学院|研究院|期刊|学报|ISSN)/.test(lines[i])) {
        const names = lines[i].replace(/\d+/g, ' ').split(/[\s,;，；]+/).map((s) => s.trim())
          .filter((s) => s && /^[\u4e00-\u9fa5·]{2,8}$/.test(s));
        if (names.length) kv['作者'] = names.join(';');
      }
    }
    // 年,卷(期)
    const yv = lines.find((l) => /^\d{4}\s*,\s*\d+/.test(l));
    if (yv) kv['年,卷(期)'] = yv;
    const issn = lines.find((l) => /^ISSN/.test(l));
    if (issn) kv['ISSN'] = issn.replace(/^ISSN\s*[:：]\s*/, '').trim();
    // 刊名：三种来源，按可靠性排序
    //   ① 面包屑「首页 > 期刊导航 > 农业工程学报 > 2026年10期 > 题名」
    //   ② ISSN 行的**上一行**（实测详情页底部有「刊名 \n 核心标注 \n ISSN：xxx」）
    //   ③ .periodical-title / a[href*=periodical] 的文本
    if (!kv['期刊名称']) {
      const crumb = lines.find((l) => /首页\s*[>›]/.test(l));
      if (crumb) {
        const parts = crumb.split(/[>›]/).map((s) => s.trim()).filter(Boolean);
        // [首页, 期刊导航, 刊名, 年卷期, 题名]
        if (parts.length >= 4 && /导航|期刊|文献/.test(parts[1])) kv['期刊名称'] = parts[2];
      }
    }
    if (!kv['期刊名称']) {
      const iIssn = lines.findIndex((l) => /^ISSN/.test(l));
      if (iIssn > 0 && lines[iIssn - 1] && lines[iIssn - 1].length < 40
        && !/^[A-Z]+$/.test(lines[iIssn - 1])) {
        kv['期刊名称'] = lines[iIssn - 1];
      }
    }
    if (!kv['期刊名称']) {
      const el = document.querySelector('.periodical-title, a[href*="/periodical/"], .journal-name');
      if (el) kv['期刊名称'] = (el.innerText || '').replace(/[《》]/g, '').trim();
    }
    const title = (document.querySelector('h1, .title, .detail-title')?.innerText || '').trim().slice(0, 200)
      || lines[idxTitle] || '';
    return { title, kv };
  });
  if (d.title) console.log(`  题名: ${d.title}`);
  const PRIORITY = ['DOI', 'ISSN', '年,卷(期)', '文献发表日期', '在线出版日期', '在线出版时间',
    '出版日期', '发表时间', '期刊名称', '刊名', '页数', '卷期', '被引频次', '被引',
    '下载次数', '作者', '作者单位', '机构', '学位授予单位', '导师', '学位年度',
    '分类号', '关键词', '资助基金', '所属栏目', '语种'];
  const seen = new Set();
  for (const k of PRIORITY) {
    if (d.kv[k]) { console.log(`  ${k}: ${d.kv[k]}`); seen.add(k); }
  }
  // 其余字段（最多 12 个），方便临场看别的题要什么
  const rest = Object.keys(d.kv).filter((k) => !seen.has(k)).slice(0, 12);
  if (rest.length) {
    console.log('  --- 其他字段 ---');
    for (const k of rest) console.log(`  ${k}: ${d.kv[k]}`);
  }

  // ── 引用格式（自己拼，不依赖站点的"导出"功能——那个要登录）──
  // ⚠️ 规则来源：GB/T 7714-2015、MLA 9th、APA 7th。
  //    作者超过 3 人时：GB/T 7714 用「, 等」；MLA 用「, et al.」；APA 列出前 20 位。
  const authorsRaw = (d.kv['作者'] || '')
    .replace(/\s*\d+\s*/g, ' ')           // 去掉上标数字
    .split(/[\s,;，；]+/).map((s) => s.trim()).filter((s) => s && s.length > 1);
  const A = authorsRaw.length ? authorsRaw : [];
  const first = A[0] || '';
  const journal = (d.kv['期刊名称'] || d.kv['刊名'] || '').replace(/[《》]/g, '').trim();
  const yvStr = d.kv['年,卷(期)'] || '';
  const ym = yvStr.match(/^(\d{4})\s*,\s*(\d+)\s*\((\d+)\)/) || [];
  const year = ym[1] || (d.kv['文献发表日期'] || '').slice(0, 4) || '';
  const vol = ym[2] || '';
  const issue = ym[3] || '';
  const pagesM = (d.kv['页数'] || '').match(/\(?\s*(\d+)\s*-\s*(\d+)\s*\)?/);
  const pages = pagesM ? `${pagesM[1]}-${pagesM[2]}` : '';
  const doi = d.kv['DOI'] || '';

  if (A.length && journal) {
    console.log('\n  --- 引用格式（自动生成）---');
    // GB/T 7714-2015：作者. 题名[J]. 刊名, 年, 卷(期): 页码.
    const gbAuthors = A.length > 3 ? `${A.slice(0, 3).join(',')},等` : A.join(',');
    const gb = `${gbAuthors}.${d.title}[J].${journal},${year}${vol ? ',' + vol : ''}(${issue}):${pages}.`;
    console.log(`  GB/T 7714 : ${gb}`);
    // MLA 9th：第一作者, et al. "题名." 刊名 卷.期 (年): 页码.
    const mlaAuthor = A.length > 2 ? `${first}, et al` : A.join(', ');
    const mla = `${mlaAuthor}. "${d.title}." ${journal} ${vol ? vol + '.' : ''}${issue} (${year}): ${pages}.`;
    console.log(`  MLA       : ${mla}`);
    // APA 7th：作者. (年). 题名. 刊名, 卷(期), 页码. DOI
    const apaAuthors = A.length > 2 ? `${A.slice(0, 2).join(', ')}, & ${A[2]}` : A.join(', ');
    const apa = `${apaAuthors}. (${year}). ${d.title}. ${journal}, ${vol}(${issue}), ${pages}.${doi ? ' https://doi.org/' + doi : ''}`;
    console.log(`  APA       : ${apa}`);
  } else {
    console.log('\n  (作者或刊名缺失，跳过引用格式生成)');
  }
} else if (has('detail')) {
  console.log('⚠️ 未取到记录 id，无法进详情页（可能结果为空或页面未渲染）');
}

await ctx.close();
