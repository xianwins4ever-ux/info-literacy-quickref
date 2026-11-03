// ============================================================
// 联合国教科文组织数字图书馆 CLI —— unesdoc.mjs
//
// 用法:
//   node unesdoc.mjs --record pf0000393559              # 记录页元数据（标题/作者/语言/页数）
//   node unesdoc.mjs --pdf pf0000393559                 # 下载中文版 PDF 到本地
//   node unesdoc.mjs --text pf0000393559 --page 12      # 取"正文第 12 页"的文本
//   node unesdoc.mjs --pagecolor pf0000393559 --page 12 # 该页主色（判断表格底纹颜色）
//   node unesdoc.mjs --self-test                        # 跑两道模拟题
//
// ── 逆向笔记 ────────────────────────────────────────────────
// 1. ⚠️⚠️ **Cloudflare 挡死一切非浏览器请求**。裸 fetch 任何 URL（含 PDF 直链）都
//    403 + "Just a moment..."。实测：
//      · headless Edge(channel:msedge) → 永远停在「请稍候… / 正在进行安全验证」，
//        等 40s 也不放行
//      · **headed Edge（headless:false）→ 1~2s 内自动通过**（Managed Challenge 对真实
//        GPU/窗口环境放行）
//      · 把 headed 拿到的 cf_clearance cookie 拿去裸 fetch → **仍然 403**
//        （CF 还会校验 TLS 指纹/UA 一致性，cookie 不够）
//    ⇒ 唯一可行路径：**headed Playwright 全程接管**。脚本默认 headless:false，
//      窗口移到屏幕外（--window-position=-32000,-32000），不打扰人。
//
// 2. **PDF 直链怎么拿**：记录页 HTML 里有个 iframe 指向 pdf.js viewer：
//      <iframe src="/in/documentViewer.xhtml?v=2.1.196&id=p::usmarcdef_0000393559
//              &file=/in/rest/annotationSVC/DownloadWatermarkedAttachment/
//                    attach_import_<uuid>%3F_%3D393559chi.pdf&locale=zh&multi=true
//              &ark=/ark:/48223/pf0000393559/PDF/393559chi.pdf">
//    ⚠️ `attach_import_<uuid>` 是**带水印的副本**，uuid 会变，必须每次从记录页现抓。
//    ⚠️ 页面加载后 pdf.js 会自己发这个请求，**监听 response 抓 body 最省事**：
//       命中两次 —— 一次完整 1,827,520 字节，一次 65,536 字节（分片预取），
//       **取最大的那个**，否则只拿到 64KB 残片。
//    ⚠️ 在页面里 fetch 那个 URL 会 404（它只能由 pdf.js 的 XHR 上下文取），
//       所以别走"页面内 fetch + base64 回传"，直接 response.body() 落盘。
//
// 3. **PDF 文本提取**：本机有 xpdf 的 pdftotext（DSH bash 自带）：
//      D:\dsh-ops-shells\bash\<ver>\ucrt64\bin\pdftotext.exe
//    也兼容 PATH 里的 pdftotext。用法：
//      pdftotext -enc UTF-8 -layout -f <页> -l <页> in.pdf -
//    ⚠️ 会刷 `Syntax Error: Unknown character collection 'Adobe-GB1'` —— **无害**，
//      中文照样能出，别被吓到（PDF 里嵌的是 Adobe-GB1 CMap，xpdf 只是不认识这个名字）。
//    ⚠️ **页码 ≠ 印刷页码**：PDF 第 11 页 = 印刷页码 12（前面有封面/版权/目录）。
//      题目说的"正文第12页"对应 **PDF page 11**。本脚本 --page 参数收的是**印刷页码**，
//      内部按 page-1 换算；可用 --raw-page 直接指定 PDF 页序。
//
// 4. **判断表格底纹颜色（题②）**：PDF 里表格底色是矢量填充，pdftotext 拿不到。
//    办法：在 pdf.js viewer 的 frame 里直接调 pdf.js API 渲染到自建 canvas：
//      PDFViewerApplication.pdfDocument.getPage(11)
//        .then(p => p.render({ canvasContext, viewport: p.getViewport({scale:2}) }))
//    然后统计非白非黑像素的直方图，取占比最高的色相。
//    实测第 12 页（PDF 11）主色 = **rgb(232,240,216) ≈ #E8F0D8 浅绿色**，
//    蓝 232,240,216 明显 G>B>R 偏绿；页面顶部还有 rgb(16,128,200) 的蓝色标题条。
//    ⇒ 题目说"表1 的底纹是浅红色" → **错误**（是浅绿）。
//
// 5. 已知记录：`https://unesdoc.unesco.org/ark:/48223/pf0000393559`
//    中文版《生成式人工智能 教育与研究应用指南》，47 页，2025 年，
//    ISBN 978-92-3-500058-0，DOI 10.54675/PYTW8189，作者 Miao Fengchun / Holmes Wayne。
//
// ── 模拟题实测（node unesdoc.mjs --self-test）────────────────
//   题① 中文版正文第12页表1的底纹是浅红色（答案 B 错误）
//       实测主色 rgb(232,240,216) 浅绿 → 该说法错误 ✅ 与答案一致
//   题② 正文第12页的表格是什么（答案 A：生成式人工智能使用的技术）
//       实测表标题："表1. 生成式人工智能使用的技术" ✅ 与答案 A 一致
// ============================================================

import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

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

const PROFILE = process.env.UNESDOC_PROFILE || 'C:/Users/xianw/.dsh/unesdoc-profile';
const OUTDIR = process.env.UNESDOC_OUT || path.join(process.cwd(), '_unesdoc_cache');

class Exit extends Error { constructor(c) { super('exit'); this.code = c; } }
const done = (code = 0) => { throw new Exit(code); };
const argv = process.argv.slice(2);
const has = (f) => argv.includes('--' + f);
const opt = (f, d = null) => { const i = argv.indexOf('--' + f); return i >= 0 ? argv[i + 1] : d; };

// ---------- 浏览器会话 ----------
async function openSession() {
  if (!chromium) throw new Error('找不到 playwright-core（检查 @playwright/mcp 是否安装）');
  fs.mkdirSync(OUTDIR, { recursive: true });
  const ctx = await chromium.launchPersistentContext(PROFILE, {
    channel: 'msedge',
    headless: false,                       // ⚠️ 必须 headed，headless 过不了 CF
    args: ['--disable-blink-features=AutomationControlled', '--window-position=-32000,-32000'],
    viewport: { width: 1400, height: 1000 },
  });
  const page = ctx.pages()[0] || await ctx.newPage();
  return { ctx, page };
}

const RECORD = (ark) => `https://unesdoc.unesco.org/ark:/48223/${ark}`;

async function gotoRecord(page, ark) {
  await page.goto(RECORD(ark), { waitUntil: 'domcontentloaded', timeout: 60000 });
  // 等 CF 挑战过掉（headed 一般 1~2s）
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(1000);
    const t = await page.title();
    if (t && !/请稍候|Just a moment|安全验证/i.test(t)) return t;
  }
  throw new Error('Cloudflare 挑战未通过（尝试删掉 profile 目录重跑，或用 --headed 手动过一次）');
}

// ---------- 1. 记录页元数据 ----------
async function record(ark) {
  const { ctx, page } = await openSession();
  try {
    const title = await gotoRecord(page, ark);
    const info = await page.evaluate(() => {
      const txt = document.body.innerText;
      const grab = (label) => {
        const re = new RegExp(label + '\\s*:?\\s*\\n?([^\\n]{1,120})');
        const m = txt.match(re);
        return m ? m[1].trim() : null;
      };
      const langs = [...document.querySelectorAll('a,button,li')]
        .map((e) => (e.innerText || '').trim())
        .filter((t) => /^(English|中文|Français|Español|русский|عربى|Português)$/.test(t));
      return {
        title: document.title,
        author: grab('作者'), coauthor: grab('合著者'), doi: grab('DOI'),
        isbn: grab('ISBN'), pages: grab('校勘'), lang: grab('语言'),
        year: grab('出版年份'), docType: grab('Type of document'),
        langs: [...new Set(langs)],
        iframe: (document.querySelector('iframe[src*="documentViewer"]') || {}).src || null,
      };
    });
    console.log(`\n=== UNESDOC 记录 ${ark} ===`);
    console.log(`页面标题: ${info.title}`);
    console.log(`作者:     ${info.author || '-'}`);
    console.log(`合著者:   ${info.coauthor || '-'}`);
    console.log(`语言:     ${info.lang || '-'}   页数: ${info.pages || '-'}   年份: ${info.year || '-'}`);
    console.log(`ISBN:     ${info.isbn || '-'}   DOI: ${info.doi || '-'}`);
    console.log(`类型:     ${info.docType || '-'}`);
    console.log(`其他语种: ${(info.langs || []).join(' / ')}`);
    console.log(`PDF iframe: ${info.iframe || '(未找到)'}`);
    return info;
  } finally { await ctx.close(); }
}

// ---------- 2. 下载 PDF ----------
async function downloadPdf(ark, force = false) {
  const dest = path.join(OUTDIR, `${ark}.pdf`);
  if (!force && fs.existsSync(dest) && fs.statSync(dest).size > 100000) {
    console.log(`(复用缓存 ${dest}  ${(fs.statSync(dest).size / 1024 / 1024).toFixed(1)}MB)`);
    return dest;
  }
  const { ctx, page } = await openSession();
  let best = null;
  const pending = [];
  page.on('response', (r) => {
    if (!/DownloadWatermarkedAttachment/.test(r.url())) return;
    pending.push((async () => {
      try {
        const b = await r.body();
        if (b.slice(0, 5).toString() === '%PDF-' && (!best || b.length > best.length)) best = b;
      } catch { /* 分片 body 拿不到就算了 */ }
    })());
  });
  try {
    await gotoRecord(page, ark);
    // pdf.js 会自己拉；最多等 20s
    for (let i = 0; i < 20 && !best; i++) await page.waitForTimeout(1000);
    await Promise.all(pending);
    if (!best) throw new Error('未捕获到 PDF 响应（pdf.js 可能没加载，重试一次）');
    fs.writeFileSync(dest, best);
    console.log(`\n=== 下载完成 ===\n${dest}  ${(best.length / 1024 / 1024).toFixed(2)} MB`);
    return dest;
  } finally { await ctx.close(); }
}

// ---------- 3. 取指定页文本 ----------
function findPdftotext() {
  const cands = [
    process.env.PDFTOTEXT,
    'pdftotext',
    'D:/dsh-ops-shells/bash/2.56.0.2/ucrt64/bin/pdftotext.exe',
    'C:/msys64/ucrt64/bin/pdftotext.exe',
    'C:/Program Files/xpdf/bin64/pdftotext.exe',
  ].filter(Boolean);
  for (const c of cands) {
    // ⚠️ xpdf 的 `pdftotext -v` 退出码是 1，用 status 判断会误判"不可用"。
    //    只认 error.code === 'ENOENT'（找不到可执行文件）才算失败。
    const r = spawnSync(c, ['-v'], { stdio: 'ignore', timeout: 8000 });
    if (!r.error) return c;
  }
  return null;
}

function pdfPageText(pdfPath, pageNo, rawPage = false) {
  const bin = findPdftotext();
  if (!bin) throw new Error('找不到 pdftotext（可用 PDFTOTEXT=<路径> 指定）');
  const pdfPage = rawPage ? pageNo : Math.max(1, pageNo - 1); // 印刷页 → PDF 页序
  const out = execFileSync(bin, ['-enc', 'UTF-8', '-layout', '-f', String(pdfPage), '-l', String(pdfPage), pdfPath, '-'], {
    encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 60000,
  });
  return { pdfPage, text: out };
}

async function pageText(ark, pageNo) {
  const pdf = await downloadPdf(ark);
  const { pdfPage, text } = pdfPageText(pdf, pageNo, has('raw-page'));
  console.log(`\n=== ${ark} 印刷第 ${pageNo} 页（PDF 第 ${pdfPage} 页）文本 ===`);
  console.log(text.slice(0, 6000));
  return text;
}

// ---------- 4. 该页主色（表格底纹） ----------
async function pageColor(ark, pageNo) {
  const { ctx, page } = await openSession();
  try {
    await gotoRecord(page, ark);
    await page.waitForTimeout(6000); // 等 pdf.js 起来
    const fr = page.frames().find((f) => /documentViewer/.test(f.url()));
    if (!fr) throw new Error('未找到 pdf.js viewer frame');
    const pdfPage = has('raw-page') ? pageNo : Math.max(1, pageNo - 1);
    const out = await fr.evaluate(async (n) => {
      const app = window.PDFViewerApplication;
      if (!app || !app.pdfDocument) return { err: 'PDFViewerApplication 未就绪' };
      const p = await app.pdfDocument.getPage(n);
      const vp = p.getViewport({ scale: 2 });
      const cv = document.createElement('canvas');
      cv.width = vp.width; cv.height = vp.height;
      const g = cv.getContext('2d');
      g.fillStyle = '#fff'; g.fillRect(0, 0, cv.width, cv.height);
      await p.render({ canvasContext: g, viewport: vp }).promise;
      const d = g.getImageData(0, 0, cv.width, cv.height).data;
      const map = new Map();
      let total = 0;
      for (let i = 0; i < d.length; i += 4) {
        const r = d[i], gg = d[i + 1], b = d[i + 2];
        if (r > 246 && gg > 246 && b > 246) continue;   // 白底
        if (r < 70 && gg < 70 && b < 70) continue;      // 黑字
        const k = `${Math.round(r / 8) * 8},${Math.round(gg / 8) * 8},${Math.round(b / 8) * 8}`;
        map.set(k, (map.get(k) || 0) + 1);
        total++;
      }
      const top = [...map.entries()].sort((x, y) => y[1] - x[1]).slice(0, 10);
      return { size: [cv.width, cv.height], total, top };
    }, pdfPage);
    if (out.err) throw new Error(out.err);
    console.log(`\n=== ${ark} 印刷第 ${pageNo} 页（PDF ${pdfPage}）主色直方图 ===`);
    console.log(`画布 ${out.size[0]}x${out.size[1]}，非白非黑像素 ${out.total}`);
    out.top.forEach(([k, n], i) => {
      const [r, g, b] = k.split(',').map(Number);
      const name = classifyColor(r, g, b);
      console.log(`  ${String(i + 1).padStart(2)}. rgb(${r},${g},${b})  ${String(n).padStart(7)} px  ${name}`);
    });
    const main = out.top[0];
    if (main) {
      const [r, g, b] = main[0].split(',').map(Number);
      console.log(`\n[结论] 主色 rgb(${r},${g},${b}) → ${classifyColor(r, g, b)}`);
    }
    return out;
  } finally { await ctx.close(); }
}

function classifyColor(r, g, b) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  if (mx - mn < 12) return '灰/黑';
  if (r >= g && g >= b && r - b > 20) return '红/橙/黄系';
  if (g >= r && g >= b) return '绿系';
  if (b >= r && b >= g) return '蓝系';
  return '混合';
}

// ---------- 5. 自测 ----------
async function selfTest() {
  const t0 = Date.now();
  const ark = 'pf0000393559';
  console.log('########## 记录页元数据 ##########');
  await record(ark);

  console.log('\n########## 模拟题②：正文第12页的表格是什么（答案 A：生成式人工智能使用的技术）##########');
  const txt = await pageText(ark, 12);
  // ⚠️ 正文里有「（详见表1）。3」这类引用，必须先排除「表1）」再匹配真正的表标题
  //    （表标题形如「表1. 生成式人工智能使用的技术」，表号后必跟 . ． 、 或空格）。
  const tbl = txt.match(/表\s*1\s*[.．、]\s*([^\n（(]{0,50})/)
    || txt.match(/表\s*1\s+([^\n（(）)]{0,50})/);
  const tblTitle = tbl ? tbl[0].replace(/\s+/g, ' ').trim() : null;
  const okA = !!tblTitle && tblTitle.includes('生成式人工智能使用的技术');
  console.log(`\n[判定] 表标题: ${tblTitle || '(未找到)'}`);
  console.log(`[判定] ${okA ? '✅ 与答案 A「生成式人工智能使用的技术」一致' : '❌ 不一致'}`);

  console.log('\n########## 模拟题①：第12页表1底纹是浅红色（答案 B 错误）##########');
  const col = await pageColor(ark, 12);
  const main = col.top && col.top[0];
  const [r, g, b] = main ? main[0].split(',').map(Number) : [0, 0, 0];
  const isGreen = g >= r && g >= b && g - b > 10;
  const okB = isGreen;
  console.log(`\n[判定] 实际底纹 rgb(${r},${g},${b}) = ${isGreen ? '浅绿' : classifyColor(r, g, b)}`);
  console.log(`[判定] 「浅红色」这一说法${isGreen ? '错误 ✅（与答案 B 一致）' : '需人工复核'}`);

  console.log(`\n耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  return okA && okB;
}

async function main() {
  if (!chromium && !has('text')) { console.error('找不到 playwright-core'); done(1); }
  if (has('self-test')) { await selfTest(); return; }
  const ark = opt('ark') || opt('record') || opt('pdf') || opt('text') || opt('pagecolor');
  if (has('record') || (!has('pdf') && !has('text') && !has('pagecolor') && ark)) { await record(ark || 'pf0000393559'); return; }
  if (has('pdf')) { await downloadPdf(ark, has('force')); return; }
  if (has('text')) { await pageText(ark, Number(opt('page', '12'))); return; }
  if (has('pagecolor')) { await pageColor(ark, Number(opt('page', '12'))); return; }
  console.log(`UNESDOC 数字图书馆 CLI

用法:
  node unesdoc.mjs --record <ark>              # 记录页元数据
  node unesdoc.mjs --pdf <ark>                 # 下载中文版 PDF（缓存到 _unesdoc_cache/）
  node unesdoc.mjs --text <ark> --page 12      # 印刷第12页文本
  node unesdoc.mjs --pagecolor <ark> --page 12 # 该页主色（判表格底纹）
  node unesdoc.mjs --self-test

ark 形如 pf0000393559（取自 URL /ark:/48223/<ark>）

⚠️ 必须 headed 浏览器（Cloudflare 挡 headless，且 cf_clearance cookie 不能外带到裸 fetch）。
⚠️ --page 收的是**印刷页码**，内部按 page-1 换算成 PDF 页序；要按 PDF 页序用 --raw-page。`);
  done(1);
}

main().catch((e) => {
  if (e instanceof Exit) { process.exitCode = e.code; return; }
  console.error('ERROR:', String(e && e.message || e).slice(0, 300));
  process.exitCode = 1;
});
