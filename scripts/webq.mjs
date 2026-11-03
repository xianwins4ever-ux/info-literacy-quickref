// ============================================================
// 通用网页检索/抓取 CLI —— 万能兜底
//
// 用途：当某个站点没有专用 CLI 时，用这个直接抓页面、抽文本、找关键词。
//       大量"进入某网站查看 XXX"的题，本质就是"抓一个页面找一段文字"。
//
// 用法:
//   node webq.mjs "<URL>"
//   node webq.mjs "<URL>" --grep "关键词"                 # 只显示含关键词的行 + 上下文
//   node webq.mjs "<URL>" --grep "A|B" --ctx 2           # 正则 + 上下 2 行
//   node webq.mjs "<URL>" --links                        # 列出所有链接（找详情页/下载页）
//   node webq.mjs "<URL>" --links --filter "curriculum"  # 只看 URL 含该词的链接
//   node webq.mjs "<URL>" --text                         # 全文纯文本（截断到 6000 字）
//   node webq.mjs "<URL>" --raw                          # 原始 HTML
//   node webq.mjs "<URL>" --post "a=1&b=2"               # POST 表单
//   node webq.mjs "<URL>" --json                         # 按 JSON 解析并格式化
//
// 逆向/踩坑记录:
//   1. ⚠️ **编码**：国内老站点大量使用 GBK/GB2312。直接 `res.text()` 会得到乱码。
//      本脚本先按 `Content-Type` 的 charset 判断，缺失时**先试 UTF-8、坏字符多再按 GBK**。
//   2. ⚠️ **去标签顺序**：必须先删 `<script>`/`<style>` 再删标签，
//      否则 JS 里的字符串会被当成正文（实测很多站的正文污染来源）。
//   3. ⚠️ 压缩传输：Node 的 fetch 会自动解 gzip/deflate/br，无需手工处理。
//   4. 需要浏览器才能渲染的 SPA（如 kd.nsfc.cn、nbs）用本工具**抓不到数据**，
//      会返回很短的壳页面 —— 看到字节数很小就要警觉，改用专用脚本。
//   5. ⚠️ **不要用 `process.exit()`**：在 fetch 连接未完全关闭时强退会触发
//      libuv 断言 `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)`，
//      退出码变成 -1073740791。正确做法是设 `process.exitCode` 让进程自然退出。
//      本脚本用 `done(code)` 抛异常 + 顶层 catch 处理。
// ============================================================

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36 Edg/154.0.0.0';

class Exit extends Error {
  constructor(code) { super('exit'); this.code = code; }
}
const done = (code = 0) => { throw new Exit(code); };

function decode(buf, contentType) {
  const ct = (contentType || '').toLowerCase();
  let enc = null;
  const m = ct.match(/charset=([\w-]+)/);
  if (m) enc = m[1];
  if (!enc) {
    const head = Buffer.from(buf.slice(0, 2048)).toString('latin1');
    const mm = head.match(/charset\s*=\s*["']?([\w-]+)/i);
    if (mm) enc = mm[1];
  }
  const tryDecode = (e) => {
    try { return new TextDecoder(e, { fatal: false }).decode(buf); } catch { return null; }
  };
  if (enc && /gb2312|gbk|gb18030/i.test(enc)) return tryDecode('gb18030') || tryDecode('utf-8');
  if (enc && /utf-?8/i.test(enc)) return tryDecode('utf-8');
  const u = tryDecode('utf-8');
  if (u == null) return tryDecode('gb18030');
  const bad = (u.match(/\uFFFD/g) || []).length;
  if (bad > 3 && bad / Math.max(1, u.length) > 0.002) {
    const g = tryDecode('gb18030');
    if (g) return g;
  }
  return u;
}

function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6]|td|th|section|article)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .split('\n').map((s) => s.replace(/[ \t\u00a0]+/g, ' ').trim()).filter(Boolean).join('\n');
}

async function main() {
  const argv = process.argv.slice(2);
  const has = (f) => argv.includes('--' + f);
  const opt = (f, d = null) => { const i = argv.indexOf('--' + f); return i >= 0 ? argv[i + 1] : d; };
  const url = argv.find((a) => /^https?:\/\//i.test(a));

  if (!url) {
    console.error(`通用网页抓取 CLI

用法: node webq.mjs "<URL>" [选项]

  --grep <正则>     只显示匹配行（可加 --ctx N 显示上下文）
  --ctx <N>         上下文行数（默认 1）
  --links           列出所有链接
  --filter <词>     配合 --links，只保留 URL 或链接文字含该词的
  --text            输出全文纯文本（默认行为，可用 --limit 调整长度）
  --limit <N>       正文截断长度（默认 6000 字）
  --raw             输出原始 HTML
  --post <body>     POST（body 为 a=1&b=2 形式）
  --json            按 JSON 解析并格式化
  --header "k: v"   追加请求头（可重复）
  --timeout <ms>    超时（默认 20000）

示例:
  node webq.mjs "https://www.wenxianxue.cn/view/4.html" --grep "地理系统"
  node webq.mjs "https://xhsz.news.cn/s?action=index&k=苗族银饰" --links --filter curriculum`);
    done(1);
  }

  const headers = {
    'User-Agent': UA,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.8,*/*;q=0.7',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  };
  argv.forEach((a, i) => {
    if (a === '--header' && argv[i + 1]) {
      const idx = argv[i + 1].indexOf(':');
      if (idx > 0) headers[argv[i + 1].slice(0, idx).trim()] = argv[i + 1].slice(idx + 1).trim();
    }
  });

  const timeoutMs = Number(opt('timeout', '20000'));
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);

  const t0 = Date.now();
  let res, buf;
  try {
    const init = { headers, redirect: 'follow', signal: ac.signal };
    if (has('post')) {
      init.method = 'POST';
      init.body = opt('post');
      headers['Content-Type'] = headers['Content-Type'] || 'application/x-www-form-urlencoded';
    }
    res = await fetch(url, init);
    buf = Buffer.from(await res.arrayBuffer());
  } catch (e) {
    clearTimeout(timer);
    console.error(`请求失败: ${String(e).slice(0, 140)}`);
    done(2);
  }
  clearTimeout(timer);

  const html = decode(buf, res.headers.get('content-type'));
  console.log(`=== ${url} ===`);
  console.log(`HTTP ${res.status} | ${buf.length} 字节 | ${html.length} 字符 | ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  if (has('raw')) { console.log(html); return; }

  if (has('json')) {
    try { console.log(JSON.stringify(JSON.parse(html), null, 2)); }
    catch { console.log('(不是合法 JSON)'); console.log(html.slice(0, 2000)); }
    return;
  }

  const text = htmlToText(html);

  if (has('links')) {
    const filter = opt('filter');
    const links = [];
    const re = /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]{0,200}?)<\/a>/gi;
    let m;
    while ((m = re.exec(html))) {
      const href = m[1];
      const label = m[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
      if (filter && !href.includes(filter) && !label.includes(filter)) continue;
      links.push({ href, label });
    }
    const seen = new Set();
    console.log(`\n--- 链接 ---`);
    let n = 0;
    for (const l of links) {
      const key = l.href + '|' + l.label;
      if (seen.has(key)) continue;
      seen.add(key);
      n++;
      console.log(`  ${l.label ? l.label + '  →  ' : ''}${l.href}`);
    }
    console.log(`  (共 ${n} 条)`);
    return;
  }

  if (opt('grep')) {
    let re;
    try { re = new RegExp(opt('grep'), 'i'); }
    catch { console.error('正则无效'); done(1); }
    const ctxN = parseInt(opt('ctx', '1'), 10);
    const lines = text.split('\n');
    const hit = new Set();
    lines.forEach((l, i) => {
      if (re.test(l)) {
        for (let j = Math.max(0, i - ctxN); j <= Math.min(lines.length - 1, i + ctxN); j++) hit.add(j);
      }
    });
    if (!hit.size) {
      console.log(`\n(未匹配到「${opt('grep')}」) —— 下面是全文前 1500 字，供判断:`);
      console.log(text.slice(0, 1500));
    } else {
      console.log(`\n--- 匹配「${opt('grep')}」（${hit.size} 行）---`);
      let prev = -2;
      for (const i of [...hit].sort((a, b) => a - b)) {
        if (i > prev + 1) console.log('  ...');
        console.log('  ' + lines[i]);
        prev = i;
      }
    }
    return;
  }

  const LIMIT = parseInt(opt('limit', '6000'), 10);
  console.log('\n--- 正文 ---');
  console.log(text.length > LIMIT
    ? text.slice(0, LIMIT) + `\n...(截断，共 ${text.length} 字，用 --limit N 调整)`
    : text);
}

main().catch((e) => {
  if (e instanceof Exit) { process.exitCode = e.code; return; }
  console.error(String(e && e.stack || e).slice(0, 600));
  process.exitCode = 1;
});
