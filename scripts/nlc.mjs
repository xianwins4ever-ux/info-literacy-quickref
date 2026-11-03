// ============================================================
// 中国国家图书馆「特色资源」CLI（民国图书等）
//
// 用法:
//   node nlc.mjs "雷雨"                     # 检索 + 逐条取详情
//   node nlc.mjs "雷雨" --fast              # 只列检索结果，不取详情（快）
//   node nlc.mjs "雷雨" --idx data_416      # 指定资源库（默认民国图书 data_416）
//   node nlc.mjs "雷雨" --filter 曹禺       # 只保留责任者/出版者含该词的条目
//   node nlc.mjs "雷雨" --json              # 输出 JSON
//
// 逆向要点 (2026-10-10 实测):
//   1. 入口：国图首页 →「特色资源」= http://read.nlc.cn/user/category
//      （首页链接文本「特色资源」指向 read.nlc.cn；另有「特色资源」→ advanceSearch/allRes）
//   2. **服务端渲染，纯 HTTP 可抓，无需浏览器**（无验证码/无签名/无瑞数）。
//      只需一个 JSESSIONID，会自动下发。
//   3. 检索：
//        GET /allSearch/searchList?searchType=24&showType=1&indexName=<库>&searchWord=<词>
//      结果页是 HTML，条目链接形如
//        /allSearch/searchDetail?searchType=24&showType=1&indexName=<库>&fid=<fid>
//   4. 详情：
//        GET /allSearch/searchDetail?...&fid=<fid>
//      字段结构固定为 <label>字段名：<span class="t1">值</span></label>，
//      可抓：出版时间 / 出版者 / 主题 / 责任者 / 中图分类 / 出版地 / 载体形态 / 摘要。
//      ⚠️ 每个 label 前面有一份被注释掉的同内容 <!-- 字段：<span class="t1">值</span> -->，
//         直接全文正则会把两者都匹配到；按 <label> 块解析更稳。
//   5. 封面图：http://read.nlc.cn/img2/img416/<fid>_001.jpg
//      （img416 与 indexName data_416 对应）
//   6. 「载体形态」就是题目问的那个字段（形如 "332页"）。
//
// 资源库 indexName（按需补充）:
//   data_416 = 民国时期文献 > 民国图书
// ============================================================

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36 Edg/154.0.0.0';
const ORIGIN = 'http://read.nlc.cn';

const argv = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 ? argv[i + 1] : dflt;
};
const has = (name) => argv.includes('--' + name);
const keyword = argv.find((a) => !a.startsWith('--') && argv[argv.indexOf(a) - 1]?.startsWith('--') !== true);

if (!keyword) {
  console.error(`用法: node nlc.mjs "<检索词>" [--fast] [--st 24] [--idx data_416] [--filter 词] [--json]

  --st <searchType>  资源库编号（默认 24 = 民国图书）
                     24    = 民国时期文献 > 民国图书（配 --idx data_416）
                     10024 = 中华古籍资源库 > 数字古籍
                     1002  = 数字古籍（详情页用，配 --idx data_512）
                     37    = 西夏文献（西夏碎金）
                     102   = 民族文字古籍特藏（配 --classification qid 等）
  --classification <码>  民族文字古籍的文种：qid=契丹文 xix=西夏文 tib=藏文
                        uio=回鹘文 sog=粟特文 mon=蒙古文 mch=满文 nuc=女真文
  --filter <词>      只保留含该词的条目
  --fast             只列检索结果，不进详情（快）`);
  process.exitCode = 1;
  throw new Error('no kw');
}

const INDEX = opt('idx', 'data_416');
const FILTER = opt('filter', null);
const FAST = has('fast');
const AS_JSON = has('json');

let cookie = '';
// ⚠️ 2026-10-17 加超时 + 重试：read.nlc.cn 偶发 `UND_ERR_CONNECT_TIMEOUT`
//    （实测在跑自检、机器负载高时出现；单独跑则正常）。
//    原实现裸 fetch 无超时，遇到连接挂起会直接抛异常崩掉整个脚本。
//    → 加 AbortSignal 硬超时（默认 12s）+ 3 次递增退避重试。
async function get(url, tries = 3, timeoutMs = 12000) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': UA,
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'zh-CN,zh;q=0.9',
          Referer: ORIGIN + '/',
          ...(cookie ? { Cookie: cookie } : {}),
        },
        redirect: 'follow',
        signal: ac.signal,
      });
      const sc = res.headers.getSetCookie?.() || [];
      for (const c of sc) {
        const kv = c.split(';')[0];
        if (kv.startsWith('JSESSIONID=')) cookie = kv;
      }
      clearTimeout(timer);
      return await res.text();
    } catch (e) {
      clearTimeout(timer);
      lastErr = e;
      if (i < tries - 1) await new Promise((r) => setTimeout(r, 800 * (i + 1)));
    }
  }
  throw lastErr;
}

// 详情页按 <label> 块解析，避开被注释掉的重复内容
function parseDetail(html) {
  const fields = {};
  const re = /<label>([\s\S]*?)<\/label>/g;
  let m;
  while ((m = re.exec(html))) {
    const block = m[1];
    // 跳过纯注释块
    if (/^\s*<!--/.test(block) && !/-->\s*[^<\s]/.test(block)) continue;
    const mm = block.match(/([^<>：\s]{1,10})：\s*<span class="t1">([^<]*)<\/span>/);
    if (mm && mm[2].trim()) fields[mm[1]] = mm[2].trim();
  }
  const title = (html.match(/<div class="title">\s*([\s\S]*?)<\/div>/) || [, ''])[1].replace(/\s+/g, ' ').trim();
  return { title, fields };
}

// 列表页每条结构（实测）：
//   <li><a href="...&fid=XXXX" target="_blank">
//         <div class="pic"><img src="http://read.nlc.cn/img2/img416/<fid>_001.jpg"/></div>
//         <span class="tt"><span style="color:red">书名</span></span>
//         <span class="txt"><p>作者: ...</p><p>出版社: ...</p></span>
//       </a></li>
// ⚠️ 标题在 <span class="tt">，**不是** <div class="title">（那是详情页的写法）。
function parseList(html) {
  const out = [];
  const seen = new Set();
  const re = /<li>([\s\S]*?)<\/li>/g;
  let m;
  while ((m = re.exec(html))) {
    const block = m[1];
    const fm = block.match(/fid=([A-Za-z0-9]+)/);
    if (!fm) continue;
    const fid = fm[1];
    if (seen.has(fid)) continue;
    seen.add(fid);
    const rawT = (block.match(/<span class="tt">([\s\S]*?)<\/span>/) || [, ''])[1];
    const title = rawT.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    const author = (block.match(/作者[:：]\s*([^<]{0,60})/) || [, ''])[1].trim();
    const pub = (block.match(/出版社[:：]\s*([^<]{0,60})/) || [, ''])[1].trim();
    out.push({ fid, title, author, publisher: pub });
  }
  const total = (html.match(/共\s*(\d+)\s*条/) || [, null])[1];
  return { rows: out, total: total ? +total : out.length };
}

// ---- 古籍详情页解析（2026-10-17 新增）----
// ⚠️ 古籍库（searchType=10024/1002/37/102）的详情页**不是** <label> 结构，
//    而是「字段：值」的纯文本行 + 一个「第N册 在线阅读」的册次列表。
//    实测（南岑吴氏宗谱，fid=027042015010263）：
//        南岑吴氏宗谱
//        责任者：
//        出版者： 东阳吴氏
//        出版时间： 清乾隆14年(1749)
//        类型： 家谱
//        卷 册
//        第1册 在线阅读
//        目录
//        第2册 在线阅读
//        ...
//    → 「共有几册」= 数「第N册」的个数（最大 N）。
function parseAncientDetail(html) {
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, '\n')
    .replace(/&nbsp;/g, ' ')
    .split('\n').map((s) => s.replace(/[ \t\u00a0]+/g, ' ').trim()).filter(Boolean);

  const fields = {};
  for (let i = 0; i < text.length; i++) {
    const m = text[i].match(/^([^：:]{2,8})[：:]\s*(.*)$/);
    if (m) {
      const k = m[1].trim();
      let v = m[2].trim();
      // 值可能换行在下一行
      if (!v && text[i + 1] && !/^[^：:]{2,8}[：:]/.test(text[i + 1]) && text[i + 1].length < 60) {
        v = text[i + 1];
      }
      if (v) fields[k] = v;
    }
  }
  // 册次
  const vols = [...new Set((html.match(/第\s*(\d+)\s*册/g) || [])
    .map((s) => Number(s.replace(/[^\d]/g, ''))))].sort((a, b) => a - b);
  return { fields, volCount: vols.length, vols };
}

const t0 = Date.now();
const ST = opt('st', '24');   // searchType：24=民国图书 10024/1002=数字古籍 37=西夏文献 102=民族文字古籍
const CLASSIFICATION = opt('classification');
const listUrl = `${ORIGIN}/allSearch/searchList?searchType=${ST}&showType=1&pageNo=1`
  + (INDEX && ST === '24' ? `&indexName=${INDEX}` : '')
  + `&searchWord=${encodeURIComponent(keyword)}`
  + (CLASSIFICATION ? `&classification=${CLASSIFICATION}` : '');
const listHtml = await get(listUrl);
const { rows, total } = parseList(listHtml);

console.log(`=== 检索「${keyword}」 @ searchType=${ST} | 共 ${total} 条，解析出 ${rows.length} 条 ===`);
if (!rows.length) {
  console.log('(无结果) 提示：换关键词，或确认 --idx / --st 资源库是否正确。');
  process.exitCode = 2;
  throw new Error('no result');
}
// 注意：该库是**分词/模糊**匹配，无关检索词也可能返回若干条（曾见「绝无此书ZZZ998877」返回 2 条）。
// 所以不要只看条数，务必核对书名/责任者/出版时间是否对得上。

let results = rows;
if (FAST) {
  if (FILTER) results = results.filter((r) => JSON.stringify(r).includes(FILTER));
  for (const r of results) console.log(`  [${r.fid}] ${r.title}  作者: ${r.author}  出版社: ${r.publisher}`);
} else {
  for (const r of results) {
    const html = await get(`${ORIGIN}/allSearch/searchDetail?searchType=${ST}&showType=1`
      + (INDEX && ST === '24' ? `&indexName=${INDEX}` : '') + `&fid=${r.fid}`);
    const d = parseDetail(html);
    const ancient = parseAncientDetail(html);
    r.detail = { ...ancient.fields, ...d.fields };
    r.volCount = ancient.volCount;
    r.vols = ancient.vols;
    r.title = d.title || r.title;
  }
  if (FILTER) results = results.filter((r) => JSON.stringify(r).includes(FILTER));
  if (AS_JSON) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    for (const r of results) {
      const f = r.detail || {};
      console.log(`[${r.fid}] ${r.title}`);
      // ⚠️ 2026-10-17：原来只硬编码打印 5 个字段（责任者/出版时间/出版者/载体形态/主题），
      //    实测详情页还有**出版地 / 中图分类 / 拼音题名 / 摘要 / 版本项 / 善本书号**等，
      //    题目问这些就查不到。改为：先打常用字段，再把**其余所有字段**列出来。
      const PRI = ['责任者', '出版时间', '出版者', '出版地', '载体形态', '类型', '主题',
        '中图分类', '拼音题名', 'ISBN', 'ISSN', '版本项', '善本书号', '四部分类号',
        '版本书目史注', '出版发行项', '存卷', '摘要'];
      const seen = new Set();
      for (const k of PRI) {
        if (f[k]) {
          const hint = k === '载体形态' ? '        <-- 页数在这里' : '';
          console.log(`    ${k.padEnd(9)}: ${f[k]}${hint}`);
          seen.add(k);
        }
      }
      if (r.volCount) console.log(`    册数     : ${r.volCount} 册（${r.vols.join(', ')}）   <-- 「共有几册」看这里`);
      // 兜底：显示未列出的字段
      const rest = Object.keys(f).filter((k) => !seen.has(k) && !/^当前位置$|^分享到$|^电话$/.test(k));
      if (rest.length) {
        for (const k of rest) {
          const v = String(f[k]);
          if (v.length < 300) console.log(`    ${k.padEnd(9)}: ${v}`);
        }
      }
    }
  }
}
console.log(`ELAPSED = ${((Date.now() - t0) / 1000).toFixed(1)}s`);
