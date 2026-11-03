// ============================================================
// 福建省图书馆 · 书目检索 CLI  —— fjlib.mjs
//
// 用途：题名/著者/ISBN → 索书号 + 馆藏地点 + 出版信息。
//       对应题型：「《XXX》（某人著）的索书号是多少」
//
// 用法:
//   node fjlib.mjs --title "历史地理大发现"
//   node fjlib.mjs --title "历史地理大发现" --author 姬文广
//   node fjlib.mjs --isbn 9787534993824
//   node fjlib.mjs --title "红楼梦" --rows 20
//   node fjlib.mjs --title "历史地理大发现" --json
//
// 逆向笔记（实测 2026-10）:
//   1. 馆藏系统是 **Interlib**（页脚 `www.interlib.com.cn V3.5.7`），
//      独立域名 `opac.fjlib.net`，与门户 www.fjlib.net 分离。
//   2. 门户首页的「书目检索」是 **POST 表单**（不是 GET）：
//        <form method="post" action="https://opac.fjlib.net/opac/search" target="_blank">
//          <input type="hidden" name="searchWay" value="title" />
//          <input type="text" name="q" placeholder="输入您想搜索的关键字" />
//        </form>
//      → 最小可用请求：`POST https://opac.fjlib.net/opac/search`
//        body: `searchWay=title&q=<题名>`
//      ⚠️ 坑：用 GET 传同名参数返回的是检索表单页，不是结果页。
//   3. searchWay 取值（页面下拉）：title 题名 / author 著者 / isbn / subject 主题词
//      / cls 分类号 / callno 索书号 / ctrlno 控制号。默认走 title 即可。
//   4. 结果页文本结构（htmlToText 之后）：
//        「检索到: N 条结果」
//        每条书目：
//          <题名>
//          著者: 姬文广著
//          出版社: 河南科学技术出版社
//          出版日期: 2020
//          索书号: K916/24
//        侧栏还有「馆藏地点」聚合（湖东闭架外借书库 / 三楼基藏库…）。
//      → 索书号用正则 `索书号[:：]\s*([A-Z]{1,3}\d+(?:\.\d+)?\/\d+)` 抓最稳。
//   5. 分页：`rows=10`（默认）。要更多结果传 `rows=20/50`；翻页参数是 `page=`。
//   6. 编码 UTF-8（Interlib 新版），无需 GBK 嗅探。
//   7. ⚠️ 不要用 process.exit()，用 process.exitCode。
//
// 实测验证:
//   ① --title "历史地理大发现"
//      → 检索到 1 条：姬文广著 / 河南科学技术出版社 / 2020 / **索书号 K916/24**
//      → 与题库答案 A（K916/24）一致 ✅
//      馆藏地点：湖东闭架外借书库、三楼基藏库（仅限馆内阅览）
// ============================================================

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36 Edg/154.0.0.0';

class Exit extends Error {
  constructor(code) { super('exit'); this.code = code; }
}
const done = (code = 0) => { throw new Exit(code); };

const argv = process.argv.slice(2);
const has = (f) => argv.includes('--' + f);
const opt = (f, d = null) => { const i = argv.indexOf('--' + f); return i >= 0 ? argv[i + 1] : d; };

function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6]|td|th|section|article)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .split('\n').map((s) => s.replace(/[ \t\u00a0]+/g, ' ').trim()).filter(Boolean).join('\n');
}

async function search({ searchWay, q, rows = 20 }) {
  const body = new URLSearchParams({ searchWay, q, rows: String(rows) }).toString();
  const res = await fetch('https://opac.fjlib.net/opac/search', {
    method: 'POST',
    headers: {
      'User-Agent': UA,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'zh-CN,zh;q=0.9',
      'Referer': 'https://www.fjlib.net/',
      'Origin': 'https://www.fjlib.net',
    },
    body,
    redirect: 'follow',
  });
  const buf = Buffer.from(await res.arrayBuffer());
  const ct = res.headers.get('content-type') || '';
  let html;
  if (/gb2312|gbk|gb18030/i.test(ct)) {
    try { html = new TextDecoder('gb18030').decode(buf); } catch { html = new TextDecoder('utf-8').decode(buf); }
  } else {
    html = new TextDecoder('utf-8').decode(buf);
  }
  return { status: res.status, html, url: res.url };
}

// 解析条目 —— 用 DOM class 锚点，比纯文本回溯稳得多
//   <div class="bookmeta" bookrecno="904764202">
//     <a class="title-link" ...>历史地理大发现</a>
//     著者: <a class="author-link" ...>姬文广著</a>
//     出版社: <a class="publisher-link" ...>河南科学技术出版社</a> &nbsp; 出版日期: 2020
//     索书号: <span class="callnosSpan">K916/24</span>
function parseRecords(html) {
  const text = htmlToText(html);
  const totalM = text.match(/检索到[:：]?\s*(\d+)\s*条/);

  const records = [];
  const blocks = html.split(/<div class="bookmeta"/i).slice(1);
  for (const blk of blocks) {
    const grab = (re) => {
      const m = blk.match(re);
      return m ? m[1].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim() : '';
    };
    const title = grab(/<a[^>]*class="title-link"[^>]*>([\s\S]*?)<\/a>/i);
    const author = grab(/<a[^>]*class="author-link"[^>]*>([\s\S]*?)<\/a>/i);
    const publisher = grab(/<a[^>]*class="publisher-link"[^>]*>([\s\S]*?)<\/a>/i);
    const pubdate = grab(/出版日期[:：]\s*([^<&\n]{1,20})/i);
    const callno = grab(/<span[^>]*class="callnosSpan"[^>]*>([\s\S]*?)<\/span>/i)
      || grab(/索书号[:：]\s*([^<]{1,30})/i);
    const isbn = grab(/express_isbn="([^"]+)"/i) || grab(/\bisbn="([^"]+)"/i);
    const recno = grab(/bookItem_(\d+)/i) || grab(/bookrecno="(\d+)"/i);
    if (title || callno) records.push({ title, author, publisher, pubdate, isbn, callno, recno });
  }

  // 馆藏地点（侧栏聚合，形如「馆藏地点\n湖东闭架外借书库\n(1)」）
  const locs = [];
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l === '馆藏地点');
  if (start >= 0) {
    for (const l of lines.slice(start + 1)) {
      if (/^显示更多/.test(l) || /^(文献类型|主题|著者|出版日期|语言种类|在馆|新到时间)/.test(l)) break;
      if (/^\(?\d+\)?$/.test(l) || l === '馆藏地点') continue;
      if (/[\u4e00-\u9fa5]/.test(l) && l.length <= 40) locs.push(l);
    }
  }

  return { total: totalM ? parseInt(totalM[1], 10) : records.length, records, locs: [...new Set(locs)] };
}

async function main() {
  if (has('help') || argv.length === 0) {
    console.log(`福建省图书馆 书目检索 CLI

用法:
  node fjlib.mjs --title "历史地理大发现"
  node fjlib.mjs --title "历史地理大发现" --author 姬文广
  node fjlib.mjs --isbn 9787534993824
  node fjlib.mjs --title "红楼梦" --rows 20 --json

  --title  <题名>     题名检索（searchWay=title）
  --author <著者>     著者检索（searchWay=author）
  --isbn   <ISBN>     ISBN 检索
  --rows   <N>        每页条数（默认 20）
  --json              机器可读`);
    done(argv.length === 0 ? 1 : 0);
  }

  const AS_JSON = has('json');
  const rows = parseInt(opt('rows', '20'), 10);
  let searchWay = 'title';
  let q = opt('title');
  if (!q && opt('author')) { searchWay = 'author'; q = opt('author'); }
  if (!q && opt('isbn')) { searchWay = 'isbn'; q = opt('isbn'); }
  if (!q) { console.error('需要 --title / --author / --isbn 之一'); done(1); }

  const t0 = Date.now();
  const { status, html, url } = await search({ searchWay, q, rows });
  const parsed = parseRecords(html);
  const ms = Date.now() - t0;

  // 若给了 --author 做二次过滤
  const authorFilter = opt('author');
  let recs = parsed.records;
  if (authorFilter && searchWay === 'title') {
    const f = recs.filter((r) => r.author.includes(authorFilter));
    if (f.length) recs = f;
  }

  if (AS_JSON) {
    console.log(JSON.stringify({ status, query: { searchWay, q }, url, total: parsed.total, records: recs, locations: parsed.locs, ms }, null, 2));
    done(0);
  }

  console.log(`\n=== 福建省图书馆 · 书目检索（${searchWay}=${q}）===`);
  console.log(`HTTP ${status} | 检索到 ${parsed.total} 条\n`);
  for (const r of recs) {
    console.log(`  《${r.title || '(题名未解析)'}》`);
    if (r.author) console.log(`    著者: ${r.author}`);
    if (r.publisher) console.log(`    出版: ${r.publisher}${r.pubdate ? ' / ' + r.pubdate : ''}`);
    if (r.isbn) console.log(`    ISBN: ${r.isbn}`);
    console.log(`    索书号: ${r.callno || '(未解析)'}`);
    console.log('');
  }
  if (parsed.locs.length) console.log(`  馆藏地点: ${parsed.locs.join('、')}`);
  console.log(`\n耗时 ${(ms / 1000).toFixed(1)}s`);
  done(0);
}

main().catch((e) => {
  if (e instanceof Exit) { process.exitCode = e.code; return; }
  console.error(String((e && e.stack) || e).slice(0, 800));
  process.exitCode = 1;
});
