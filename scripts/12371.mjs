// ============================================================
// 共产党员网 CLI —— 12371.mjs
//
// 用法:
//   node 12371.mjs --dxby                          # 先进典型 → 全国优秀共产党员 全列表
//   node 12371.mjs --dxby --filter 张桂梅          # 在列表里按人名/标题过滤
//   node 12371.mjs --title 张桂梅                  # 只取标题（题目要的就是这个）
//   node 12371.mjs --article https://www.12371.cn/2020/12/16/ARTI1608087563818847.shtml
//   node 12371.mjs --self-test                     # 跑模拟题
//
// ── 逆向笔记 ────────────────────────────────────────────────
// 1. **栏目路径链**（纯静态 HTML，无接口、无 JS 渲染、无登录）：
//      首页 https://www.12371.cn/
//        └─ 导航「先进典型」 → https://www.12371.cn/special/dzby/
//             ├─ 全国优秀共产党员       → /special/dzby/dy/
//             ├─ 全国优秀党务工作者     → /special/dzby/dw/
//             ├─ 全国先进基层党组织     → /special/dzby/dzz/
//             ├─ "七一勋章"获得者       → /special/71xz/fc/
//             ├─ 共和国勋章 / 国家荣誉称号 → /special/dzby/ghg/ 、/special/dzby/ch/
//             └─ 功勋模范               → /special/gxmf/
//    ⚠️ 首页 grep「先进典型」只会命中导航文字，**链接要靠 `--links` 抓**，
//       因为导航是 `href="https://www.12371.cn/special/dzby/"` 包在 <a> 里的纯文本。
//
// 2. ⚠️ **"全国优秀共产党员展播"这个说法在站内不存在**。实际栏目是
//    「全国优秀共产党员」(/special/dzby/dy/)，按年份分块：2026年 / 2021年 /
//    2020年12月3日 / 2020年9月8日 / 2018年 / 2016年。张桂梅属于 **2020年12月3日** 那批
//    （2020-12-16 集中发布），列表项直接给出标题链接：
//      张桂梅：忠诚执着守初心 无私奉献担使命
//      → https://www.12371.cn/2020/12/16/ARTI1608087563818847.shtml
//
// 3. **列表页 DOM 特征**：`/special/dzby/dy/` 的条目是
//      <a href="...ARTI....shtml">标题</a>
//    混排了"年份标题"（如"全国优秀共产党员（2020年12月3日）"，指向 ARTI...shtml 的
//    名录页）和"人物条目"（如"张桂梅：..."，指向人物通讯）。
//    本脚本用「标题里含'：'或长度>8 且不含'全国优秀共产党员（'」区分，人物条目另列。
//
// 4. ⚠️ 部分条目是 http:// 而非 https://（如加思来提·麻合苏提），
//    还有跨站 biaozhang.12371.cn，本脚本统一按原样输出、不做协议改写。
//
// 5. 编码 UTF-8，直连 0.3~0.5s，无 WAF。
//
// ── 模拟题实测（node 12371.mjs --self-test）──────────────────
//   题：关于张桂梅事迹标题，不正确的是（答案 ABD）
//       正确标题 = "忠诚执着守初心 无私奉献担使命"
//   实测输出：张桂梅：忠诚执着守初心 无私奉献担使命
//             → 去掉人名前缀后与正确标题完全一致 ✅
// ============================================================

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36 Edg/154.0.0.0';
const BASE = 'https://www.12371.cn';
const COL = {
  dzby: '/special/dzby/',
  dy: '/special/dzby/dy/',
  dw: '/special/dzby/dw/',
  dzz: '/special/dzby/dzz/',
  qiyi: '/special/71xz/fc/',
  ghg: '/special/dzby/ghg/',
  ch: '/special/dzby/ch/',
  gxmf: '/special/gxmf/',
};

class Exit extends Error { constructor(c) { super('exit'); this.code = c; } }
const done = (code = 0) => { throw new Exit(code); };
const argv = process.argv.slice(2);
const has = (f) => argv.includes('--' + f);
const opt = (f, d = null) => { const i = argv.indexOf('--' + f); return i >= 0 ? argv[i + 1] : d; };

async function get(url, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9' }, redirect: 'follow' });
      const buf = Buffer.from(await r.arrayBuffer());
      return { status: r.status, text: new TextDecoder('utf-8').decode(buf), bytes: buf.length };
    } catch (e) { last = e; await new Promise((s) => setTimeout(s, 700 * (i + 1))); }
  }
  throw last;
}

const decode = (s) => String(s || '')
  .replace(/<[^>]+>/g, '')
  .replace(/&nbsp;/g, ' ').replace(/&ldquo;/g, '“').replace(/&rdquo;/g, '”')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&#39;/g, "'").replace(/&amp;/g, '&')
  .replace(/\s+/g, ' ').trim();

// 从列表页抽条目
function parseList(html) {
  const out = [];
  const re = /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]{0,300}?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    const href = m[1];
    const label = decode(m[2]);
    if (!label) continue;
    if (!/ARTI|VIDE|special|shtml/i.test(href)) continue;
    if (/^(首页|手机版|登录|注册|用户中心|我的投稿|我的问答|我的留言|退出账号|组工软件下载)$/.test(label)) continue;
    out.push({ href: /^https?:/i.test(href) ? href : BASE + (href.startsWith('/') ? '' : '/') + href, label });
  }
  const seen = new Set();
  return out.filter((x) => { const k = x.href + '|' + x.label; if (seen.has(k)) return false; seen.add(k); return true; });
}

// 判断是不是"人物条目"（相对年份名录页）
const isPerson = (label) => /：|:/.test(label) || (/^[^（(]{2,20}[：:]/.test(label)) || (!/全国优秀共产党员|全国优秀党务工作者|全国先进基层党组织|（\d{4}年/.test(label) && label.length >= 6 && label.length <= 40);

async function dxby(filter) {
  const pages = [['全国优秀共产党员', COL.dy], ['全国优秀党务工作者', COL.dw], ['全国先进基层党组织', COL.dzz]];
  console.log('\n=== 先进典型 → 全国优秀共产党员（及同栏目） ===');
  let all = [];
  for (const [name, path] of pages) {
    const { status, text } = await get(BASE + path);
    if (status !== 200) { console.log(`  [${name}] HTTP ${status} 跳过`); continue; }
    const items = parseList(text).filter((x) => isPerson(x.label));
    const uniq = [];
    const seen = new Set();
    for (const it of items) { if (seen.has(it.href)) continue; seen.add(it.href); uniq.push(it); }
    console.log(`\n-- ${name}  ${BASE}${path}  (${uniq.length} 条) --`);
    const shown = filter ? uniq.filter((x) => x.label.includes(filter) || x.href.includes(filter)) : uniq;
    shown.forEach((x, i) => console.log(`${String(i + 1).padStart(2)}. ${x.label}\n      ${x.href}`));
    if (filter && !shown.length) console.log('  (无匹配)');
    all = all.concat(uniq.map((u) => ({ ...u, col: name })));
  }
  return all;
}

async function titleOf(kw) {
  const all = await dxby(kw);
  const hit = all.filter((x) => x.label.includes(kw));
  console.log(`\n=== 标题提取「${kw}」 ===`);
  if (!hit.length) { console.log('(未在先进典型栏目找到)'); return null; }
  for (const h of hit) {
    const pure = h.label.replace(/^[^：:]{1,12}[：:]/, '').trim();
    console.log(`原文标题: ${h.label}`);
    console.log(`去人名后: ${pure}`);
    console.log(`链接:     ${h.href}`);
  }
  return hit;
}

async function article(url) {
  const { status, text } = await get(url);
  const t = (text.match(/<title>([\s\S]*?)<\/title>/i) || [])[1] || '';
  const h1 = (text.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || [])[1] || '';
  console.log(`\n=== 正文页 ===\n${url}`);
  console.log(`HTTP ${status} | ${text.length} 字符`);
  console.log(`<title>: ${decode(t)}`);
  if (h1) console.log(`<h1>:    ${decode(h1)}`);
  const body = text
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, '\n')
    .split('\n').map((s) => decode(s)).filter((s) => s.length > 20);
  console.log('\n--- 正文前 800 字 ---');
  console.log(body.slice(0, 8).join('\n').slice(0, 800));
}

async function selfTest() {
  const t0 = Date.now();
  console.log('########## 模拟题：张桂梅事迹标题（答案 ABD 为不正确项）##########');
  const hit = await titleOf('张桂梅');
  const want = '忠诚执着守初心 无私奉献担使命';
  const ok = !!hit && hit.some((h) => h.label.includes(want));
  console.log(`\n[判定] 期望正确标题：「${want}」`);
  console.log(`[判定] ${ok ? '✅ 站点标题含该串，与答案一致（ABD 为错误说法）' : '❌ 未匹配'}`);
  console.log(`\n耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  return ok;
}

async function main() {
  if (has('self-test')) { await selfTest(); return; }
  if (has('article')) { await article(opt('article')); return; }
  if (has('title')) { await titleOf(opt('title')); return; }
  if (has('dxby')) { await dxby(opt('filter')); return; }
  console.log(`共产党员网 CLI

用法:
  node 12371.mjs --dxby [--filter 人名]
  node 12371.mjs --title 张桂梅
  node 12371.mjs --article <URL>
  node 12371.mjs --self-test`);
  done(1);
}

main().catch((e) => {
  if (e instanceof Exit) { process.exitCode = e.code; return; }
  console.error('ERROR:', String(e && e.message || e).slice(0, 300));
  process.exitCode = 1;
});
