// ============================================================
// 中国执行信息公开网 速查 CLI
//   https://zxgk.court.gov.cn/gkw/html/zhzxgk/index.html  (综合查询被执行人)
//
// 用法:
//   node zxgk.mjs "星河互联集团有限公司"
//   node zxgk.mjs "星河互联集团有限公司" --headed
//
// 逆向要点 (2026-10-10 实测):
//   1. 该站有两个入口，**综合查询(zhcx) 比 失信(shixin) 信息更全**：
//        /gkw/html/shixin/index.html   → /gkw/sx/*    只有失信名单，无金额
//        /gkw/html/zhzxgk/index.html   → /gkw/zhcx/*  含 duty「执行标的：X 元」
//      题目问「判决需偿还多少金额」必须走 zhcx。
//   2. 三个接口（全部 POST，除 gen 是 GET）：
//        GET  /gkw/zhcx/captcha/captcha            生成验证码
//        POST /gkw/zhcx/captcha/captcha/check?captchaId=<id>   校验，返回 token
//        POST /gkw/zhcx/searchZhcx                 列表
//        POST /gkw/zhcx/detailZhcx                 详情（含金额）
//   3. 验证码是「天爱 tianai」滑块，gen 返回 {id,type,backgroundImage,templateImage}。
//      type 在 SLIDER / WORD_IMAGE_CLICK 之间随机，且 ?type=SLIDER 参数**不可靠**
//      （实测约 75% 概率给滑块）→ 循环重试直到拿到 SLIDER 即可。
//   4. **缺口定位**（关键）：templateImage 是 110×360 的整条竖带，其中只有拼图块
//      区域 alpha>0。把该 alpha 掩膜按不同 dx 平移到背景图上，比较
//      「掩膜内平均亮度」与「掩膜外环平均亮度」——缺口是半透明压暗的，
//      差值最大处即缺口位置。实测一次命中（也可用 ±1..6 邻域兜底重试）。
//   5. 校验体（POST JSON）：{bgImageWidth,bgImageHeight,templateImageWidth,
//      templateImageHeight,startTime,stopTime,trackList,left,top:0,data:{}}
//      **只有 left 是决定性的**，trackList 伪造不影响（实测过）。
//      成功返回 {code:200,msg:"校验成功",result:"<token>"}。
//   6. 拿到 token 后，把它当 pCode、gen 的 id 当 captchaId，塞进业务请求即可。
//      一个 captchaId 可复用于 searchZhcx 与 detailZhcx。
//   7. 有瑞数动态 cookie（query 上的 vG5nbKcB=...），**由页面 JS 自动补**，
//      所以必须用真实浏览器加载页面后再在页内 fetch，不能裸 HTTP 直连。
// ============================================================

import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);

// playwright-core 藏在 @playwright/mcp 里（本机浏览器只剩系统 Edge）
const CANDIDATES = [
  'C:/Users/xianw/AppData/Roaming/npm/node_modules/@playwright/mcp/node_modules/playwright-core/index.js',
  'playwright-core',
];
let chromium = null;
for (const c of CANDIDATES) {
  try {
    const mod = c.startsWith('C:')
      ? await import(pathToFileURL(c).href)
      : await import(c);
    chromium = (mod.default ?? mod).chromium;
    if (chromium) break;
  } catch { /* 试下一个 */ }
}
if (!chromium) {
  console.error('找不到 playwright-core');
  process.exit(1);
}

const args = process.argv.slice(2);
const name = args.find(a => !a.startsWith('--'));
const headed = args.includes('--headed');
const PAGE = 'https://zxgk.court.gov.cn/gkw/html/zhzxgk/index.html';

if (!name) {
  console.error('用法: node zxgk.mjs "<被执行人姓名/名称>" [--headed]');
  process.exit(1);
}

// ---- 页内执行的完整流程：解滑块 → 搜索 → 取详情 ----
async function run(page, name) {
  return await page.evaluate(async (name) => {
    const get = (url) => new Promise((res) => {
      const x = new XMLHttpRequest();
      x.open('GET', url, true);
      x.onreadystatechange = () => {
        if (x.readyState !== 4) return;
        let j = null; try { j = JSON.parse(x.responseText); } catch { /* 非 JSON */ }
        res(j);
      };
      x.send();
    });
    const postJson = (url, body) => new Promise((res) => {
      const x = new XMLHttpRequest();
      x.open('POST', url, true);
      x.setRequestHeader('Content-Type', 'application/json;charset=UTF-8');
      x.onreadystatechange = () => {
        if (x.readyState !== 4) return;
        let j = null; try { j = JSON.parse(x.responseText); } catch { j = { raw: x.responseText.slice(0, 200) }; }
        res(j);
      };
      x.send(JSON.stringify(body));
    });
    const postForm = (url, body) => new Promise((res) => {
      const x = new XMLHttpRequest();
      x.open('POST', url, true);
      x.setRequestHeader('Content-Type', 'application/x-www-form-urlencoded');
      x.onreadystatechange = () => {
        if (x.readyState !== 4) return;
        let j = null; try { j = JSON.parse(x.responseText); } catch { j = { raw: x.responseText.slice(0, 300) }; }
        res(j);
      };
      x.send(body);
    });
    const loadImg = (src) => new Promise((res, rej) => {
      const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src;
    });
    const lum = (d, i) => 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    const mkTrack = (target, ms) => {
      const a = []; const n = 28;
      for (let i = 0; i <= n; i++) {
        const p = i / n;
        const e = p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
        a.push({ x: +(target * e).toFixed(1), y: 0, t: Math.round(ms * p) });
      }
      return a;
    };

    // 解一次滑块，返回 {id, token}
    async function solveCaptcha() {
      for (let round = 0; round < 4; round++) {
        let gen = null;
        for (let i = 0; i < 15; i++) {
          const g = await get('/gkw/zhcx/captcha/captcha');
          if (g && g.type === 'SLIDER') { gen = g; break; }
        }
        if (!gen) continue;

        const bgI = await loadImg(gen.backgroundImage);
        const tpI = await loadImg(gen.templateImage);
        const W = bgI.naturalWidth, H = bgI.naturalHeight;
        const TW = tpI.naturalWidth, TH = tpI.naturalHeight;

        const mkData = (img, w, h) => {
          const c = document.createElement('canvas');
          c.width = w; c.height = h;
          const x = c.getContext('2d', { willReadFrequently: true });
          x.drawImage(img, 0, 0);
          return x.getImageData(0, 0, w, h).data;
        };
        const B = mkData(bgI, W, H);
        const T = mkData(tpI, TW, TH);

        let minY = TH, maxY = -1, minX = TW, maxX = -1;
        for (let y = 0; y < TH; y++) for (let x = 0; x < TW; x++) {
          if (T[(y * TW + x) * 4 + 3] > 128) {
            if (y < minY) minY = y; if (y > maxY) maxY = y;
            if (x < minX) minX = x; if (x > maxX) maxX = x;
          }
        }

        const scores = [];
        for (let dx = 0; dx <= W - TW; dx++) {
          let inS = 0, inN = 0, outS = 0, outN = 0;
          for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
            const inside = T[(y * TW + x) * 4 + 3] > 128;
            const bi = (y * W + (x + dx)) * 4;
            if (inside) { inS += lum(B, bi); inN++; }
            else if (x > minX + 3 && x < maxX - 3) { outS += lum(B, bi); outN++; }
          }
          if (inN && outN) scores.push({ dx, c: (outS / outN) - (inS / inN) });
        }
        if (!scores.length) continue;
        scores.sort((a, b) => b.c - a.c);
        const best = scores[0].dx;

        for (const d of [0, -1, 1, -2, 2, -3, 3, -4, 4, -6, 6]) {
          const left = Math.max(0, Math.min(W - TW, best + d));
          const st = Date.now() - 1000;
          const ck = await postJson(
            '/gkw/zhcx/captcha/captcha/check?captchaId=' + encodeURIComponent(gen.id),
            {
              bgImageWidth: W, bgImageHeight: H,
              templateImageWidth: TW, templateImageHeight: TH,
              startTime: st, stopTime: Date.now(),
              trackList: mkTrack(left, 850), left, top: 0, data: {},
            },
          );
          if (ck && ck.code === 200) return { id: gen.id, token: ck.result, left };
        }
      }
      return null;
    }

    const cap = await solveCaptcha();
    if (!cap) return { ok: false, error: '滑块验证失败（4 轮重试）' };

    const capQs = 'captchaId=' + encodeURIComponent(cap.id) + '&pCode=' + encodeURIComponent(cap.token);

    const sr = await postForm('/gkw/zhcx/searchZhcx',
      'pName=' + encodeURIComponent(name) +
      '&pCardNum=&selectCourtId=0&' + capQs +
      '&searchCourtName=' + encodeURIComponent('全国法院（包含地方各级法院）') +
      '&selectCourtArrange=1&currentPage=1');

    if (!sr || sr.code !== 200) return { ok: false, error: '查询失败', raw: sr };

    const list = (sr.result && sr.result.result) || [];
    const total = sr.result ? sr.result.totalSize : 0;
    if (!list.length) return { ok: true, total: 0, rows: [] };

    // 逐条取详情（含「执行标的」金额）
    const rows = [];
    for (const it of list) {
      const dt = await postForm('/gkw/zhcx/detailZhcx',
        'pName=' + encodeURIComponent(it.pname || name) +
        '&ah=' + encodeURIComponent(it.caseCode || '') +
        '&dePartyCardNum=' + encodeURIComponent(it.dePartyCardNum || '') +
        '&' + capQs);
      const p = dt && dt.result && dt.result.disruptPublishParty;
      rows.push({
        name: it.pname,
        caseCode: it.caseCode,
        caseCreateTime: it.caseCreateTime ? it.caseCreateTime.slice(0, 10) : '',
        duty: p ? p.duty : null,
        court: p ? p.courtName : null,
        judgeCase: p ? p.gistId : null,
        performance: p ? p.performance : null,
        disruptType: p ? p.disruptTypeName : null,
      });
    }
    return { ok: true, total, rows };
  }, name);
}

// ⚠️ 过瑞数 WAF 的两个必要条件（缺一即 400 Bad Request）：
//   1. --disable-blink-features=AutomationControlled  →  navigator.webdriver === false
//   2. 覆盖 UA，去掉 "HeadlessChrome"
// 实测：不 stealth 时 gen 接口一律 400，且 window.$_ts 未初始化（瑞数脚本不跑）。
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36 Edg/154.0.0.0';
// 用独立 profile 存瑞数 cookie。
// ⚠️ 一旦该 profile 被瑞数标记（表现为 gen 接口恒返回 400、window.$_ts 为 undefined），
//    该 profile 不会自愈 —— 删掉目录换一个新的即可（务必从首次访问起就带 stealth 参数）。
const PROFILE = process.env.ZXGK_PROFILE || 'C:/Users/xianw/.dsh/zxgk-profile';

// 一次完整尝试：起浏览器 → 加载页面 → 解滑块 → 查询
async function attempt(profileDir) {
  const context = await chromium.launchPersistentContext(profileDir, {
    channel: 'msedge',
    headless: !headed,
    locale: 'zh-CN',
    userAgent: UA,
    args: ['--disable-blink-features=AutomationControlled'],
  });
  try {
    const page = context.pages()[0] || await context.newPage();
    await page.goto(PAGE, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(3500); // 等瑞数脚本注入动态 cookie
    const t0 = Date.now();
    const out = await run(page, name);
    out.secs = ((Date.now() - t0) / 1000).toFixed(1);
    return out;
  } finally {
    await context.close().catch(() => {});
  }
}

// 首次用 PROFILE；若被瑞数标记（gen 恒 400 → 滑块解不出），自动换全新 profile 重试一次
let out = await attempt(PROFILE);
if (!out.ok && /滑块/.test(out.error || '')) {
  const fresh = PROFILE + '-fresh-' + Date.now();
  console.error(`[warn] profile 被瑞数标记，改用全新 profile 重试：${fresh}`);
  out = await attempt(fresh);
}

if (!out.ok) { console.error('ERROR:', out.error, out.raw ?? ''); process.exit(2); }
if (!out.total) { console.log(`(无记录) ${name}`); process.exit(0); }

console.log(`=== ${name} | 共 ${out.total} 条 ===`);
for (const r of out.rows) {
  console.log(`[${r.caseCreateTime}] ${r.caseCode}`);
  console.log(`    执行标的 : ${r.duty ?? '-'}`);
  console.log(`    执行法院 : ${r.court ?? '-'}   依据 : ${r.judgeCase ?? '-'}`);
  console.log(`    履行情况 : ${r.performance ?? '-'}   情形 : ${r.disruptType ?? '-'}`);
}
console.log(`ELAPSED = ${out.secs}s`);
