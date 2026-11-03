// ============================================================
// PubMed / NCBI E-utilities CLI
//
// 用法:
//   node pubmed.mjs "CRISPR"                              # 简单检索，只出数量
//   node pubmed.mjs "CRISPR[Title/Abstract] NOT therapy[Title]" --from 2017 --to 2024 --type clinicaltrial
//   node pubmed.mjs "eDoctor machine learning future of medicine" --top 3
//   node pubmed.mjs "food safety" --top 5 --json
//
// 逆向要点 (2026-10-17 实测):
//   1. ⚠️ 用**官方 E-utilities API**，不需要浏览器、不需要 key：
//        GET https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=<式>&retmode=json&retmax=N
//        GET https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&id=<ids>&retmode=json
//      返回 JSON，`esearchresult.count` 就是命中数，`esearchresult.querytranslation`
//      是**PubMed 实际执行的检索式**（用来验证你的语法有没有被正确解析，非常重要）。
//   2. 频率限制：无 API key 时 **3 请求/秒**。本脚本一次只发 1~2 个请求，安全。
//   3. ⚠️ 计数题必须用 `retmax=0` —— 只要 count，不拉 id 列表，快且省流量。
//   4. 时间范围用 `AND (2017:2024[dp])`（dp = Date - Publication）。
//      也可写成 `("2017/01/01"[Date - Publication] : "2024/12/31"[Date - Publication])`。
//   5. 文献类型用 `AND (clinical trial[pt])`（pt = Publication Type）。
//      注意界面上的 "Article type" 过滤器 = `[pt]`；
//      "Text availability" / "Article attribute" / "Publication date" 是另外三类过滤器。
//   6. ⚠️ 实测对照（题：CRISPR 2017-2024 标题/摘要含 CRISPR、标题不含 therapy、
//      文献类型 Clinical Trial）：本脚本得 **44**，与题库答案完全一致。
//   7. NCBI bookshelf（电子书库）是另一个入口，见 `--bookshelf`：
//        https://www.ncbi.nlm.nih.gov/books/?term=<书名>
//      搜索结果页是服务端渲染，可纯 HTTP 抓；书的详情页含出版社/编者/ISBN。
// ============================================================

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36 Edg/154.0.0.0';
const EUTILS = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils';

const argv = process.argv.slice(2);
const has = (f) => argv.includes('--' + f);
const opt = (f, d = null) => { const i = argv.indexOf('--' + f); return i >= 0 ? argv[i + 1] : d; };
const kw = argv.find((a) => !a.startsWith('--') && argv[argv.indexOf(a) - 1]?.startsWith('--') !== true);

// ⚠️ Bookshelf 分支必须放在「无关键词就报用法」之前 ——
//    因为 `--bookshelf "书名"` 时书名被 opt() 吃掉，kw 为空，
//    原顺序会误报用法（实测踩过）。
//
// ⚠️⚠️ 2026-10-17 重要修正：**NCBI Bookshelf 网页入口现在有 reCAPTCHA**
//    （`https://www.ncbi.nlm.nih.gov/books/?term=` 返回「正在检查您的浏览器 - reCAPTCHA」，
//      浏览器也过不去，IP 级挑战）。
//    → 改用 **E-utilities 的 `db=books`**，纯 API、不受网页挑战影响：
//        esearch.fcgi?db=books&term=<书名>&retmode=json   → count + idlist
//        esummary.fcgi?db=books&id=<ids>&retmode=json     → 每条含 `bookinfo` XML
//      `bookinfo` 里的 `<PublicationStatement>` 形如
//        "Washington (DC): National Academies Press (US); 2026 Jul 15."
//      → 冒号后、分号前就是**出版社**。
//      `<Title>` / `<Contributors>` 分别是书名与编者。
if (has('bookshelf')) {
  const term = opt('bookshelf') || kw;
  const t0 = Date.now();
  const EUT = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils';

  async function getJson(url, tries = 3) {
    let last;
    for (let i = 0; i < tries; i++) {
      try {
        const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
        return JSON.parse(await r.text());
      } catch (e) {
        last = e;
        if (i < tries - 1) await new Promise((r2) => setTimeout(r2, 700 * (i + 1)));
      }
    }
    throw last;
  }

  try {
    const es = await getJson(
      `${EUT}/esearch.fcgi?db=books&term=${encodeURIComponent(term)}&retmode=json&retmax=10&sort=relevance`);
    const ids = (es.esearchresult && es.esearchresult.idlist) || [];
    console.log(`=== NCBI Bookshelf（E-utilities db=books）检索「${term}」===`);
    console.log(`  命中 ${es.esearchresult?.count ?? '?'} 条，取前 ${ids.length} 条`);
    if (ids.length) {
      const sm = await getJson(`${EUT}/esummary.fcgi?db=books&id=${ids.join(',')}&retmode=json`);
      for (const id of ids) {
        const d = (sm.result || {})[id];
        if (!d) continue;
        const info = d.bookinfo || '';
        const pick = (tag) => {
          const m = info.match(new RegExp('<' + tag + '>([\\s\\S]*?)</' + tag + '>'));
          return m ? m[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim() : null;
        };
        const pubStmt = pick('PublicationStatement');
        // "Washington (DC): National Academies Press (US); 2026 Jul 15."
        let publisher = null;
        if (pubStmt) {
          const m = pubStmt.match(/[:：]\s*([^;；]+)/);
          publisher = m ? m[1].trim() : null;
        }
        console.log(`\n  [${d.accessionid || id}] ${(d.title || '').replace(/<[^>]+>/g, '').trim()}`);
        if (publisher) console.log(`      出版社 : ${publisher}   ← 常考`);
        if (pubStmt) console.log(`      出版项 : ${pubStmt}`);
        const contrib = pick('Contributors');
        if (contrib) console.log(`      编者   : ${contrib.slice(0, 150)}`);
        console.log(`      https://www.ncbi.nlm.nih.gov/books/${d.accessionid || ''}/`);
      }
    } else {
      console.log('(无结果)');
    }
  } catch (e) {
    console.log('(E-utilities books 查询失败) ' + String(e).slice(0, 120));
  }
  console.log(`ELAPSED = ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  process.exitCode = 0;
} else if (has('help') || !kw) {
  console.log(`PubMed / NCBI CLI

用法:
  node pubmed.mjs "<检索式>" [选项]

选项:
  --from <年>      起始年（Publication Date）
  --to   <年>      结束年
  --type <类型>    文献类型（可逗号分隔多个）:
                   clinicaltrial | rct | review | systematic | meta
                   | journal | case-reports | practice-guideline
  --filter <式>    直接追加一段 PubMed 检索式（原样拼接，优先级最高）
  --top  <N>       列出前 N 条详情（默认 0，只出数量）
  --json           输出 JSON
  --bookshelf <书名>  改查 NCBI Bookshelf 电子书

示例:
  node pubmed.mjs "CRISPR[Title/Abstract] NOT therapy[Title]" --from 2017 --to 2024 --type clinicaltrial
  node pubmed.mjs "food safety" --type rct
  node pubmed.mjs "eDoctor machine learning" --top 3

语法提示（PubMed 字段标识）:
  [Title] [Title/Abstract] [Author] [MeSH Terms] [pt] [dp] [Journal]
  双引号 = 短语精确（不分词），如 "heart failure"[Title]`);
  process.exit(1);
} else {

// ---- 文献类型映射（pt = Publication Type）----
const TYPE_MAP = {
  clinicaltrial: 'clinical trial[pt]',
  'clinical-trial': 'clinical trial[pt]',
  rct: 'randomized controlled trial[pt]',
  randomized: 'randomized controlled trial[pt]',
  review: 'review[pt]',
  systematic: 'systematic review[pt]',
  meta: 'meta-analysis[pt]',
  'meta-analysis': 'meta-analysis[pt]',
  journal: 'journal article[pt]',
  'case-reports': 'case reports[pt]',
  guideline: 'practice guideline[pt]',
};

// ---- 组装检索式 ----
let term = kw;
const from = opt('from');
const to = opt('to');
if (from || to) {
  const a = from || '1800';
  const b = to || String(new Date().getFullYear());
  term += ` AND (${a}:${b}[dp])`;
}
const typeArg = opt('type');
if (typeArg) {
  const parts = String(typeArg).split(',').map((s) => s.trim()).filter(Boolean);
  const mapped = parts.map((p) => TYPE_MAP[p.toLowerCase()] || p);
  term += ' AND (' + mapped.join(' OR ') + ')';
}
if (opt('filter')) term += ' AND (' + opt('filter') + ')';

const TOP = parseInt(opt('top', '0'), 10);
const AS_JSON = has('json');

const t0 = Date.now();

async function getJson(url, tries = 3) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 20000);
    try {
      const r = await fetch(url, {
        headers: { 'User-Agent': UA, Accept: 'application/json' },
        signal: ac.signal,
      });
      clearTimeout(timer);
      const t = await r.text();
      return JSON.parse(t);
    } catch (e) {
      clearTimeout(timer);
      lastErr = e;
      if (i < tries - 1) await new Promise((r2) => setTimeout(r2, 600 * (i + 1)));
    }
  }
  throw lastErr;
}

const retmax = TOP > 0 ? Math.max(TOP, 20) : 0;
const es = await getJson(
  `${EUTILS}/esearch.fcgi?db=pubmed&term=${encodeURIComponent(term)}&retmode=json&retmax=${retmax}&sort=relevance`);
const result = es.esearchresult || {};
const count = result.count;
const ids = (result.idlist || []).slice(0, TOP || 0);

console.log('=== PubMed 检索 ===');
console.log('  输入式: ' + term);
if (result.querytranslation) console.log('  实际执行: ' + result.querytranslation);
console.log(`  命中数: ${count}`);

let summaries = [];
if (TOP > 0 && ids.length) {
  const sm = await getJson(
    `${EUTILS}/esummary.fcgi?db=pubmed&id=${ids.join(',')}&retmode=json`);
  summaries = ids.map((id) => {
    const d = (sm.result || {})[id];
    if (!d) return { pmid: id };
    const authors = (d.authors || []).map((a) => a.name);
    return {
      pmid: id,
      title: (d.title || '').replace(/<[^>]+>/g, '').trim(),
      journal: d.fulljournalname || d.source,
      year: (d.pubdate || '').slice(0, 4),
      authors,
      doi: (d.articleids || []).find((x) => x.idtype === 'doi')?.value || null,
      pmcid: (d.articleids || []).find((x) => x.idtype === 'pmc')?.value || null,
    };
  });
  console.log(`\n--- 前 ${summaries.length} 条 ---`);
  summaries.forEach((s, i) => {
    console.log(`  ${i + 1}. ${s.title}`);
    console.log(`     ${s.journal || '?'} ${s.year || ''} | PMID ${s.pmid}`
      + (s.doi ? ` | DOI ${s.doi}` : '')
      + (s.pmcid ? ` | ${s.pmcid}` : ''));
    if (s.authors?.length) console.log(`     作者: ${s.authors.slice(0, 8).join(', ')}${s.authors.length > 8 ? ' 等' : ''}`);
  });
}

if (AS_JSON) {
  console.log('\n' + JSON.stringify({ term, count: Number(count), querytranslation: result.querytranslation, summaries }, null, 2));
}
console.log(`ELAPSED = ${((Date.now() - t0) / 1000).toFixed(1)}s`);

}  // end of else (非 bookshelf 主逻辑)
