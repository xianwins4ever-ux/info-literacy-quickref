// ============================================================
// 全国标准信息公共服务平台 / 国家标准全文公开系统 CLI
//
// 用法:
//   node std.mjs "GB/T 5750.1-2023"          # 按标准号查
//   node std.mjs "生活饮用水标准检验方法"      # 按名称搜（列候选）
//   node std.mjs "GB/T 5750.1-2023" --json
//   node std.mjs "GB/T 5750.1-2023" --headed
//
// 逆向要点 (2026-10-10 实测):
//   1. 两个站点，分工不同：
//        std.samr.gov.cn        全国标准信息公共服务平台（检索入口，内容少）
//        openstd.samr.gov.cn    国家标准**全文公开系统**（详情页数据最全）★
//      详情页 URL 形如：
//        https://openstd.samr.gov.cn/bzgk/std/newGbInfo?hcno=<32位大写HEX>
//      **hcno 是详情页的主键**，同一个 hcno 在多个镜像站通用：
//        openstd.samr.gov.cn/bzgk/std/newGbInfo?hcno=XXX
//        www.spc.org.cn/online/<hcno小写>.html
//        main.spc.net.cn/bwonline/<hcno小写>.html
//   2. ⚠️ 详情页是**服务端渲染**，纯 HTTP 直接抓即可（无需浏览器）。
//      字段以「字段名 | 值 |」形式出现在 HTML 里，用正则从去标签文本里取最稳。
//   3. 关键字段（都在详情页）：
//        标准号 / 中文标准名称 / 英文标准名称 / 标准状态 /
//        中国标准分类号（CCS）/ **国际标准分类号（ICS）** /
//        **发布日期** / **实施日期** / 主管部门 / 归口部门 / 发布单位
//   4. ⚠️ **易混淆点（出题点）**：
//        发布日期  ≠  实施日期
//      例：GB/T 5750.1-2023  发布 2023-03-17，实施 2023-10-01。
//      题目常把「实施日期」写成「发布日期」来设错。
//   5. 检索：std.samr.gov.cn 的搜索接口为
//        GET /gb/search/gbQueryPage?searchText=<关键词>&current=1&size=10
//      返回 JSON（含 hcno），再用 hcno 去 openstd 取详情。
// ============================================================

import { playwrightCandidates, isFsPath, resolveProfile } from './_env.mjs';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36 Edg/154.0.0.0';

const argv = process.argv.slice(2);
const has = (f) => argv.includes('--' + f);
const kw = argv.find((a) => !a.startsWith('--'));

if (!kw) {
  console.error('用法: node std.mjs "<标准号|关键词>" [--json] [--headed]');
  process.exit(1);
}

// ⚠️ 该站偶发连接超时（实测 UND_ERR_CONNECT_TIMEOUT），必须带重试。
// ⚠️ 但默认 fetch **没有超时**，一旦挂住会拖很久（实测出现 37s）。
//    故：① 加 AbortSignal 硬超时（默认 8s）；② 缩短重试退避；③ 默认只试 2 次。
//    环境变量 STD_TIMEOUT_MS / STD_TRIES 可覆盖。
// ⚠️⚠️ 2026-10-10 实测：**Node 的 fetch 对 samr 系站点会 TLS 握手失败**
//    （`TypeError: fetch failed`，但 PowerShell 的 Invoke-WebRequest 200 OK、
//      TCP 443 也通）—— 这是 Node undici 的 TLS 栈与该站不兼容，不是网络问题。
//    故 get() 在 Node 失败后**自动回退到浏览器**（页面内 fetch）。
const TIMEOUT_MS = Number(process.env.STD_TIMEOUT_MS || 8000);
const TRIES = Number(process.env.STD_TRIES || 2);

let _bctx = null;
async function browserGet(url, timeoutMs = 20000) {
  const { pathToFileURL } = await import('node:url');
  const CAND = [...playwrightCandidates(), 'playwright-core'];
  let chromium = null;
  for (const c of CAND) {
    try {
      const m = isFsPath(c) ? await import(pathToFileURL(c).href) : await import(c);
      chromium = (m.default ?? m).chromium;
      if (chromium) break;
    } catch { /* 下一个 */ }
  }
  if (!chromium) throw new Error('找不到 playwright-core，无法回退浏览器');
  if (!_bctx) {
    const ctx = await chromium.launchPersistentContext(
      resolveProfile('std-profile', 'STD_PROFILE'),
      {
        channel: 'msedge', headless: true, locale: 'zh-CN', userAgent: UA,
        // ⚠️ 只加 stealth 参数，**不要**用 addInitScript 改 navigator.webdriver
        //    （实测会被 WAF 识破；详见 nmpa.mjs 的三组对照）
        args: ['--disable-blink-features=AutomationControlled'],
      });
    _bctx = { ctx, page: ctx.pages()[0] || await ctx.newPage() };
  }
  const page = _bctx.page;
  const html = await page.evaluate(async ([u, tmo]) => {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), tmo);
    try {
      const r = await fetch(u, { signal: ac.signal });
      const txt = await r.text();
      clearTimeout(t);
      return { status: r.status, text: txt };
    } catch (e) {
      clearTimeout(t);
      return { err: String(e).slice(0, 100) };
    }
  }, [url, timeoutMs]);
  if (html.err) throw new Error(html.err);
  return html;
}

async function closeBrowser() {
  if (_bctx) { await _bctx.ctx.close().catch(() => {}); _bctx = null; }
}

async function get(url, tries = TRIES, timeoutMs = TIMEOUT_MS) {
  let lastErr = null;
  for (let i = 0; i < tries; i++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': UA,
          Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
          'Accept-Language': 'zh-CN,zh;q=0.9',
        },
        redirect: 'follow',
        signal: ac.signal,
      });
      const text = await res.text();
      clearTimeout(timer);
      return { status: res.status, text };
    } catch (e) {
      clearTimeout(timer);
      lastErr = e;
      if (i < tries - 1) await new Promise((r) => setTimeout(r, 400 * (i + 1)));
    }
  }
  // Node fetch 全失败 → 回退浏览器（解决 undici 的 TLS 不兼容）
  process.stderr.write('  [fallback] Node fetch 失败，改用浏览器…\n');
  try {
    return await browserGet(url);
  } catch (e2) {
    throw new Error(`Node 与浏览器均失败：${String(lastErr).slice(0, 60)} / ${String(e2).slice(0, 60)}`);
  }
}

// 从详情页 HTML 里抽字段
// ⚠️ 用「切成单元格再取标签后的第一个非空格」的办法，比单条正则稳得多。
//    页面去标签后形如：
//      ... | 标准号：GB/T 5750.1-2023 | | 中文标准名称： | 生活饮用水标准检验方法 第1部分：总则 |
//          | 中国标准分类号（CCS） | | C51 | | 国际标准分类号（ICS） | | 13.060 | | 发布日期 | | 2023-03-17 |
//    即同一个标签可能是「标签：值」也可能是「标签 | 值」，还夹着空单元格。
function parseDetail(html) {
  const t = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, '|')
    .replace(/&nbsp;/g, ' ')
    .replace(/&times;/g, 'x')
    .replace(/[ \t\r\n]+/g, ' ');

  const cells = t.split('|').map((s) => s.trim());

  const grab = (label) => {
    for (let i = 0; i < cells.length; i++) {
      const c = cells[i];
      if (!c) continue;
      // 形态一：单元格以「标签：」开头，值在同一格
      if (c === label + '：' || c === label + ':') {
        for (let j = i + 1; j < Math.min(i + 4, cells.length); j++) {
          if (cells[j]) return cells[j];
        }
        continue;
      }
      if (c.startsWith(label + '：') || c.startsWith(label + ':')) {
        const v = c.replace(new RegExp('^' + label + '\\s*[:：]\\s*'), '').trim();
        if (v) return v;
      }
      // 形态二：单元格恰为标签，值在后面的第一个非空格
      if (c === label) {
        for (let j = i + 1; j < Math.min(i + 5, cells.length); j++) {
          if (cells[j]) return cells[j];
        }
      }
    }
    return null;
  };

  return {
    标准号: grab('标准号'),
    中文标准名称: grab('中文标准名称'),
    英文标准名称: grab('英文标准名称'),
    标准状态: grab('标准状态'),
    CCS: grab('中国标准分类号（CCS）'),
    ICS: grab('国际标准分类号（ICS）'),
    发布日期: grab('发布日期'),
    实施日期: grab('实施日期'),
    主管部门: grab('主管部门'),
    归口部门: grab('归口部门'),
    发布单位: grab('发布单位'),
  };
}

// 用 std.samr.gov.cn 检索拿 id(=hcno) 与基础字段
// ⚠️ 返回 JSON 的字段名（实测）：
//   id(=hcno) / C_C_NAME(中文名) / C_STD_CODE(标准号，含 <sacinfo> 标签) /
//   STD_NATURE(推荐性|强制性) / **ISSUE_DATE(发布日期)** / **ACT_DATE(实施日期)** /
//   STATE(现行|废止) / PROJECT_ID
// 注意：ISSUE_DATE 是**发布**，ACT_DATE 是**实施** —— 别搞反，这正是常见出题点。
async function searchStd(keyword) {
  const urls = [
    `https://std.samr.gov.cn/gb/search/gbQueryPage?searchText=${encodeURIComponent(keyword)}&current=1&size=10`,
  ];
  for (const u of urls) {
    try {
      const { text } = await get(u);
      const j = JSON.parse(text);
      const rows = j.rows || (j.data && j.data.rows) || [];
      if (rows.length) return rows;
    } catch { /* 换下一个 */ }
  }
  return [];
}

const t0 = Date.now();
let detail = null;
let viaLabel = '';
const stripTags = (s) => (s || '').replace(/<[^>]+>/g, '').trim();

// 路线 A：std.samr.gov.cn 检索 → 拿 id(=hcno) → openstd 取详情
// ---- 链路：gbQueryPage(基础字段) + spc(取 hcno) → openstd(完整详情) ----
// ⚠️ 重要：gbQueryPage 返回的 `id` **不是** openstd 的 hcno，两者不同源，
//    拿 id 去 newGbInfo 会得到一个不含 ICS/实施日期 的空壳页（实测踩坑）。
//    正确的 hcno 来源是 **spc.org.cn 的检索页**，页内链接形如
//      /online/<hcno小写>.html
//    取出后转大写即可喂给 openstd。
const rows = await searchStd(kw);
let base = null;
if (rows.length) {
  base = rows[0];
  console.log(`=== 检索「${kw}」命中 ${rows.length} 条，取第 1 条 ===`);
  console.log(`  标准号: ${stripTags(base.C_STD_CODE)}   [${base.STD_NATURE || ''}${base.STATE || ''}]`);
  console.log(`  名称  : ${stripTags(base.C_C_NAME)}`);
  console.log(`  发布  : ${base.ISSUE_DATE || '-'}    实施: ${base.ACT_DATE || '-'}`);
}

// 取 hcno：用标准号去 spc 搜（比关键词更准）
// ⚠️ spc.org.cn 是最慢的一环（实测偶发 30s+ 超时）。
//    策略：给它**更短的超时**（5s）、**只试 1 次**，失败就跳过 —— 
//    退化成只用 gbQueryPage 的字段（名称/发布/实施/状态，这些通常已足够答题），
//    而不是让整个命令卡住半分钟。
const searchTerm = base ? stripTags(base.C_STD_CODE) : kw;
let hcno = null;

// 路线 1（首选，2026-10-17 新增）：openstd 自己的列表页
//   https://openstd.samr.gov.cn/bzgk/gb/std_list?p.p1=0&p.p2=<标准号>
//   每行一个 <tr>，行内 onclick="showInfo('<32位HEX>')" ← **这个 HEX 就是 hcno**
//   ⚠️ 列表可能同时返回同一标准的多个版本（实测 5750.1 有 2006 与 2023 两条），
//      必须按标准号**精确匹配那一行**，否则会拿到旧版的 hcno。
//   这条路 2.4s，且 spc.org.cn 已经连续超时（2026-10-17 实测 8s 无响应）。
const norm = (s) => (s || '').replace(/[\s\u00a0]+/g, '').toUpperCase();
try {
  const { text } = await get(
    `https://openstd.samr.gov.cn/bzgk/gb/std_list?p.p1=0&p.p2=${encodeURIComponent(searchTerm)}`, 2, 6000);
  const want = norm(searchTerm);
  for (const row of text.split(/<tr[\s>]/i)) {
    const plain = norm(row.replace(/<[^>]+>/g, ' '));
    if (!plain.includes(want)) continue;
    const m = row.match(/showInfo\('([0-9A-Fa-f]{32})'\)/);
    if (m) { hcno = m[1].toUpperCase(); break; }
  }
  if (hcno) viaLabel = `openstd-list→hcno=${hcno}`;
} catch (e) {
  console.error(`  ⚠️ openstd 列表页失败，改试 spc…`);
}

// 路线 2（备用）：spc.org.cn 检索页 → /online/<hcno>.html
if (!hcno) {
  try {
    const { text } = await get(
      `https://www.spc.org.cn/basicsearch?text=${encodeURIComponent(searchTerm)}`, 1, 3000);
    const m = text.match(/(?:online|bwonline)\/([0-9a-fA-F]{32})\.html/);
    if (m) hcno = m[1].toUpperCase();
  } catch (e) {
    console.error(`  ⚠️ spc 站点响应超时，跳过 CCS/ICS（不影响名称/发布/实施/状态）`);
  }
}

if (hcno) {
  try {
    const { text } = await get(`https://openstd.samr.gov.cn/bzgk/std/newGbInfo?hcno=${hcno}`, 2, 6000);
    const d = parseDetail(text);
    // 校验：详情页标准号必须与要查的一致，防止 spc 搜出别的标准
    const want = searchTerm.replace(/\s+/g, '').toUpperCase();
    const got = (d['标准号'] || '').replace(/\s+/g, '').toUpperCase();
    if (got && (got === want || got.includes(want) || want.includes(got))) {
      detail = d;
      if (!viaLabel) viaLabel = `hcno=${hcno}`;
    } else if (got) {
      console.log(`  ⚠️ hcno 命中的是「${d['标准号']}」，与查询不符，已丢弃详情`);
    }
  } catch (e) {
    console.error(`  ⚠️ 详情页响应超时，跳过 CCS/ICS`);
  }
}

// 合并：详情页优先，缺失的用检索接口补
if (!detail) detail = {};
if (base) {
  if (!detail['标准号']) detail['标准号'] = stripTags(base.C_STD_CODE);
  if (!detail['中文标准名称']) detail['中文标准名称'] = stripTags(base.C_C_NAME);
  if (!detail['发布日期']) detail['发布日期'] = base.ISSUE_DATE || null;
  if (!detail['实施日期']) detail['实施日期'] = base.ACT_DATE || null;
  if (!detail['标准状态']) detail['标准状态'] = base.STATE || null;
}

if (!detail || !detail['标准号']) {
  console.log(`(未取到详情) 关键词「${kw}」`);
  console.log('提示：可换用完整标准号，或到 https://std.samr.gov.cn/gb/search/gbQueryPage 查 hcno。');
  process.exit(2);
}

if (has('json')) {
  console.log(JSON.stringify({ source: viaLabel, ...detail }, null, 2));
} else {
  console.log(`\n=== ${detail['标准号']} ===`);
  const show = ['中文标准名称', '英文标准名称', '标准状态', 'CCS', 'ICS', '发布日期', '实施日期', '主管部门', '归口部门', '发布单位'];
  for (const k of show) {
    if (detail[k]) console.log(`  ${k.padEnd(6, '　')}: ${detail[k]}`);
  }
  console.log('\n  ⚠️ 注意区分：发布日期 ≠ 实施日期');
}
await closeBrowser();
console.log(`ELAPSED = ${((Date.now() - t0) / 1000).toFixed(1)}s`);
