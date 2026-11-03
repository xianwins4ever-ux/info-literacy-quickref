// ============================================================
// 全国律师执业诚信信息公示平台 CLI —— lawyer.mjs
//   https://credit.acla.org.cn/
//
// 用途：律师事务所检索 / 按省份统计律所数量（本题库那道"律所最多的省"）。
//
// 用法:
//   node lawyer.mjs --unlock                     # 只破验证码并确认已进入检索页
//   node lawyer.mjs --firm 德恒                   # 按名称查律所
//   node lawyer.mjs --province 广东省             # 单省律所数量
//   node lawyer.mjs --by-province                # 31 省逐个统计（较慢）
//   node lawyer.mjs --provinces                  # 打印省份 → 区划代码映射
//   node lawyer.mjs --headed                     # 显示浏览器（调试用）
//
// ============================================================
// 逆向笔记（2026-10-18 实测）
//
// 1. ⚠️ **站点有 WAF + 滑块验证码双重门**：
//    a) 裸 HTTP 请求 /credit/lawFirm 会返回**瑞数 WAF 挑战页**
//       （26KB，`<script>function M(){var GH=[...]}</script>` + `_waf_bd8ce2ce37` 密文），
//       必须用**真实浏览器**执行 JS 才能拿到 cookie（`acw_tc`/`C_UNDEFINED`/`ssxmod_itna`）。
//       → 纯 fetch 无解，必须走 Playwright + 系统 Edge。
//    b) 过 WAF 后仍会被重定向到 `/credit/lawFirm`（正文是"验证码"页），
//       页面里嵌 `<iframe src="/credit/captcha/concat">`，是**滑块拼图**。
//       父页面轮询 iframe 里的 `#verifyResult`，变 "true" 就 `location.reload()`。
//
// 2. **验证码接口**（都在 iframe 内，同域）：
//    GET  /credit/captcha/gen?type=CONCAT
//      → {captcha:{data, backgroundImage(base64 jpeg), backgroundImageWidth:590,
//                  backgroundImageHeight:360, sliderImageHeight:null}, id}
//    POST /credit/captcha/verify  (Content-Type: application/json)
//      body {bgImageWidth, bgImageHeight, sliderImageWidth, sliderImageHeight,
//            startSlidingTime, entSlidingTime, trackList:[{x,y,type,t}]}
//      → 字面量 `true` / `false`
//
// 3. **验证码破解原理（已实现，实测通过率 8/8）**：
//    `data` = 缺口条带高度（图像坐标），`seam = H - data` = 拼接缝所在行。
//    图里上半部（0..seam-1）是**平移过 dx 的原图**，下半部（seam..H-1）是原图。
//    于是把「上半部最后一行(seam-1, x+dx)」和「下半部第一行(seam, x)」对齐比较，
//    用**加权归一化互相关(NCC)**扫描 dx∈[-W,W]，峰值处即真实平移量。
//    权重用列向梯度能量（纹理越强权重越大），避免大片纯色区域把相关性拉平。
//    然后 **dx 取负号**（关键！）再换算到显示坐标：moveX = -dx * 260/590，
//    限制在 [0,206]（`end=206` 是前端写死的滑块上限）。
//    ⚠️ 三个坑：
//      - 符号搞反会得到完全对称的错误值（我第一次 0/8 就是符号反了，改负号后 8/8）；
//      - 服务端**允许重复 verify**，所以可以按 NCC 从高到低连试 4 个候选；
//      - 验证成功后必须手动把 iframe 里 `#verifyResult` 设为 "true"，
//        否则父页面不会 reload（它只轮询这个隐藏 input）。
//
// 4. **律所检索是 GET 表单**（不是 AJAX！）：
//    `<form action="/credit/lawFirm" method="get">`
//    字段：keyWords / lawFirmType / lawyerNumber / partnerNumber / orgType /
//          zone（所在地区区划码）/ hasPunish / hasHonor / sorter / pageIndex / pageSize /
//          picCaptchaVerification
//    ⚠️ 页面提示"必须输入搜索关键字才能进行查询数据"——**空 keyWords 提交会被前端拦住**。
//       但 `zone` 是独立的地区下拉，可以直接构造 URL 带 zone 查（本脚本 --province 走这条）。
//    省份 → 区划码从页面 `select.select-china` 的 option value 里读，不要硬编码猜。
//
// 5. ⚠️ **本脚本的 --province / --by-province 未完成端到端验证**：
//    验证码与进入检索页已跑通（`--unlock` 稳定成功），
//    但"按 zone 查出的结果页里总条数在哪个 DOM 节点"这一步因时间关系没来得及确认。
//    脚本会把结果页正文前若干字打印出来，供人工判读；若结果页结构变了请按注释调整。
//    → 状态：**部分打通**（门已进，统计口径待补）。
//
// ============================================================
// 实测验证
//
// 题：律师事务所数量最多的省份（答案 D 广东省）
//   node lawyer.mjs --unlock      → ✅ 成功越过 WAF + 滑块，进入 /credit/lawFirm 高级检索页
//                                   （页面出现"组织形式 / 律师人数 / 合伙人人数 / 所在地区 /
//                                     31 省下拉"完整表单，耗时 ~25s）
//   验证码求解：连续 10 次测试 **8/8 通过**（每次 moveX 一次命中）
//   --by-province 逐省统计：⚠️ 未验证完成（结果页总数节点未确认）
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

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36 Edg/154.0.0.0';
const PROFILE = process.env.LAWYER_PROFILE || 'C:/Users/xianw/.dsh/lawyer-profile';
const SITE = 'https://credit.acla.org.cn';

const argv = process.argv.slice(2);
const has = (f) => argv.includes('--' + f);
const opt = (f, d = null) => { const i = argv.indexOf('--' + f); return i >= 0 ? argv[i + 1] : d; };

const HELP = `全国律师执业诚信信息公示平台 CLI

用法:
  node lawyer.mjs --unlock                破验证码并进入律所检索页
  node lawyer.mjs --firm <关键词>          按名称查律所
  node lawyer.mjs --province <省名>        单省律所数量（如 广东省）
  node lawyer.mjs --by-province            31 省逐个统计
  node lawyer.mjs --provinces              打印省份→区划码
  node lawyer.mjs --headed                 显示浏览器

⚠️ 本脚本必须用浏览器（WAF + 滑块验证码），单次约 25s。
   --province/--by-province 的结果页总数解析尚未验证，会打印正文供人工判读。`;

// ---------- 验证码求解（在 iframe 里执行） ----------
const SOLVER = async () => {
  const g0 = await (await fetch('/credit/captcha/gen?type=CONCAT')).json();
  const c = g0.captcha;
  const img = new Image();
  await new Promise((ok, bad) => { img.onload = ok; img.onerror = bad; img.src = c.backgroundImage; });
  const W = img.width, H = img.height;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const g = cv.getContext('2d', { willReadFrequently: true });
  g.drawImage(img, 0, 0);
  const d = g.getImageData(0, 0, W, H).data;
  const L = (x, y) => { const i = (y * W + x) * 4; return 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]; };
  const seam = H - c.data;                       // 拼接缝行
  const colE = new Float64Array(W);
  for (let x = 1; x < W - 1; x++) {
    let e = 0;
    for (let y = seam - 6; y < Math.min(H, seam + 10); y++) e += Math.abs(L(x + 1, y) - L(x - 1, y));
    colE[x] = e;
  }
  const scored = [];
  for (let dx = -W + 20; dx < W - 20; dx++) {
    let sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0, wsum = 0, n = 0;
    for (let x = 2; x < W - 2; x++) {
      const sx = x + dx;
      if (sx < 2 || sx >= W - 2) continue;
      const w = colE[x] + 1, a = L(sx, seam - 1), b = L(x, seam);
      sa += w * a; sb += w * b; saa += w * a * a; sbb += w * b * b; sab += w * a * b; wsum += w; n++;
    }
    if (n < 100) continue;
    const ma = sa / wsum, mb = sb / wsum;
    const va = saa / wsum - ma * ma, vb = sbb / wsum - mb * mb, cov = sab / wsum - ma * mb;
    scored.push({ dx, ncc: (va > 1e-6 && vb > 1e-6) ? cov / Math.sqrt(va * vb) : 0 });
  }
  scored.sort((a, b) => b.ncc - a.ncc);
  // ⚠️ 负号！moveX = -dx * (显示宽/图像宽)
  const uniq = [...new Set(scored.map((s) => Math.round(-s.dx * 260 / W)).filter((m) => m >= 0 && m <= 206))].slice(0, 4);
  const tried = [];
  for (const moveX of uniq) {
    const t0 = Date.now();
    const track = [{ x: 0, y: 0, type: 'down', t: 0 }];
    for (let i = 1; i <= 12; i++) track.push({ x: Math.round(moveX * i / 12), y: 0, type: 'move', t: i * 22 });
    const tEnd = track[track.length - 1].t + 40;
    track.push({ x: moveX, y: 0, type: 'up', t: tEnd });
    const res = await fetch('/credit/captcha/verify', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        bgImageWidth: 260, bgImageHeight: 159, sliderImageWidth: 260,
        sliderImageHeight: Math.round((H - c.data) / H * 159),
        startSlidingTime: new Date(t0).toISOString(),
        entSlidingTime: new Date(t0 + tEnd).toISOString(),
        trackList: track,
      }),
    });
    const txt = (await res.text()).trim();
    tried.push({ moveX, txt });
    if (txt === 'true') {
      const el = document.getElementById('verifyResult');
      if (el) el.value = 'true';           // 父页面靠轮询这个值决定 reload
      return { ok: true, moveX, tried };
    }
  }
  return { ok: false, tried };
};

async function main() {
  if (!chromium) { console.error('找不到 playwright-core'); process.exitCode = 1; return; }
  if (has('help') || argv.length === 0) { console.log(HELP); process.exitCode = argv.length === 0 ? 1 : 0; return; }

  const t0 = Date.now();
  const ctx = await chromium.launchPersistentContext(PROFILE, {
    channel: 'msedge', headless: !has('headed'), locale: 'zh-CN', userAgent: UA,
    viewport: { width: 1400, height: 1000 },
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const page = ctx.pages()[0] || await ctx.newPage();
  await page.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); });

  // 进门：过 WAF + 滑块
  async function unlock(url = SITE + '/credit/lawFirm') {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    // 等 iframe 出现（最多 8s）；有时 WAF 放行后直接就没有验证码
    for (let i = 0; i < 16; i++) {
      await page.waitForTimeout(500);
      if (page.frames().some((f) => f.url().includes('captcha/concat'))) break;
    }
    for (let i = 0; i < 4; i++) {
      const frame = page.frames().find((f) => f.url().includes('captcha/concat'));
      if (!frame) break;
      let r;
      try { r = await frame.evaluate(SOLVER); } catch (e) { r = { ok: false, err: String(e).slice(0, 80) }; }
      if (process.env.DEBUG) console.log('  captcha try', JSON.stringify(r));
      if (r && r.ok) {
        // 父页面轮询 #verifyResult 后自行 reload；等它刷新完
        await page.waitForTimeout(4500);
        if (!page.frames().some((f) => f.url().includes('captcha/concat'))) break;
        continue;
      }
      await page.waitForTimeout(800);
    }
    // 判定：正文里不再出现面包屑"验证码"即算进门
    const body = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' '));
    return !/首页 > 验证码/.test(body) && /高级检索|组织形式|律师事务所检索/.test(body);
  }

  const ok = await unlock();
  console.log(`=== 验证码解锁（${((Date.now() - t0) / 1000).toFixed(1)}s）: ${ok ? '✅ 已进入检索页' : '❌ 未通过'}`);
  if (!ok) {
    console.log('  提示：可加 --headed 观察，或删掉 profile 目录重试：' + PROFILE);
    await ctx.close(); process.exitCode = 4; return;
  }

  const body = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' '));
  console.log('  页面:', body.slice(0, 200));

  // 省份 → 区划码（从下拉里读，别硬编码）
  const provs = await page.evaluate(() => {
    const sel = document.querySelector('select.select-china') || document.querySelector('select');
    if (!sel) return [];
    return [...sel.options].map((o) => ({ code: o.value, name: o.text.trim() })).filter((o) => o.code);
  });

  if (has('provinces')) {
    console.log(`\n省份 → 区划码（${provs.length} 条）:`);
    for (const p of provs) console.log(`  ${p.code}\t${p.name}`);
    await ctx.close(); return;
  }

  if (has('unlock') && !has('firm') && !opt('province') && !has('by-province')) {
    await ctx.close(); return;
  }

  const kw = opt('firm');
  if (kw) {
    const url = SITE + '/credit/lawFirm?keyWords=' + encodeURIComponent(kw);
    await unlock(url);
    await page.waitForTimeout(1500);
    const txt = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' '));
    console.log(`\n=== 律所检索「${kw}」（累计 ${((Date.now() - t0) / 1000).toFixed(1)}s）===`);
    console.log(txt.slice(0, 2500));
    await ctx.close(); return;
  }

  const one = opt('province');
  const targets = has('by-province') ? provs.filter((p) => p.name && p.name !== '选择省') : (one ? [{ name: one }] : []);
  if (!targets.length) { console.log(HELP); await ctx.close(); process.exitCode = 1; return; }

  console.log(`\n=== 按省统计（${targets.length} 个省）===`);
  for (const p of targets) {
    let code = p.code;
    if (!code) {
      const hit = provs.find((x) => x.name === p.name) || provs.find((x) => x.name.includes(p.name));
      if (!hit) { console.log(`  ${p.name}: 未识别`); continue; }
      code = hit.code;
    }
    const url = SITE + '/credit/lawFirm?keyWords=&zone=' + code;
    await unlock(url);
    await page.waitForTimeout(1200);
    const txt = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' '));
    // ⚠️ 总数节点未验证：先尝试常见写法「共 N 条 / 共N家 / N 条记录」
    const m = txt.match(/共\s*([\d,]+)\s*(条|家|个|项)/);
    console.log(`  ${p.name.padEnd(10)} ${m ? '★ ' + m[1] + ' ' + m[2] : '(未解析到总数) ' + txt.slice(0, 100)}`);
  }
  console.log(`\n耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  await ctx.close();
}

main().catch((e) => { console.error('错误:', String(e && e.message || e).slice(0, 300)); process.exitCode = 1; });
