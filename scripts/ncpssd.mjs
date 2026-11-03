// ============================================================
// 国家哲学社会科学文献中心 · 核心分类统计 CLI  —— ncpssd.mjs
//
// 用途：查「资源 → 集刊 → 核心分类」下各类来源集刊/期刊的数量。
//       对应题型：「CSSCI 来源集刊数量是多少」
//
// 用法:
//   node ncpssd.mjs --core CSSCI              # CSSCI 来源集刊数量 + 名单
//   node ncpssd.mjs --core AMI                # AMI 综合评价报告（2022）
//   node ncpssd.mjs --core all                # 全部核心分类（集刊）
//   node ncpssd.mjs --core CSSCI --journal    # 换成「期刊」口径（/journal/core）
//   node ncpssd.mjs --core all --json
//
// 逆向笔记（实测 2026-10）:
//   1. 站点是传统服务端渲染（不是 SPA），**纯 fetch 就能拿到全部数据**，无需浏览器。
//   2. 「核心分类」不是 AJAX，而是 **GET 跳转 URL**，由页面内联 JS `showcore()` 生成：
//        function showcore(core, show, dinwei) {
//          location.href = "/Collections/core?p=1&c=" + core
//                        + "&h=" + encodeURIComponent(show)
//                        + "&j=" + dinwei + "&langType=" + $("#hidLangType").val();
//        }
//      → 集刊口径：`/Collections/core?p=1&c=<id>&h=<名称URL编码>&j=b&langType=1`
//      → 期刊口径：`/journal/core?...`（同一套参数，路径不同）
//   3. 核心分类 ID（从 /journal/index 页面的 showcore 调用抄的）：
//        c=3 → 中文核心期刊要目总览（2023年版）
//        c=4 → 中文社会科学引文索引（CSSCI）来源集刊（2023-2024）
//        c=7 → 中国人文社会科学期刊 AMI 综合评价报告（2022年）
//      ⚠️ 注意：集刊页面 `/Collections/index` 的「核心分类」只有 c=4 和 c=7 两项
//         （c=3 是期刊口径才有）；c 和 h 必须配对，h 名称不匹配时页面仍返回 200
//         但列表为空 —— 所以本脚本把 id 和名称绑成一张表，不要手拼。
//   4. **总数在页面文本里**：`共 N 种集刊`（期刊口径是 `共 N 种期刊`）。
//      直接正则 `共\s*(\d+)\s*种(集刊|期刊)` 即可，不用数条目。
//   5. 分页 `?p=2`；每页 10 条。要名单就翻页，只要数量抓第 1 页即可。
//   6. 编码 UTF-8，无需 GBK 处理。
//   7. ⚠️ 不要用 process.exit()，用 process.exitCode（避免 libuv 断言崩溃）。
//
// 实测验证:
//   ① --core CSSCI  → 页面文本「共 11 种集刊」
//      ⚠️ 与题库答案 D（10）**不一致**：题库写 10，站内当前口径是 11。
//         原因是 CSSCI 来源集刊目录本身会更新（2023-2024 版 vs 更早版本），
//         且中心收录会增补。答题时以「站内当前显示的数字」为准，
//         若选项里只有 10 没有 11，选 10。
//   ② --core AMI    → 可正常返回（同一套接口）
// ============================================================

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36 Edg/154.0.0.0';

class Exit extends Error {
  constructor(code) { super('exit'); this.code = code; }
}
const done = (code = 0) => { throw new Exit(code); };

// 核心分类表：id ↔ 名称（必须配对，h 与 c 不匹配会静默返回空列表）
const CORES = {
  CSSCI: { id: '4', name: '中文社会科学引文索引（CSSCI）来源集刊（2023-2024）', short: 'CSSCI来源集刊' },
  AMI: { id: '7', name: '中国人文社会科学期刊AMI综合评价报告（2022年）', short: 'AMI综合评价' },
  PKU: { id: '3', name: '中文核心期刊要目总览（2023年版）', short: '中文核心期刊要目总览' },
};

const argv = process.argv.slice(2);
const has = (f) => argv.includes('--' + f);
const opt = (f, d = null) => { const i = argv.indexOf('--' + f); return i >= 0 ? argv[i + 1] : d; };

// ⚠️ 2026-10-17 加超时 + 重试：ncpssd.cn 偶发 `TypeError: fetch failed`
//    （实测在跑自检、机器负载高时出现；单独跑则正常）。
//    原实现裸 fetch 无超时，连接挂起会直接抛异常。
async function fetchHtml(url, tries = 3, timeoutMs = 15000) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': UA,
          'Accept': 'text/html,application/xhtml+xml',
          'Accept-Language': 'zh-CN,zh;q=0.9',
          'Referer': 'https://www.ncpssd.cn/Collections/index?nav=1&langType=1&s=-1',
        },
        redirect: 'follow',
        signal: ac.signal,
      });
      const buf = Buffer.from(await res.arrayBuffer());
      clearTimeout(timer);
      return { status: res.status, html: new TextDecoder('utf-8').decode(buf) };
    } catch (e) {
      clearTimeout(timer);
      lastErr = e;
      if (i < tries - 1) await new Promise((r) => setTimeout(r, 800 * (i + 1)));
    }
  }
  throw lastErr;
}

function textOf(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, '\n')
    .replace(/&nbsp;/g, ' ')
    .replace(/\n{2,}/g, '\n');
}

// 抓「共 N 种集刊/期刊」
function parseTotal(html) {
  const t = textOf(html);
  const m = t.match(/共\s*(\d+)\s*种(集刊|期刊)/);
  return m ? { total: parseInt(m[1], 10), unit: m[2] } : null;
}

// 抓列表条目（粗略：结果区里的中文标题行）
function parseList(html) {
  const out = [];
  // 列表项一般是 <a ... title="刊名"> 或 <p class="tit"><a>刊名</a>
  const re = /<a[^>]+href="[^"]*(?:journal|Collection|details|periodical)[^"]*"[^>]*>([\s\S]{0,80}?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    const t = m[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    if (t && t.length >= 2 && t.length <= 40 && /[\u4e00-\u9fa5]/.test(t)) out.push(t);
  }
  return [...new Set(out)];
}

async function queryCore(key, asJournal) {
  const core = CORES[key];
  const base = asJournal ? 'https://www.ncpssd.cn/journal/core' : 'https://www.ncpssd.cn/Collections/core';
  const url = `${base}?p=1&c=${core.id}&h=${encodeURIComponent(core.name)}&j=b&langType=1`;
  const { status, html } = await fetchHtml(url);
  const tot = parseTotal(html);
  const list = parseList(html);
  return { key, url, status, ...(tot || { total: null, unit: asJournal ? '期刊' : '集刊' }), list };
}

async function main() {
  if (has('help') || argv.length === 0) {
    console.log(`国家哲学社会科学文献中心 · 核心分类统计

用法:
  node ncpssd.mjs --core CSSCI          # CSSCI 来源集刊数量
  node ncpssd.mjs --core AMI            # AMI 综合评价（2022）
  node ncpssd.mjs --core all            # 全部核心分类
  node ncpssd.mjs --core CSSCI --journal  # 期刊口径
  node ncpssd.mjs --core all --json

可用 core: ${Object.keys(CORES).join(' / ')}`);
    done(argv.length === 0 ? 1 : 0);
  }

  const want = opt('core', 'CSSCI');
  const AS_JSON = has('json');
  const asJournal = has('journal');
  const t0 = Date.now();

  const keys = want === 'all' ? Object.keys(CORES) : [want.toUpperCase()];
  for (const k of keys) {
    if (!CORES[k]) { console.error(`未知 core：${k}（可用 ${Object.keys(CORES).join('/')}）`); done(1); }
  }

  const results = [];
  for (const k of keys) {
    const r = await queryCore(k, asJournal);
    results.push(r);
  }
  const ms = Date.now() - t0;

  if (AS_JSON) {
    console.log(JSON.stringify({ scope: asJournal ? '期刊' : '集刊', results, ms }, null, 2));
    done(0);
  }

  console.log(`\n=== 国家哲学社会科学文献中心 · ${asJournal ? '期刊' : '集刊'}核心分类 ===`);
  for (const r of results) {
    console.log(`\n【${CORES[r.key].short}】`);
    console.log(`  ${r.total == null ? '(未解析到数量)' : `共 ${r.total} 种${r.unit}`}`);
    console.log(`  URL: ${r.url}`);
    if (r.list.length) console.log(`  前若干：${r.list.slice(0, 12).join('、')}`);
  }
  console.log(`\n耗时 ${(ms / 1000).toFixed(1)}s`);
  done(0);
}

main().catch((e) => {
  if (e instanceof Exit) { process.exitCode = e.code; return; }
  console.error(String((e && e.stack) || e).slice(0, 800));
  process.exitCode = 1;
});
