// ============================================================
// 国家高等教育智慧教育平台（研究生教育）CLI —— smartedu.mjs
//
// 状态: ❌ **未打通**（课程章节接口未定位到，模拟题无法验证）
//
// 用法:
//   node smartedu.mjs --probe            # 探测当前可达性 + 打印已确认的接口线索
//   node smartedu.mjs --self-test        # 跑模拟题（会如实报告"未打通"）
//
// ── 逆向笔记（已确认的部分 / 卡在哪）────────────────────────
// 1. 站点是 **纯 SPA（Vue3 + Vite）**，`https://graduate.smartedu.cn/` 首页 HTML
//    有 **2,359,263 字节**，但里面只有 `<div id="app">` 和两个资源引用：
//      <script src="/assets/index-QZbvsNKg.js">
//      <link  href="/assets/index-D64McC6C.css">
//    ⚠️ **不要被 2.35MB 骗了**——那是内联的 SVG/字体/base64，正文文本只有
//       "国家研究生智慧教育平台" 一行。用 webq.mjs grep 任何课程名都 0 命中。
//    ⇒ 静态抓取完全无效，必须走 JS 运行时或找到 XHR 接口。
//
// 2. **已确认的 API 网关**：bundle 里 `axios.create({ baseURL: '/api' })`，
//    所以所有业务接口形如 `https://graduate.smartedu.cn/api/<path>`。
//    从 `assets/index-QZbvsNKg.js`（4,076,281 字节）里提取到的 url 清单：
//      /auth/login  /auth/register  /auth/logout  /auth/code  /auth/oauth2/authorize
//      /system/user/getInfo  /system/menu/getRouters  /system/tenant/list
//      /system/dict/data/...  /system/config/...
//      /edu/home/getPrivacyPolicy  /edu/home/org/list  /edu/home/major/list
//      /edu/userCenter/learningPortraitOverview
//      /api/track/home/getSystemTime        ← 唯一在 bundle 里带 /api 前缀的（埋点用）
//    ⚠️ **课程 / 章节 / 资源详情接口不在这份主 bundle 里**，是路由懒加载的
//       独立 chunk（`/assets/<hash>.js`）。要定位必须：
//         ① 用 Playwright 打开课程页，监听 XHR 抓真实请求；或
//         ② 遍历 chunk 清单逐个 grep `course`/`chapter`。
//       本次时间不够，两者都没做完。
//
// 3. ⚠️⚠️ **关键发现：/api/edu/* 业务接口全部要登录 token**。
//    直接探 `/api/edu/course/list`、`/api/edu/course/chapter/list` 均返回：
//      HTTP 200  {"code": 401, "msg": "未能读取到有效 token", "data": null}
//    说明路由是存在的，但**未登录一律 401**；另有些路径返回的是**加密串**
//    （如 /api/edu/home/course/list → 一长串 base64 样密文），
//    响应体被前端用 sm-crypto/AES 二次加密，需要逆向解密函数才能读。
//    ⇒ 双重门槛：① 登录态 token  ② 响应体加密。
//    这两点本次都没突破，是"未打通"的根本原因。
//
// 4. ⚠️ 该站还带第三方客服 SDK：
//      https://sjmh.chinadegrees.cn/chat/api/embed?protocol=https&host=sjmh.chinadegrees.cn&token=...
//    与检索无关，可忽略。
//    另注意：首页第一个 <script> 是埋点 `/tac/js/load.min.js`，**不是** Vue 入口，
//    真正入口是 `/assets/index-QZbvsNKg.js`（3.9MB），找接口别抓错文件。
//
// 5. **人工兜底路径**（比赛现场 30 秒内可用）：
//      ① 浏览器打开 https://graduate.smartedu.cn/
//      ② 顶部"研究生教育"栏目 → 搜课程名《R语言数据分析》→ 北京邮电大学
//      ③ 进课程详情 → "课程目录/章节"，直接看第 14 章标题
//    模拟题问的是"第14章内容是'庐山烟雨浙江潮'（答案 A 正确）"，
//    本质是打开课程目录看章节名，人工 30 秒可完成。
//
// ── 模拟题实测（node smartedu.mjs --self-test）───────────────
//   题：北京邮电大学《R语言数据分析》第14章内容是"庐山烟雨浙江潮"（答案 A 正确）
//   实测：❌ 未打通 —— 章节接口未定位，无法取到第 14 章标题
// ============================================================

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36 Edg/154.0.0.0';
const BASE = 'https://graduate.smartedu.cn';

class Exit extends Error { constructor(c) { super('exit'); this.code = c; } }
const done = (code = 0) => { throw new Exit(code); };
const argv = process.argv.slice(2);
const has = (f) => argv.includes('--' + f);

async function req(url, tries = 3, timeoutMs = 12000) {
  let last;
  for (let i = 0; i < tries; i++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const r = await fetch(url, {
        headers: { 'User-Agent': UA, 'Accept': '*/*', 'Accept-Language': 'zh-CN,zh;q=0.9' },
        redirect: 'follow', signal: ac.signal,
      });
      const buf = Buffer.from(await r.arrayBuffer());
      clearTimeout(timer);
      return { status: r.status, text: new TextDecoder('utf-8').decode(buf), bytes: buf.length, ct: r.headers.get('content-type') };
    } catch (e) {
      clearTimeout(timer);
      last = e;
      await new Promise((s) => setTimeout(s, 600 * (i + 1)));
    }
  }
  throw last;
}

async function probe() {
  console.log('\n=== 国家高等教育智慧教育平台（研究生）可达性探测 ===');
  const home = await req(BASE + '/');
  console.log(`首页: HTTP ${home.status} | ${home.bytes} 字节 | ${home.ct}`);
  const appHtml = /<div id="app">/.test(home.text);
  const scripts = [...home.text.matchAll(/<script[^>]*src="([^"]+)"/g)].map((m) => m[1]);
  console.log(`SPA 壳: ${appHtml ? '是（Vue）' : '否'}`);
  // ⚠️ 第一个 <script> 是埋点 load.min.js（/tac/js/load.min.js），**不是**主 bundle；
  //    要挑 /assets/index-*.js 才是 Vue 应用入口。
  const scripts2 = [...home.text.matchAll(/<script[^>]*src="([^"]+)"/g)].map((m) => m[1]);
  const entry = scripts2.find((s) => /\/assets\/index-[^/]+\.js$/.test(s));
  console.log(`入口脚本: ${scripts2.join(', ') || '(无)'}`);
  console.log(`主 bundle: ${entry || '(未找到 /assets/index-*.js)'}`);
  // 正文可见文本量
  const text = home.text.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  console.log(`去标签正文长度: ${text.length} 字  ${text.length < 200 ? '← 几乎没有内容，纯 SPA 壳' : ''}`);

  if (entry) {
    const jsUrl = entry.startsWith('http') ? entry : BASE + entry;
    const js = await req(jsUrl).catch(() => null);
    if (js && js.status === 200) {
      console.log(`\n主 bundle: ${jsUrl}  ${(js.bytes / 1024 / 1024).toFixed(2)} MB`);
      const baseURL = (js.text.match(/baseURL\s*[:=]\s*['"`]([^'"`]{0,40})/) || [])[1];
      console.log(`axios baseURL: ${baseURL || '(未找到)'}`);
      const urls = [...new Set([...js.text.matchAll(/url\s*:\s*['"`]([^'"`]{3,90})['"`]/g)].map((m) => m[1]))];
      const courseLike = urls.filter((u) => /course|chapter|teach|resource|detail|study|lesson/i.test(u));
      console.log(`提取到 url 字段 ${urls.length} 条，其中课程/章节相关 ${courseLike.length} 条`);
      if (courseLike.length) courseLike.slice(0, 20).forEach((u) => console.log('  ' + u));
      else console.log('  ⚠️ 课程/章节接口不在此 bundle —— 在懒加载 chunk 里，需 Playwright 监听 XHR 才能定位');
      console.log(`\n已确认的 /edu/* 接口示例:`);
      urls.filter((u) => /^\/edu\//.test(u)).slice(0, 12).forEach((u) => console.log('  ' + u));
    }
  }

  // 试探几个候选章节接口（预期都失败，只为留证）
  console.log('\n--- 候选接口试探（预期失败）---');
  for (const p of ['/api/edu/course/list', '/api/edu/course/chapter/list']) {
    const r = await req(BASE + p, 1, 6000).catch((e) => ({ status: 0, text: String(e.message), bytes: 0 }));
    console.log(`  ${p}  → HTTP ${r.status}  ${r.text.slice(0, 80).replace(/\s+/g, ' ')}`);
  }
  console.log('\n结论: ❌ 课程章节接口未定位 + /api/edu/* 需登录 token（401），脚本无法自动取章节。请走人工路径（见脚本头部笔记 5）。');
}

async function selfTest() {
  const t0 = Date.now();
  console.log('########## 模拟题：《R语言数据分析》第14章 = "庐山烟雨浙江潮"（答案 A 正确）##########');
  await probe();
  console.log('\n[判定] ❌ 未打通 —— 无法取到第 14 章标题，题目答案无法用脚本验证');
  console.log('       人工路径: graduate.smartedu.cn → 研究生教育 → 搜《R语言数据分析》');
  console.log('                 → 北京邮电大学 → 课程目录 → 第14章');
  console.log(`\n耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  return false;
}

async function main() {
  if (has('self-test')) { await selfTest(); return; }
  if (has('probe')) { await probe(); return; }
  console.log(`国家高等教育智慧教育平台（研究生教育）CLI

⚠️ 状态: 未打通（课程章节接口在懒加载 chunk 里，尚未定位）

用法:
  node smartedu.mjs --probe        # 可达性 + 接口线索探测
  node smartedu.mjs --self-test    # 跑模拟题（会如实报告未打通）

人工兜底:
  https://graduate.smartedu.cn/ → 研究生教育 → 搜课程 → 课程目录看章节名`);
  done(1);
}

main().catch((e) => {
  if (e instanceof Exit) { process.exitCode = e.code; return; }
  console.error('ERROR:', String(e && e.message || e).slice(0, 300));
  process.exitCode = 1;
});
