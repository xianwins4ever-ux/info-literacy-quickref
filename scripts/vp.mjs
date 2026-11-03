// ============================================================
// 维普（中文期刊服务平台）检索式 CLI
//
// 用法:
//   node vp.mjs 'K=(5G * 通信) + (物联网 * 应用) - 军事'
//   node vp.mjs 'K=人工智能' --top 5
//   node vp.mjs 'K=人工智能' --headed        # 有头调试
//   node vp.mjs --help                       # 打印字段/运算符速查
//
// 逆向要点 (2026-10-10 实测):
//   1. ⚠️ 两个域名，风控不同：
//        qikan.cqvip.com   ← **检索**入口（对 pwsh/curl 返回 **412 Precondition Failed**，
//                             但**真实浏览器可正常访问**）
//        www.cqvip.com     ← 官网/帮助页（pwsh 可直连，200）
//      → 所以检索**必须走浏览器**；只有抓帮助文档才用 pwsh。
//   2. 高级检索页： https://qikan.cqvip.com/Qikan/Search/Advance
//      页内有「**检索式检索**」标签（`li` 文本恰为「检索式检索」），点击后才出现
//        textarea[placeholder="请输入检索式"]
//      提交按钮： `button.behavior-advanceexpresssearch`
//      （注意别写成 ...expresss，少个 earch 会匹配不到）
//   3. 结果**不跳转**，直接渲染在同一页下方，总数格式为：
//        「共找到 X 篇文章」
//      左侧还会给出**年份分布**与**学科分布**（很有用，可做交叉验证）。
//   4. **检索语法**（官方 helpcenter/advancesearch + 页内「检索说明」原文）：
//        运算符： AND(and / *)  OR(or / +)  NOT(not / -)
//        优先级： NOT > AND > OR      支持 () 提高优先级
//        字段标识符：
//          U=任意字段  M=题名或关键词  K=关键词  A=作者  C=分类号
//          S=机构      J=刊名          F=第一作者 T=题名  R=摘要
//        官方范例：(K=(CAD OR CAM) OR T=雷达) AND R=机械 NOT K=模具
//      ⚠️ 基本检索（一框式）**不支持**布尔运算符，会把 AND/OR/NOT 当检索词；
//         只有「高级检索 / 检索式检索 / 专业检索」才支持。
//   5. **`-` 是排除（AND NOT），作用于前面的整体结果** —— 已实测验证：
//        K=(5G * 通信)                       → 7,789
//        K=(5G * 通信) - 军事                 → 7,770   （减少，证明是排除）
//        K=(5G * 通信) + (物联网 * 应用)       → 16,899
//        K=(5G * 通信) + (物联网 * 应用) - 军事 → 16,863 （减少，证明作用于整体）
//      即 A + B - C  等价于  (A OR B) AND NOT C。
//   6. 该站对浏览器较友好，**不需要 stealth 参数**（实测无头 Edge 直接可用）。
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
if (!chromium) { console.error('找不到 playwright-core'); process.exit(1); }

// 优雅退出（不用 process.exit，避免 libuv 断言崩溃）
class GracefulExit extends Error {
  constructor(code) { super('graceful'); this.code = code; }
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36 Edg/154.0.0.0';
const PROFILE = resolveProfile('vp-profile', 'VP_PROFILE');
const PAGE = 'https://qikan.cqvip.com/Qikan/Search/Advance';

const argv = process.argv.slice(2);
const has = (f) => argv.includes('--' + f);
const opt = (f, d = null) => { const i = argv.indexOf('--' + f); return i >= 0 ? argv[i + 1] : d; };
const expr = argv.find((a) => !a.startsWith('--') && argv[argv.indexOf(a) - 1]?.startsWith('--') !== true);
const TOP = parseInt(opt('top', '0'), 10);
// --detail：进第 N 条（默认 1）的详情页，抓 DOI/机构/基金/分类号/引用格式
const DETAIL = has('detail');
const DETAIL_IDX = Math.max(1, parseInt(opt('idx', '1'), 10)) - 1;

if (has('help') || (!expr && !DETAIL)) {
  console.log(`维普检索式 CLI

用法: node vp.mjs "<检索式>" [--top N] [--detail] [--idx N] [--headed]

【运算符】
  AND(and / *)   逻辑与
  OR (or  / +)   逻辑或
  NOT(not / -)   逻辑非（排除）
  优先级: NOT > AND > OR     支持 () 提高优先级

【字段标识符】
  U=任意字段   M=题名或关键词   K=关键词    A=作者
  C=分类号     S=机构           J=刊名      F=第一作者
  T=题名       R=摘要

【示例】
  node vp.mjs 'K=(5G * 通信) + (物联网 * 应用) - 军事'
  node vp.mjs 'T=人工智能 AND K=教育'
  node vp.mjs 'K=深度学习' --top 5
  node vp.mjs 'K=乡村振兴' --detail          # 进第1条详情：DOI/机构/基金/引用格式
  node vp.mjs 'K=乡村振兴' --top 5 --detail --idx 3

⚠️ 基本检索（一框式）不支持布尔运算符，必须用本 CLI 的「检索式检索」。`);
  process.exit(expr ? 0 : 1);
}

const ctx = await chromium.launchPersistentContext(PROFILE, {
  channel: 'msedge', headless: !has('headed'), locale: 'zh-CN', userAgent: UA,
  // ⚠️ 这两个条件**必须同时满足**，缺一即 412 Precondition Failed（实测四组对照）：
  //     不覆盖 UA              → 412（默认 UA 里带 "HeadlessChrome"）
  //     只覆盖 UA              → 412
  //     只加 stealth 参数      → 412
  //     覆盖 UA + stealth 参数 → ✅ 200
  args: ['--disable-blink-features=AutomationControlled'],
});
const page = ctx.pages()[0] || await ctx.newPage();

const t0 = Date.now();
// ⚠️ 用 async IIFE 包裹主逻辑：这样在 412 等致命情况下可以 `return` 优雅退出，
//    而不必 `throw`（顶层 await 抛出的异常会打印难看的堆栈），
//    也不用 `process.exit()`（会触发 libuv 断言崩溃）。
let fatalCode = 0;
await (async () => {
try {
  const nav = await page.goto(PAGE, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(4000);

  // ⚠️⚠️ 2026-10-17 新增：**412 检测**。
  //    qikan.cqvip.com 会出现 **HTTP 412 Precondition Failed + 空 body（39 字节）**，
  //    表现为「页面全空 / 找不到检索式检索标签」，很容易被误判成"脚本坏了"。
  //    实测：同一时刻 `www.cqvip.com` 返回 200（147KB），说明是**子域级别的 IP 封锁**，
  //    不是 UA/stealth 配置问题（UA+stealth 早已同时给，仍 412）。
  //    这种情况下重试无意义，要等封锁解除或换源。
  const status = nav ? nav.status() : 0;
  const htmlLen = await page.evaluate(() => document.documentElement.outerHTML.length);
  // 三种被拦形态：
  //   ① HTTP 412 + 空 body（39 字节）—— 最干净的封锁
  //   ② HTTP 412 + 有内容（几百 KB，412 错误页/验证页）
  //   ③ HTTP 200 + 空 body（39 字节）—— JS 壳但没注入
  if (status === 412 || (status === 200 && htmlLen < 200)) {
    const shape = status === 412
      ? (htmlLen < 200 ? 'HTTP 412 + 空 body' : `HTTP 412 + 错误页（${Math.round(htmlLen / 1024)}KB）`)
      : `HTTP 200 但 body 仅 ${htmlLen} 字节`;
    console.error(`\n❌ 维普检索子域被拦：${shape}`);
    console.error('   这是 **IP 级封锁**，不是脚本问题 —— 同一时刻 www.cqvip.com 可正常访问。');
    console.error('   对策：');
    console.error('     1) 等 10~60 分钟再试（这类封锁通常会自动解除，实测出现过自愈）');
    console.error('     2) 换网络（手机热点 / VPN）后重跑');
    console.error('     3) 改用替代源（推荐，比赛时不要等）：');
    console.error('        知网  node cnki.mjs --ti "..." --su "..." --detail');
    console.error('        万方  node wf.mjs \'题名:("...")\' --detail');
    process.exitCode = 4;
    fatalCode = 4;
    return;
  }

  // 点「检索式检索」标签
  const switched = await page.evaluate(() => {
    const li = [...document.querySelectorAll('li')].find((e) => (e.textContent || '').trim() === '检索式检索');
    if (!li) return false;
    li.click();
    return true;
  });
  if (!switched) {
    console.error('未找到「检索式检索」标签 —— 页面结构可能改版，或用 webq.mjs --raw 看现状');
    process.exitCode = 2;
    fatalCode = 2;
    return;
  }
  await page.waitForTimeout(2000);

  // 填检索式
  const set = await page.evaluate((v) => {
    const ta = [...document.querySelectorAll('textarea')].find((e) => /请输入检索式/.test(e.placeholder || ''));
    if (!ta) return false;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, v);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }, expr);
  if (!set) { console.error('未找到检索式输入框'); process.exit(2); }

  // 提交
  await page.evaluate(() => {
    const b = document.querySelector('button.behavior-advanceexpresssearch');
    if (b) b.click();
  });
  await page.waitForTimeout(8000);

  const res = await page.evaluate((wantTop) => {
    const t = document.body.innerText.replace(/\s+/g, ' ');
    const cm = t.match(/共找到\s*([\d,]+)\s*篇文章/);
    const total = cm ? parseInt(cm[1].replace(/,/g, ''), 10) : null;

    // 结果项的真实 DOM 结构（实测）：
    //   div.full-list  (或 div.simple-list)  ← 每页 20 项
    //     └─ dl
    //          ├─ dt > a[href="/Qikan/Article/Detail?id=XXXX"]  题名 + 文章 id
    //          └─ dd  作者 / 《刊名》 / 年 期 / 摘要
    // 用 DOM 提取比正则扫纯文本干净得多（纯文本会把摘要串进来）。
    const items = [];
    if (wantTop > 0) {
      const dls = [...document.querySelectorAll('div.full-list > dl, div.simple-list > dl')].slice(0, wantTop);
      for (const dl of dls) {
        const a = dl.querySelector('dt a[href*="Article/Detail"]');
        const title = a ? (a.textContent || '').trim() : '';
        if (!title) continue;
        const idm = (a.getAttribute('href') || '').match(/id=(\d+)/);
        const dlText = (dl.innerText || '').replace(/\s+/g, ' ').trim();

        // ⚠️ 2026-10-17 重写结构化解析。
        //    维普结果项 dd 里混着「引用 N」「被引量：N」「作者 张三 李四 +1 位作者」
        //    「《刊名》」「北大核心」「2026年第4期94-105,共12页」「摘要…」，
        //    直接取整段文本会得到「引用 被引量：7 3 作者 周妮笛 杨菲 +1 位作者 安虹宇
        //    《中国农机化学报》 北大核心 2026年第4期276-283,共8页 …」这种垃圾。
        //    → 改为分字段正则提取。
        const authorsM = dlText.match(/作者\s*([^《]*?)(?:\+\s*\d+\s*位作者)?(?:\s*《|$)/);
        const journalM = dlText.match(/《([^》]+)》/);
        // 年卷期+页码：「2026年第4期276-283,共8页」
        const yvM = dlText.match(/(\d{4})\s*年\s*第\s*(\d+)\s*期\s*([\d\-–+]+)?\s*,?\s*共\s*(\d+)\s*页/);
        const citedM = dlText.match(/被引量\s*[:：]\s*(\d+)/) || dlText.match(/引用\s*(?:被引量[:：]\s*)?(\d+)/);
        const coreM = dlText.match(/\b(北大核心|CSSCI|CSCD|SCI|EI|AMI|WJCI|科技核心)\b/g);
        const absM = dlText.match(/《[^》]+》[^《]*?共\s*\d+\s*页\s*([\s\S]{20,200})/);

        // 摘要尾部会粘上「展开更多 关键词 xxx 暂未订购 下载PDF」这类 UI 文本，必须切掉
        let abstract = absM ? absM[1].replace(/\s+/g, ' ').trim() : '';
        abstract = abstract.split(/展开更多|收起|关键词\s|暂未订购|下载PDF|在线阅读/)[0].trim().slice(0, 160);
        // 关键词单独抓（在「关键词 」之后、「暂未订购/下载」之前）
        const kwM = dlText.match(/关键词\s+([\u4e00-\u9fa5A-Za-z0-9\-—、,;\s]{2,120}?)(?:暂未订购|下载PDF|在线阅读|$)/);

        items.push({
          title: title.slice(0, 150),
          id: idm ? idm[1] : '',
          authors: authorsM ? authorsM[1].replace(/\s+/g, ' ').trim().slice(0, 100) : '',
          journal: journalM ? journalM[1].trim() : '',
          year: yvM ? yvM[1] : '',
          issue: yvM ? yvM[2] : '',
          pages: yvM && yvM[3] ? yvM[3] : '',
          pageCount: yvM ? yvM[4] : '',
          cited: citedM ? citedM[1] : '',
          core: coreM ? [...new Set(coreM)].join('/') : '',
          keywords: kwM ? kwM[1].replace(/\s+/g, ' ').trim() : '',
          abstract,
          url: idm ? `https://qikan.cqvip.com/Qikan/Article/Detail?id=${idm[1]}` : '',
        });
      }
    }
    return { total, items, bodyLen: t.length };
  }, TOP);

  console.log(`=== 维普检索式 ===\n  ${expr}`);
  console.log(res.total != null ? `共找到 ${res.total.toLocaleString()} 篇文章` : '(未解析到总数)');
  for (const it of res.items) {
    console.log(`\n  · ${it.title}`);
    if (it.authors) console.log(`      作者: ${it.authors}`);
    const jv = [it.journal, it.year ? it.year + '年第' + it.issue + '期' : '', it.pages].filter(Boolean).join(' ');
    if (jv) console.log(`      出处: ${jv}${it.pageCount ? '，共' + it.pageCount + '页' : ''}`);
    if (it.core) console.log(`      核心: ${it.core}`);
    if (it.cited) console.log(`      被引: ${it.cited}`);
    if (it.keywords) console.log(`      关键词: ${it.keywords}`);
    if (it.abstract) console.log(`      摘要: ${it.abstract}`);
    if (it.url) console.log(`      链接: ${it.url}`);
  }
  console.log(`ELAPSED = ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  // ── 详情页：DOI / 机构 / 基金 / 分类号 / 引用格式 ──
  // ⚠️ 维普详情页的字段是**空格分隔**而不是「字段：值」：
  //      摘要 乡村振兴评价是…
  //      作者 李沐纯 亢伊洋
  //      机构地区 华南理工大学旅游管理系
  //      出处 《广州社会主义学院学报》 2026年第2期94-105,共12页
  //      基金 广东省…
  //      关键词 乡村振兴 乡村振兴评价 …
  //      分类号 F323 [经济管理—产业经济]
  //    → 必须按「行首标签」匹配，不能用冒号切分。
  if (DETAIL) {
    const target = res.items[Math.min(DETAIL_IDX, res.items.length - 1)];
    if (!target || !target.url) {
      console.log('\n⚠️ 未取到详情页链接（结果为空？）');
    } else {
      console.log(`\n=== 详情页 [${DETAIL_IDX + 1}/${res.items.length}] ${target.url} ===`);
      await page.goto(target.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(6000);
      const d = await page.evaluate(() => {
        const lines = document.body.innerText.split('\n').map((s) => s.trim()).filter(Boolean);
        // ⚠️ 维普详情页的字段是**标签单独一行、值在下一行**：
        //      [21] "作者"
        //      [22] "李沐纯 亢伊洋"
        //      [23] "机构地区"
        //      [24] "华南理工大学旅游管理系"
        //    → 原实现只匹配 `l.startsWith(label + ' ')`（标签和值同一行）会**全部落空**。
        //      现在两种形态都支持：同行「标签 值」优先，其次「标签行 + 下一行」。
        const LABELS = ['摘要', '作者', '机构地区', '机构', '出处', '基金', '关键词', '分类号', 'DOI',
          'DOI号', '文章编号', '收稿日期', '修回日期', '出版日期', '被引量', '页码', 'ISSN'];
        const pick = (label) => {
          for (let i = 0; i < lines.length; i++) {
            const l = lines[i];
            if (l === label) {
              const nxt = lines[i + 1];
              if (nxt && !LABELS.includes(nxt)) return nxt;
            }
            if (l.startsWith(label + ' ') || l.startsWith(label + '：') || l.startsWith(label + ':')) {
              const v = l.slice(label.length).replace(/^[\s：:]+/, '').trim();
              if (v) return v;
            }
          }
          return '';
        };
        // 英文题名：紧跟中文题名的下一行（全英文）
        const iT = lines.findIndex((l) => l.includes('认领'));
        const enTitle = iT >= 0 && lines[iT + 1] && /^[A-Za-z]/.test(lines[iT + 1]) ? lines[iT + 1] : '';
        // ⚠️ 题名行会粘上 UI 文本，实测两种：
        //      "…框架建构  认领 被引量：1"   ← 有被引时
        //      "…未来展望 认领"              ← 无被引时
        //    → 统一在「认领」处截断，再去掉尾部的「被引量：N」。
        const cleanTitle = (s) => (s || '')
          .replace(/\s*认领\s*$/, '')
          .split(/\s+认领\s+/)[0]
          .replace(/\s*被引量\s*[:：]\s*\d+\s*$/, '')
          .replace(/\s{2,}/g, ' ')
          .trim();
        return {
          titleZh: cleanTitle(iT >= 0 ? lines[iT] : (lines[13] || '')),
          titleEn: enTitle,
          abstract: pick('摘要').replace(/\.\.\.\s*展开更多$/, '…'),
          authors: pick('作者'),
          org: pick('机构地区') || pick('机构'),
          source: pick('出处'),
          fund: pick('基金'),
          keywords: pick('关键词'),
          clc: pick('分类号'),
          doi: pick('DOI') || pick('DOI号'),
        };
      });
      const P = (k, v) => { if (v) console.log(`  ${k}: ${v}`); };
      P('题名', d.titleZh);
      P('英文题名', d.titleEn);
      P('作者', d.authors);
      P('机构', d.org);
      P('出处', d.source);
      P('基金', d.fund);
      P('关键词', d.keywords);
      P('分类号', d.clc);
      P('DOI', d.doi);
      P('摘要', d.abstract ? d.abstract.slice(0, 300) : '');

      // ---- 引用格式（自己拼）----
      const A = (d.authors || target.authors || '').split(/[\s,;，；、]+/)
        .map((s) => s.trim()).filter((s) => s && s.length >= 2 && /[\u4e00-\u9fa5A-Za-z·]/.test(s));
      const srcM = (d.source || '').match(/《([^》]+)》\s*(\d{4})\s*年\s*第\s*(\d+)\s*期\s*([\d\-–+]+)?/);
      const journal = srcM ? srcM[1] : (target.journal || '');
      const year = srcM ? srcM[2] : (target.year || '');
      const issue = srcM ? srcM[3] : (target.issue || '');
      const pages = srcM && srcM[4] ? srcM[4] : (target.pages || '');
      const titleTxt = d.titleZh || target.title;
      if (A.length && titleTxt && journal) {
        console.log('\n  --- 引用格式（自动生成）---');
        const gbAuthors = A.length > 3 ? `${A.slice(0, 3).join(',')},等` : A.join(',');
        console.log(`  GB/T 7714 : ${gbAuthors}.${titleTxt}[J].${journal},${year}(${issue}):${pages}.`);
        const mlaAuthor = A.length > 2 ? `${A[0]}, et al` : A.join(', ');
        console.log(`  MLA       : ${mlaAuthor}. "${titleTxt}." ${journal} ${issue} (${year}): ${pages}.`);
        const apaAuthors = A.length > 2 ? `${A.slice(0, 2).join(', ')}, & ${A[2]}` : A.join(', ');
        console.log(`  APA       : ${apaAuthors}. (${year}). ${titleTxt}. ${journal}, ${issue}, ${pages}.`);
      } else {
        console.log('\n  (作者/题名/刊名 不全，跳过引用格式)');
      }
    }
  }
} finally {
  await ctx.close().catch(() => {});
}
})();



if (fatalCode) process.exitCode = fatalCode;

