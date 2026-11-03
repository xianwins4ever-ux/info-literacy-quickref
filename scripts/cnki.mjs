// ============================================================
// 中国知网（CNKI）高级检索 CLI  —— v2（2026-10-17 增强）
//
// 用法:
//   node cnki.mjs --ti 人工智能 --top 10
//   node cnki.mjs --au 丁耘 --src 中国社会科学 --from 2013 --to 2022
//   node cnki.mjs --ti "AI + 人工智能" --su "法律 + 法规" --from 2020 --to 2024 --db journal
//   node cnki.mjs --su "数字经济 * 税收" --facet author          # 看发文量最多的作者
//   node cnki.mjs --su 区块链 --db thesis --facet institution    # 学位论文按单位分布
//   node cnki.mjs --kw 深度学习 --db journal --facet all
//
// 条件参数（每个对应一行检索条件，行间默认 AND）:
//   --su   主题      --ti  篇名       --kw  关键词
//   --au   作者      --fi  第一作者    --src 文献来源
//   --ab   摘要      --tka 篇关摘
//
// 选项:
//   --from <年> / --to <年>     发表时间范围
//   --db <库>                   结果页切换到指定库:
//                               journal(学术期刊) thesis(学位论文) book(图书)
//                               conference(会议) newspaper(报纸) all(总库，默认)
//   --facet <名称>              打印指定分面（作者/机构/文献来源/来源类别/学科/年度/主题）
//   --facet all                 打印全部分面
//   --top <N>                   列出前 N 条（默认 20）
//   --json / --headed
//
// 逆向要点（v2 新增部分）:
//   1. ⚠️ **结果页 URL 不变**（POST /kns8s/brief/grid 渲染），无法用 URL 复现检索，只能走表单。
//   2. **分面 DOM**（本题库最有价值的部分）:
//        #divGroup
//          └─ dl[groupid="ZYZT|||CYZT"]          ← 一个分面分组
//               ├─ dt > b                          ← 分组名（主题/作者/机构/…）
//               └─ dd[field="ZYZT"][tit="主要主题"]
//                    └─ ul > li > a(名称) + span(数量)
//      实测存在的分组：主题 / 来源类别 / 学科 / 研究层次 / 年度 / 文献类型 /
//                     文献来源 / **作者** / **机构** / 基金 / OA出版
//      → 「发文量最多的作者」「论文最多的单位」这类题，直接读 `作者`/`机构` 分面的第一个条目。
//   3. **库切换**：结果页顶部有「总库 / 学术期刊 / 学位论文 / 图书 / 会议 / 报纸 / 年鉴…」，
//      每项后面跟着条数，是可点击的 tab。切换后 URL 仍不变，需重新解析。
//   4. 高级检索语法（页面原文）：
//        * 与   + 或   - 非   ''/"" 词组   () 定优先级
//        ⚠️ 检索框内不超过 120 字符
//        ⚠️ **同一字段内的「或」必须用括号包住**，不要把 OR 拆成独立行——
//           行间只有 AND/OR 下拉、没有括号，混用时会按「AND 优先」错误结合。
//           实测：`篇名 AI OR 篇名 人工智能 AND 主题 法律 OR 主题 法规`
//           → 被解析成 `AI OR (人工智能 AND 法律) OR 法规`，结果 4169（错）
//           正确写法：`篇名 ("AI"+"人工智能") AND 主题 ("法律"+"法规")` → 4290
//   5. ⚠️ **引号/括号必须是英文半角**。实测全角弯引号 `“AI”` 得 1870，
//      半角 `"AI"` 得 2365，差一千多条。
//   6. 提交按钮 `input.btn-search` **必须 JS click**（Playwright locator 点击会 5s 超时）。
//   7. 时间框 `input.publishdate` 是 **readonly**，须先 removeAttribute 再设值并派发事件。
//   8. 滑块：kns.cnki.net 有 blockPuzzle，风险触发式；本脚本含自动破解（掩膜亮度差法）。
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
const PROFILE = resolveProfile('cnki-profile', 'CNKI_PROFILE');
const PAGE = 'https://kns.cnki.net/kns8s/AdvSearch';

const argv = process.argv.slice(2);
const has = (f) => argv.includes('--' + f);
const opt = (f, d = null) => { const i = argv.indexOf('--' + f); return i >= 0 ? argv[i + 1] : d; };

async function main() {
  if (!chromium) { console.error('找不到 playwright-core'); process.exitCode = 1; return; }

  if (has('help') || argv.length === 0) {
    console.log(`CNKI 高级检索 CLI

用法: node cnki.mjs [条件...] [选项]

条件（每个参数 = 一行检索条件，行间 AND）:
  --su  <词>   主题        --ti <词>   篇名       --tka <词> 篇关摘
  --kw  <词>   关键词      --au <词>   作者
  --fi  <词>   第一作者    --src <词>  文献来源   --ab <词>  摘要

选项:
  --from <年> / --to <年>   发表时间
  --db journal|thesis|book|conference|newspaper|all   切换结果库
  --facet author|institution|source|subject|year|all  打印分面
  --top <N>                 列出前 N 条（默认 20）
  --json / --headed

示例:
  node cnki.mjs --ti "AI + 人工智能" --su "法律 + 法规" --from 2020 --to 2024 --db journal
  node cnki.mjs --su "数字经济 * 税收" --facet author
  node cnki.mjs --su 区块链 --db thesis --facet institution

检索语法:
  * 与   + 或   - 非   '' "" 词组   () 定优先级
  ⚠️ 同一字段内的「或」必须用括号：--su "(法律 + 法规)"，不要拆成两行`);
    process.exitCode = argv.length === 0 ? 1 : 0;
    return;
  }

  // ---- 参数 → CNKI 字段 ----
  const FIELD_MAP = {
    su: '主题', ti: '篇名', tka: '篇关摘', kw: '关键词',
    au: '作者', fi: '第一作者', src: '文献来源', ab: '摘要',
  };
  const FIELD_CODE = {
    su: 'SU', ti: 'TI', tka: 'TKA', kw: 'KY', au: 'AU', fi: 'FI', src: 'LY', ab: 'AB',
  };
  const want = [];
  for (const [k, label] of Object.entries(FIELD_MAP)) {
    const v = opt(k);
    if (v) want.push({ key: k, field: label, code: FIELD_CODE[k], value: v });
  }
  // ⚠️ `--filter <原始检索式>`：追加到**最后一行**的检索值里（用 AND 连接）。
  //    ⚠️ 注意：高级检索表单是「一行一个字段」，没有独立的"原始检索式"输入框，
  //    所以 filter 会被拼到第一个条件的值后面。若要写真正的复杂检索式，
  //    请用专业检索（`?type=expert`），字段代码见文件头。
  const filterRaw = opt('filter');
  if (filterRaw && want.length) {
    want[0].value = `(${want[0].value}) AND (${filterRaw})`;
  }
  if (!want.length) { console.error('至少要给一个检索条件，如 --su 人工智能'); process.exitCode = 1; return; }

  const FROM = opt('from');
  const TO = opt('to');
  const TOP = parseInt(opt('top', '20'), 10);
  const AS_JSON = has('json');
  const HEADLESS = !has('headed');
  const DB = (opt('db', 'all') || 'all').toLowerCase();
  const FACET = opt('facet');

  const DB_LABEL = {
    all: '总库', journal: '学术期刊', thesis: '学位论文', book: '图书',
    conference: '会议', newspaper: '报纸', yearbook: '年鉴', patent: '专利', standard: '标准',
  };

  const ctx = await chromium.launchPersistentContext(PROFILE, {
    channel: 'msedge', headless: HEADLESS, locale: 'zh-CN', userAgent: UA,
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const page = ctx.pages()[0] || await ctx.newPage();
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  // ---- blockPuzzle 滑块自动破解（掩膜亮度差）----
  async function crackBlockPuzzle(pg) {
    for (let i = 0; i < 20; i++) {
      const ready = await pg.evaluate(() => {
        const imgs = [...document.querySelectorAll('img')].filter((x) => x.naturalWidth > 0);
        return imgs.some((x) => x.naturalWidth > 200) && imgs.some((x) => x.naturalWidth < 100 && x.naturalHeight > 100);
      });
      if (ready) break;
      await pg.waitForTimeout(500);
    }
    const calc = await pg.evaluate(async () => {
      const imgs = [...document.querySelectorAll('img')].filter((i) => i.naturalWidth);
      let bg = null, pc = null;
      for (const i of imgs) {
        if (i.naturalWidth > 200 && i.naturalHeight > 100 && !bg) bg = i;
        if (i.naturalWidth < 100 && i.naturalHeight > 100 && !pc) pc = i;
      }
      if (!bg || !pc) return null;
      const load = (src) => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });
      const bI = await load(bg.src), pI = await load(pc.src);
      const W = bI.naturalWidth, H = bI.naturalHeight, TW = pI.naturalWidth, TH = pI.naturalHeight;
      const mk = (img, w, h) => {
        const c = document.createElement('canvas'); c.width = w; c.height = h;
        const x = c.getContext('2d', { willReadFrequently: true });
        x.drawImage(img, 0, 0);
        return x.getImageData(0, 0, w, h).data;
      };
      const B = mk(bI, W, H), T = mk(pI, TW, TH);
      let minY = TH, maxY = -1, minX = TW, maxX = -1;
      for (let y = 0; y < TH; y++) for (let x = 0; x < TW; x++) {
        if (T[(y * TW + x) * 4 + 3] > 128) {
          if (y < minY) minY = y; if (y > maxY) maxY = y;
          if (x < minX) minX = x; if (x > maxX) maxX = x;
        }
      }
      const lum = (d, i) => 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      const res = [];
      for (let dx = 0; dx <= W - TW; dx++) {
        let inS = 0, inN = 0, outS = 0, outN = 0;
        for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
          const inside = T[(y * TW + x) * 4 + 3] > 128;
          const bi = (y * W + (x + dx)) * 4;
          if (inside) { inS += lum(B, bi); inN++; }
          else if (x > minX + 3 && x < maxX - 3) { outS += lum(B, bi); outN++; }
        }
        if (inN && outN) res.push({ dx, c: (outS / outN) - (inS / inN) });
      }
      if (!res.length) return null;
      res.sort((a, b) => b.c - a.c);
      const btn = document.querySelector('.verify-move-block');
      const r = btn ? btn.getBoundingClientRect() : null;
      return { dx: res[0].dx, btn: r ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null };
    });
    if (!calc || !calc.btn) return false;
    const { dx, btn } = calc;
    await pg.mouse.move(btn.x, btn.y);
    await pg.waitForTimeout(250);
    await pg.mouse.down();
    await pg.waitForTimeout(180);
    const steps = 42;
    for (let i = 1; i <= steps; i++) {
      const p = i / steps;
      const e = p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
      await pg.mouse.move(btn.x + dx * e + (Math.random() - 0.5) * 0.8, btn.y + (Math.random() - 0.5) * 0.6);
      await pg.waitForTimeout(p < 0.15 ? 26 + Math.random() * 18 : 8 + Math.random() * 11);
    }
    await pg.mouse.move(btn.x + dx, btn.y);
    await pg.waitForTimeout(280);
    await pg.mouse.up();
    await pg.waitForTimeout(4000);
    return !pg.url().includes('/verify');
  }

  const t0 = Date.now();
  try {
    await page.goto(PAGE, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(5000);

    if (page.url().includes('/verify')) {
      let ok = false;
      for (let i = 1; i <= 4 && !ok; i++) {
        ok = await crackBlockPuzzle(page);
        if (!ok) {
          console.error(`[slider] 第 ${i} 次未通过，刷新重试…`);
          await page.goto(PAGE, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
          await page.waitForTimeout(5000);
          if (!page.url().includes('/verify')) { ok = true; break; }
        }
      }
      if (ok) {
        console.error('[slider] 通过 ✅');
        if (page.url().includes('/verify')) {
          await page.goto(PAGE, { waitUntil: 'domcontentloaded', timeout: 60000 });
          await page.waitForTimeout(4000);
        }
      } else if (HEADLESS) {
        console.error('⚠️ 自动破解未通过，请用 --headed 人工过滑块');
        process.exitCode = 3; return;
      } else {
        console.error('⚠️ 请手动完成滑块（最多等 120 秒）…');
        for (let i = 0; i < 60; i++) {
          await page.waitForTimeout(2000);
          if (!page.url().includes('/verify')) break;
        }
        if (page.url().includes('/verify')) { console.error('仍未通过'); process.exitCode = 3; return; }
        await page.goto(PAGE, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForTimeout(4000);
      }
    }

    // ---- 填表 ----
    const filled = await page.evaluate((items) => {
      const boxes = [...document.querySelectorAll('.input-box')].filter((b) => b.querySelector('input[type=text]'));
      const curField = (b) => (b.querySelector('.sort-default span[value]')?.getAttribute('value') || '').trim();
      const setVal = (el, v) => {
        const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        s.call(el, v);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      };
      function setField(box, code) {
        if (curField(box) === code) return true;
        const def = box.querySelector('.sort-default');
        if (def) def.click();
        const list = box.querySelector('.sort-list');
        if (list) list.style.display = 'block';
        const li = box.querySelector('li[data-val="' + code + '"]');
        if (!li) return false;
        (li.querySelector('a') || li).click();
        return true;
      }
      const log = [];
      items.forEach((it, i) => {
        const b = boxes[i];
        if (!b) { log.push(it.field + ':no-box'); return; }
        setField(b, it.code);
        const inp = b.querySelector('input[type=text]');
        if (inp) setVal(inp, it.value);
        log.push(`${it.field}(${curField(b)})=${inp ? inp.value : '?'}`);
      });
      return log;
    }, want);
    console.error('[fill] ' + filled.join('  '));

    // ---- 时间 ----
    if (FROM || TO) {
      const r = await page.evaluate(([f, t]) => {
        const ds = [...document.querySelectorAll('input.publishdate')];
        if (ds.length < 2) return 'no-datebox';
        const setVal = (el, v) => {
          el.removeAttribute('readonly');
          const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          s.call(el, v);
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          el.dispatchEvent(new Event('blur', { bubbles: true }));
        };
        if (f) setVal(ds[0], /^\d{4}$/.test(f) ? f + '-01-01' : f);
        if (t) setVal(ds[1], /^\d{4}$/.test(t) ? t + '-12-31' : t);
        return ds[0].value + ' ~ ' + ds[1].value;
      }, [FROM, TO]);
      console.error('[time] ' + r);
    }

    // ---- 提交 ----
    const sub = await page.evaluate(() => {
      const b = document.querySelector('input.btn-search');
      if (b) { b.click(); return 'ok'; }
      return 'no-btn';
    });
    if (sub !== 'ok') { console.error('未找到 input.btn-search'); process.exitCode = 2; return; }
    // ⚠️ 结果页的分面是**分批渲染**的：先出「主题/来源类别/学科」，
    //    其余（作者/机构/年度/文献来源/基金）要再等一会儿才注入 #divGroup。
    //    实测 9s 时只拿到 3 个分组，12s 才拿全 11 个。
    await page.waitForTimeout(13000);
    if (page.url().includes('/verify')) { console.error('提交后又要验证，请用 --headed'); process.exitCode = 3; return; }

    // ---- 切库 ----
    // ⚠️⚠️ 2026-10-17 重要修正：原实现**点击顶部的库标签**来切库，实测**不生效**：
    //    点完「学术期刊」后，结果行里第 1 条仍是报纸（甘肃农民报），
    //    而且「各库」计数被搞乱（442,069 条结果却显示「总库 44 / 学术期刊 19」）。
    //    根因：顶部库标签是 Vue 组件，`.click()` 触发了重新渲染但**没有真正提交筛选**，
    //    抓到的只是中间态。
    //
    //    改为**客户端过滤**（不点 UI）：
    //      结果行文本里自带类型标识 ——「期刊」「报纸」「硕士」「博士」「中国会议」「辑刊」等，
    //      直接按这个过滤，既准确又不破坏计数。
    //    这样 --db 是**纯前端筛选**，语义清晰、不依赖站点交互。
    //    代价：只过滤当前页（默认 20 条）。要更多请加 --top N（会翻页）。
    //    ⚠️ 「某库总数」仍以结果页顶部的「各库」计数为准（那个是服务端算的）。
    const DB_TYPE_WORDS = {
      journal: ['期刊'],
      thesis: ['硕士', '博士'],
      book: ['图书', '专著'],
      conference: ['中国会议', '国际会议', '会议'],
      newspaper: ['报纸'],
      yearbook: ['年鉴'],
      patent: ['专利'],
      standard: ['标准'],
    };
    if (DB !== 'all') {
      console.error(`[db] 按类型过滤结果行：「${DB_LABEL[DB] || DB}」（客户端筛选，不点 UI）`);
    }

    // ---- 展开折叠的分面 ----
    // ⚠️ 关键：结果页左侧有 11 个分面分组（主题/来源类别/学科/研究层次/年度/文献类型/
    //    文献来源/作者/机构/基金/OA出版），但**只有前 3 个默认加载了条目**，
    //    其余 8 个 `dd li` 数量为 0 —— 必须**点击 dt 标题**才会 AJAX 拉取。
    //    实测：不点只有 3 个可用，点了才有作者/机构（「发文量最多的作者」这类题必需）。
    const expandTargets = FACET
      ? (FACET === 'all' ? null : [FACET])
      : null;   // null = 全部展开
    const expanded = await page.evaluate((targets) => {
      const alias = {
        author: '作者', institution: '机构', source: '文献来源', subject: '学科',
        year: '年度', category: '来源类别', topic: '主题', fund: '基金',
        level: '研究层次', type: '文献类型',
      };
      const want = targets ? targets.map((t) => alias[t] || t) : null;
      const root = document.querySelector('#divGroup');
      if (!root) return [];
      const out = [];
      for (const dl of root.querySelectorAll('dl')) {
        const t = (dl.querySelector('dt b')?.innerText || '').trim();
        if (!t) continue;
        if (want && !want.includes(t)) continue;
        if (dl.querySelectorAll('dd li').length > 0) continue;   // 已加载
        const dt = dl.querySelector('dt');
        if (dt) { dt.click(); out.push(t); }
      }
      return out;
    }, expandTargets);
    if (expanded.length) {
      console.error('[facet] 展开: ' + expanded.join(' / '));
      await page.waitForTimeout(5000);
    }

    // ---- 解析 ----
    const res = await page.evaluate(([top, dbKey]) => {
      const txt = document.body.innerText.replace(/\s+/g, ' ');
      const total = (txt.match(/共找到\s*([\d,]+)\s*条结果/) || [])[1] || null;
      // 各库计数：⚠️ 必须从「结果中检索」之后开始匹配。
      // 否则会把页面别处的「总库」「已选 1」之类误当成计数。
      //
      // ⚠️⚠️⚠️ 2026-10-17 关键发现：知网的库计数用**中文万单位**！
      //   实测文本：「总库 44.21万 中文 外文 学术期刊 19.62万 学位论文 4.24万
      //              图书 1011 会议 5641 报纸 17.46万 年鉴 专利 标准 1」
      //   原正则 `([\d,]+)` 只抓到小数点前的整数 → 44.21万 被读成 44、
      //   19.62万 被读成 19、17.46万 被读成 17 —— **所有超过 1 万的计数全错**，
      //   而且看起来"像真的"，极容易答错。
      //   → 正则必须支持小数 + 「万」，并换算成整数。
      const libs = {};
      const segStart = txt.indexOf('结果中检索');
      const seg = segStart >= 0 ? txt.slice(segStart, segStart + 400) : txt;
      const parseCn = (s) => {
        if (!s) return null;
        const m = s.match(/^([\d,]+(?:\.\d+)?)\s*(万|亿)?$/);
        if (!m) return null;
        let v = Number(m[1].replace(/,/g, ''));
        if (m[2] === '万') v *= 1e4;
        else if (m[2] === '亿') v *= 1e8;
        return Math.round(v);
      };
      for (const k of ['总库', '学术期刊', '学位论文', '图书', '会议', '报纸', '年鉴', '专利', '标准', '法律法规']) {
        // 允许「44.21万」这种形式
        const m = seg.match(new RegExp(k + '\\s*([\\d,]+(?:\\.\\d+)?\\s*(?:万|亿)?)'));
        if (m) {
          const v = parseCn(m[1].trim());
          if (v != null) libs[k] = v;
        }
      }
      // 兜底：若某库没读到但总库读到，至少保证总库对
      if (libs['总库'] == null && total) libs['总库'] = Number(total.replace(/,/g, ''));
      const facets = {};
      const root = document.querySelector('#divGroup');
      if (root) {
        for (const dl of root.querySelectorAll('dl')) {
          // 分组名：优先 dt>b，退化到 dt 的纯文本（去掉箭头/可视化图标）
          let title = (dl.querySelector('dt b')?.innerText || '').trim();
          if (!title) {
            const dt = dl.querySelector('dt');
            title = (dt?.innerText || '').replace(/[+\-−\s]/g, '').trim();
          }
          if (!title || title.length > 8) continue;
          const map = new Map();
          for (const dd of dl.querySelectorAll('dd')) {
            const sub = dd.getAttribute('tit') || '';
            for (const li of dd.querySelectorAll('li')) {
              const name = (li.querySelector('a')?.innerText || '').trim();
              const n = (li.querySelector('span')?.innerText || '').replace(/[()\s]/g, '');
              if (!name) continue;
              const key = name + '|' + sub;
              const val = { name, n: Number(n) || 0, sub };
              if (!map.has(key) || map.get(key).n < val.n) map.set(key, val);
            }
          }
          const arr = [...map.values()].sort((a, b) => b.n - a.n);
          if (arr.length) facets[title] = arr.slice(0, 20);
        }
      }
      // ---- 结果行：结构化解析 ----
      // ⚠️ 2026-10-17 重写：原来只把整行文本塞进数组，字段不可用、也无法按类型过滤。
      //    现在按列拆：序号 / 题名 / 作者 / 来源 / 发表时间 / 类型 / 被引 / 下载 / 详情链接。
      //    详情页链接在题名的 <a> 上（class 含 fz14），是 kcms2/article/abstract?v=xxx 形式。
      const DB_WORDS = {
        journal: ['期刊'], thesis: ['硕士', '博士'], book: ['图书', '专著'],
        conference: ['中国会议', '国际会议', '会议'], newspaper: ['报纸'],
        yearbook: ['年鉴'], patent: ['专利'], standard: ['标准'],
      };
      const wantTypes = DB_WORDS[dbKey] || null;
      const rows = [];
      const rawRows = [];
      for (const tr of document.querySelectorAll('tbody tr')) {
        const s = (tr.innerText || '').replace(/\s+/g, ' ').trim();
        if (!/\d{4}-\d{2}-\d{2}/.test(s)) continue;
        const tds = [...tr.querySelectorAll('td')].map((td) => (td.innerText || '').replace(/\s+/g, ' ').trim());
        const linkEl = tr.querySelector('a.fz14, td.name a, a[href*="/kcms2/article/abstract"], a[href*="dbcode"]');
        const row = {
          no: tds[0] || '',
          title: (linkEl?.innerText || tds[1] || '').replace(/\s+/g, ' ').trim(),
          authors: tds[2] || '',
          source: tds[3] || '',
          date: tds[4] || '',
          type: tds[5] || '',
          cited: tds[6] || '',
          downloads: tds[7] || '',
          detailUrl: linkEl ? (linkEl.getAttribute('href') || '') : '',
          raw: s,
        };
        rawRows.push(row);
        if (wantTypes) {
          // 类型匹配：优先用 type 列，退化到整行文本
          const hay = (row.type + ' ' + row.raw);
          if (!wantTypes.some((w) => hay.includes(w))) continue;
        }
        rows.push(row);
        if (top > 0 && rows.length >= top) break;
      }
      const scope = (txt.match(/检索范围：([^]{0,200}?)主题定制/) || [])[1] || '';
      return { total, libs, facets, rows, rawRows, scope: scope.trim(), filtered: !!wantTypes };
    }, [TOP, DB]);

    if (AS_JSON) {
      console.log(JSON.stringify({ conditions: want, from: FROM, to: TO, db: DB, ...res }, null, 2));
    } else {
      console.log('=== CNKI 高级检索 ===');
      console.log('  条件: ' + want.map((w) => `${w.field}=${w.value}`).join('  AND  ')
        + (FROM || TO ? `   时间: ${FROM || ''}-${TO || ''}` : ''));
      if (res.scope) console.log('  实际检索范围: ' + res.scope);
      console.log(res.total != null ? `共找到 ${res.total} 条结果` : '(未解析到条数)');
      if (Object.keys(res.libs).length) {
        console.log('  各库: ' + Object.entries(res.libs).map(([k, v]) => `${k} ${v}`).join(' | '));
      }
      // ⚠️ 切库后「共找到 N 条」仍是**总库**的数字（知网只切换 tab、不重算总数）。
      //    所以切库时额外提示当前库的真实条数。
      if (DB !== 'all') {
        const lb = DB_LABEL[DB] || DB;
        const n = res.libs[lb];
        console.log(`  ★ 当前库「${lb}」: ${n != null ? n + ' 条' : '(未取到)'}  ← 答题用这个，不是上面的总库数`);
      }

      const facetKeys = Object.keys(res.facets);
      if (FACET && facetKeys.length) {
        const alias = {
          author: '作者', institution: '机构', source: '文献来源', subject: '学科',
          year: '年度', category: '来源类别', topic: '主题', fund: '基金',
        };
        const wantKeys = FACET === 'all' ? facetKeys : facetKeys.filter((k) =>
          k === FACET || k === alias[FACET] || k.includes(FACET));
        if (wantKeys.length) {
          console.log('\n--- 分面 ---');
          for (const k of wantKeys) {
            console.log(`  【${k}】`);
            for (const it of res.facets[k].slice(0, 10)) {
              console.log(`     ${it.name}  (${it.n})${it.sub && it.sub !== k ? '  [' + it.sub + ']' : ''}`);
            }
          }
        } else {
          console.log(`\n(无分面「${FACET}」) 可用: ${facetKeys.join(' / ')}`);
        }
      }

      if (res.rows.length) {
        console.log(`\n--- 前 ${res.rows.length} 条 ---`);
        for (const r of res.rows) {
          console.log(`  ${r.no || '·'}. ${r.title}`);
          const meta = [r.authors, r.source, r.date, r.type,
            r.cited ? `被引${r.cited}` : '', r.downloads ? `下载${r.downloads}` : ''].filter(Boolean);
          if (meta.length) console.log(`      ${meta.join(' | ')}`);
        }
        if (res.filtered && res.rows.length === 0) {
          console.log(`  (当前页没有「${DB_LABEL[DB] || DB}」类型的结果，加大 --top 或换 --db all)`);
        }
      }
      if (res.libs['__note']) console.log('  ⚠️ ' + res.libs['__note']);
    }
    console.log(`ELAPSED = ${((Date.now() - t0) / 1000).toFixed(1)}s`);

    // ── 详情页：查单篇的 DOI / 作者单位 / 关键词 / 基金 / 引用格式 ──
    // 用法: node cnki.mjs --ti "篇名" --detail [--idx 2]
    // ⚠️ 详情页 URL 在结果行题名的 <a> 上（kcms2/article/abstract?v=xxx，带临时 token），
    //    **无法用固定 URL 构造**，必须先检索再点进去。
    if (has('detail')) {
      const idx = Math.max(1, parseInt(opt('idx', '1'), 10)) - 1;
      const pool = res.rows.length ? res.rows : res.rawRows;
      const target = pool[Math.min(idx, pool.length - 1)];
      if (!target || !target.detailUrl) {
        console.log('\n⚠️ 未取到详情页链接（结果为空，或该行没有题名链接）');
      } else {
        console.log(`\n=== 详情页 [${idx + 1}/${pool.length}] ===`);
        await page.goto(target.detailUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForTimeout(8000);
        if (page.url().includes('/verify')) {
          console.log('⚠️ 详情页触发验证，请用 --headed');
        } else {
          const d = await page.evaluate(() => {
            const lines = document.body.innerText.split('\n').map((s) => s.trim()).filter(Boolean);
            const kv = {};
            // 「字段：值」或「字段：\t值」形式（知网详情页字段名后跟制表符）
            for (let i = 0; i < lines.length; i++) {
              const m = lines[i].match(/^([^：:]{2,12})\s*[：:]\s*(.*)$/);
              if (m) {
                const k = m[1].trim();
                let v = m[2].trim();
                if (!v && lines[i + 1] && !/^[^：:]{2,12}\s*[：:]/.test(lines[i + 1])) v = lines[i + 1];
                if (v && !kv[k] && v.length < 300) kv[k] = v;
              }
            }
            // DOI 常以 `DOI: 10.xxxx` 出现
            const doiLine = lines.find((l) => /^DOI\s*[:：]\s*10\./.test(l));
            if (doiLine) kv['DOI'] = doiLine.replace(/^DOI\s*[:：]\s*/, '').trim();

            // ⚠️⚠️ 年卷期/刊名/页码：知网详情页有**单独一行**，格式为
            //      `中国社会科学 . 2022 (06) : 86-105+206 查看该刊数据库收录来源`
            //    即 `刊名 . 年 (期) : 页码`。这是**唯一可靠的刊名+年卷期+页码来源**，
            //    不能靠「年,卷(期)：」这种标签（详情页没有）。
            //    ⚠️ 网络首发的文章可能没有这一段（还没分配卷期），此时只能靠结果行。
            const citeLine = lines.find((l) => /^.+?\s*[.．]\s*\d{4}\s*\(\s*\d{1,3}\s*\)\s*[:：]/.test(l));
            if (citeLine) {
              const m = citeLine.match(/^(.+?)\s*[.．]\s*(\d{4})\s*\(\s*(\d{1,3})\s*\)\s*[:：]\s*([\d\-–+]+)/);
              if (m) {
                kv['期刊名称'] = m[1].replace(/^推广\s*X\s*/, '').trim();
                kv['年'] = m[2];
                kv['期'] = m[3];
                kv['页码'] = m[4];
              }
            }
            // 作者单位：作者名之后、摘要之前的**单独一行**机构名（如「复旦大学哲学学院」）
            // ⚠️ 实测坑：详情页顶部有 CNKI AI 生成的**推荐问句**（「晚明气论与阳明学之间
            //    的关系如何？」），里面也含「学」字，会被误判成单位。
            //    → 必须排除问句特征：？ ? 如何 什么 哪些 是否 怎样 为何
            if (!kv['作者单位']) {
              const iAbs = lines.findIndex((l) => /^摘要\s*[:：]/.test(l));
              const stop = iAbs > 0 ? iAbs : 25;
              for (let i = 0; i < stop; i++) {
                const l = lines[i];
                if (l.length < 5 || l.length > 80) continue;
                if (/[？?]/.test(l)) continue;
                if (/(如何|什么|哪些|是否|怎样|为何|介绍|推荐|服务)/.test(l)) continue;
                if (/[:：]/.test(l)) continue;
                if (/^(推广|读者|手机|扫码)/.test(l)) continue;
                if (/(大学|学院|研究院|研究所|中心|医院|公司|集团|实验室|系)[,，]?\s*[\u4e00-\u9fa5]{0,10}$/.test(l)) {
                  kv['作者单位'] = l;
                  break;
                }
              }
            }

            // ⚠️⚠️ 题名：**不能用裸 `h1`** —— 知网详情页里有登录弹窗的
            //    `<h1>自动登录</h1>`，`querySelector('h1')` 会先命中它（实测踩过）。
            //    正确的选择器是 `.wx-tit h1` 或 `.brief h1`（文献标题区）。
            let title = '';
            for (const sel of ['.wx-tit h1', '.brief h1', '.wx-tit .title', '#title']) {
              const el = document.querySelector(sel);
              const t = (el?.innerText || '').replace(/\s+/g, ' ').trim();
              if (t && t.length > 2 && !/自动登录|找回密码|使用帮助/.test(t)) { title = t; break; }
            }
            // 作者：`.wx-tit h3.author` / `#authorpart`，带**上标数字**（如「李先平1韦朝东2」）
            let authorsRaw = '';
            for (const sel of ['.wx-tit h3.author', '.wx-tit h3', '#authorpart', '.author']) {
              const el = document.querySelector(sel);
              const t = (el?.innerText || '').replace(/\s+/g, ' ').trim();
              if (t && t.length > 1 && t.length < 300) { authorsRaw = t; break; }
            }
            return { title, authorsRaw, kv, head: lines.slice(0, 60).join('\n') };
          });
          // 作者上标数字清理：`李先平1韦朝东2卢柳盈1刘芳1,3` → `李先平;韦朝东;卢柳盈;刘芳`
          const cleanAuthors = (s) => {
            if (!s) return [];
            return s.replace(/\d+/g, ' ')
              .split(/[\s,;，；、]+/)
              .map((x) => x.trim())
              .filter((x) => x && x.length >= 2 && /[\u4e00-\u9fa5A-Za-z·]/.test(x));
          };
          const A = cleanAuthors(d.authorsRaw || target.authors);
          const titleTxt = d.title || target.title;
          if (titleTxt) console.log(`  题名: ${titleTxt}`);
          if (A.length) console.log(`  作者: ${A.join('; ')}`);
          const PRI = ['DOI', '关键词', '作者单位', '机构', '基金资助', '基金', '资助', '分类号',
            '专辑', '专题', '期刊名称', '文献来源', '年,卷(期)', '卷期', '期号', '页码', '页数',
            '发表时间', '出版时间', '报纸日期', '版号', '在线公开时间', '网络出版时间',
            '（排版定稿）网络首发时间', '被引频次', '下载次数', 'ISSN', '语种', '文献类型'];
          const seen = new Set();
          for (const k of PRI) {
            if (d.kv[k]) { console.log(`  ${k}: ${d.kv[k]}`); seen.add(k); }
          }
          const rest = Object.keys(d.kv).filter((k) => !seen.has(k)
            && !/热线|咨询|订卡|邮件|\[/.test(k)).slice(0, 15);
          if (rest.length) {
            console.log('  --- 其他字段 ---');
            for (const k of rest) console.log(`  ${k}: ${d.kv[k]}`);
          }

          // ---- 引用格式（自己拼，知网的"导出"要登录）----
          const journal = (d.kv['期刊名称'] || d.kv['文献来源'] || target.source || '').replace(/[《》]/g, '').trim();
          // 年/卷/期/页码：优先用「刊名 . 年 (期) : 页码」那一行的解析结果
          const year = d.kv['年'] || (target.date || '').slice(0, 4) || (d.kv['报纸日期'] || '').slice(0, 4);
          const issue = d.kv['期'] || '';
          const pages = d.kv['页码'] || '';
          const isNews = !!(d.kv['报纸日期'] || /报纸/.test(target.type || ''));
          const doi = d.kv['DOI'] || '';
          const fullDate = (target.date || d.kv['报纸日期'] || '').slice(0, 10);
          if (A.length && titleTxt) {
            console.log('\n  --- 引用格式（自动生成）---');
            const gbAuthors = A.length > 3 ? `${A.slice(0, 3).join(',')},等` : A.join(',');
            if (isNews) {
              // GB/T 7714 报纸格式：作者.题名[N].报纸名,日期(版次).
              const ed = d.kv['版号'] || '';
              console.log(`  GB/T 7714 : ${gbAuthors}.${titleTxt}[N].${journal},${fullDate}${ed ? '(' + ed + ')' : ''}.`);
            } else {
              // GB/T 7714-2015 期刊：作者.题名[J].刊名,年(期):页码.
              // ⚠️ 知网详情页通常**不给卷号**，只有年(期)，所以卷位留空 —— 这是正确的，
              //    不要瞎填（GB/T 7714 允许「年(期)」而不写卷）。
              console.log(`  GB/T 7714 : ${gbAuthors}.${titleTxt}[J].${journal},${year}(${issue}):${pages}.`);
              const mlaAuthor = A.length > 2 ? `${A[0]}, et al` : A.join(', ');
              console.log(`  MLA       : ${mlaAuthor}. "${titleTxt}." ${journal} ${issue} (${year}): ${pages}.`);
              const apaAuthors = A.length > 2 ? `${A.slice(0, 2).join(', ')}, & ${A[2]}` : A.join(', ');
              console.log(`  APA       : ${apaAuthors}. (${year}). ${titleTxt}. ${journal}, ${issue}, ${pages}.${doi ? ' https://doi.org/' + doi : ''}`);
              // ⚠️ 网络首发（或刚录用）的文章还没分配卷期页码，此时引用格式必然有空白。
              //    必须明确提示，否则用户会以为是脚本没抓到。
              if (!issue || !pages) {
                const miss = [!issue && '期号', !pages && '页码'].filter(Boolean).join('、');
                console.log(`  ⚠️ ${miss}缺失 —— 该文献是**网络首发/尚未编排**（知网详情页也没有），`);
                console.log('     此时引用格式应写成「[J].刊名,年.（网络首发）」或在正式出版后补全。');
              }
            }
          } else {
            console.log('\n  (作者/题名 不全，跳过引用格式)');
          }
        }
      }
    }
  } finally {
    await ctx.close().catch(() => {});
  }
}

main().catch((e) => {
  console.error('ERROR: ' + String(e && e.message || e).slice(0, 300));
  process.exitCode = process.exitCode || 1;
});
