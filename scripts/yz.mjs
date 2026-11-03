// ============================================================
// 中国研究生招生信息网 · 院校库 CLI  —— yz.mjs
//
// 用途：按「省份 + 主管部门类别」筛选招生单位，返回数量或名单。
//       对应题型：「XX省由其他部委主管的招生单位有几所」
//                 「有 3 所及以上其他部委主管高校的省有哪些」
//
// 用法:
//   node yz.mjs --prov 甘肃                      # 该省全部招生单位（带主管部门）
//   node yz.mjs --prov 甘肃 --dept min           # 只要「其他部委」主管的
//   node yz.mjs --prov 甘肃 --dept moe           # 只要「教育部」主管的
//   node yz.mjs --prov 甘肃 --dept loc           # 只要「地方」主管的
//   node yz.mjs --sweep min --min 3              # 遍历全国，列出其他部委 >=3 所的省
//   node yz.mjs --prov 天津 --dept min --json
//
// 参数:
//   --prov <省名|省代码>   省份（"甘肃" 或 "62" 都行）
//   --dept <moe|min|loc>   主管部门类别：教育部 / 其他部委 / 地方
//   --sweep <moe|min|loc>  遍历全部省份做统计
//   --min <N>              配合 --sweep，只列出 >= N 所的省
//   --json                 机器可读输出
//
// 逆向笔记（实测 2026-10）:
//   1. 结果页 URL 完全可 GET 复现，**不需要浏览器**：
//        https://yz.chsi.com.cn/sch/search.do?ssdm=<省代码>&yxls=<类别>&ylgx=&yjsy=&zhx=
//      ⚠️ 坑：**主管部门类别的参数是 `yxls`，不是 `ylgx`**。
//        `ylgx` 是「院校特性」（双一流=1 等），传 ylgx=2/3 会返回「搜索无结果」，
//        一度让我误判为接口不可用。正确取值：
//          yxls=moe → 教育部   yxls=min → 其他部委   yxls=loc → 地方
//        （空 = 全部）。这三项来自页面 `<select name="yxls">` 的 option value。
//   2. 省份代码 ssdm（从页面 `span.yxk-option[data-id]` 抄的）：
//        11北京 12天津 13河北 14山西 15内蒙古 21辽宁 22吉林 23黑龙江
//        31上海 32江苏 33浙江 34安徽 35福建 36江西 37山东 41河南 42湖北
//        43湖南 44广东 45广西 46海南 50重庆 51四川 52贵州 53云南 54西藏
//        61陕西 62甘肃 63青海 64宁夏 65新疆 81香港 91澳门 71台湾
//   3. 结果块结构（每个招生单位一个）：
//        <a class="name js-yxk-yxmc ..." href="/sch/schoolInfo--schId-XXX.dhtml">兰州大学</a>
//        <div class="sch-department">
//          <i class="iconfont">&#xe6a4;</i> 甘肃
//          <span class="item-depart-title">主管部门：</span> 教育部
//        </div>
//      → 用 `js-yxk-yxmc` 切块，块内取 `主管部门：` 之后的第一个中文串。
//   4. 分页：`?start=20`（每页 20 条）。本脚本自动翻页直到某页 0 条，
//      避免「省份单位多于 20 个时数量统计偏小」。
//   5. 编码 UTF-8，直接 fetch + 正则即可，无需 GBK 嗅探。
//   6. ⚠️ 不要用 process.exit()（会触发 libuv 断言崩溃），用 process.exitCode。
//
// 实测验证:
//   ① 甘肃省 · 其他部委主管 = 4 所（兰州大学属教育部，不计入）
//      → 与题库答案 B（4）一致 ✅
//   ② --sweep min --min 3 → 天津(3) / 河北(3) / 辽宁(3)
//      → 与题库答案 ACD（天津/河北/辽宁）一致 ✅
// ============================================================

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36 Edg/154.0.0.0';

class Exit extends Error {
  constructor(code) { super('exit'); this.code = code; }
}
const done = (code = 0) => { throw new Exit(code); };

const PROV = {
  北京: '11', 天津: '12', 河北: '13', 山西: '14', 内蒙古: '15',
  辽宁: '21', 吉林: '22', 黑龙江: '23',
  上海: '31', 江苏: '32', 浙江: '33', 安徽: '34', 福建: '35', 江西: '36', 山东: '37',
  河南: '41', 湖北: '42', 湖南: '43', 广东: '44', 广西: '45', 海南: '46',
  重庆: '50', 四川: '51', 贵州: '52', 云南: '53', 西藏: '54',
  陕西: '61', 甘肃: '62', 青海: '63', 宁夏: '64', 新疆: '65',
  香港: '81', 澳门: '91', 台湾: '71',
};
const DEPT = { moe: '教育部', min: '其他部委', loc: '地方' };

const argv = process.argv.slice(2);
const has = (f) => argv.includes('--' + f);
const opt = (f, d = null) => { const i = argv.indexOf('--' + f); return i >= 0 ? argv[i + 1] : d; };

function decode(buf, contentType) {
  const ct = (contentType || '').toLowerCase();
  const m = ct.match(/charset=([\w-]+)/);
  if (m && /gb2312|gbk|gb18030/i.test(m[1])) {
    try { return new TextDecoder('gb18030').decode(buf); } catch { /* fallthrough */ }
  }
  return new TextDecoder('utf-8').decode(buf);
}

async function fetchPage(ssdm, yxls, start) {
  const url = `https://yz.chsi.com.cn/sch/search.do?ssdm=${ssdm}&yxls=${yxls}&ylgx=&yjsy=&zhx=`
    + (start ? `&start=${start}` : '');
  const res = await fetch(url, {
    headers: {
      'User-Agent': UA,
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'zh-CN,zh;q=0.9',
      'Referer': 'https://yz.chsi.com.cn/sch/',
    },
    redirect: 'follow',
  });
  const html = decode(Buffer.from(await res.arrayBuffer()), res.headers.get('content-type'));
  return { status: res.status, html, url };
}

// 从结果页 HTML 解析 [{name, prov, dept, schId}]
function parseSchools(html) {
  const out = [];
  // 以单位名为锚点切块
  const re = /<a[^>]*class="[^"]*js-yxk-yxmc[^"]*"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
  const marks = [];
  let m;
  while ((m = re.exec(html))) {
    marks.push({ idx: m.index, href: m[1], name: m[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim() });
  }
  for (let i = 0; i < marks.length; i++) {
    const start = marks[i].idx;
    const end = i + 1 < marks.length ? marks[i + 1].idx : Math.min(html.length, start + 4000);
    const chunk = html.slice(start, end);
    const provM = chunk.match(/<i class="iconfont">[^<]*<\/i>\s*([\u4e00-\u9fa5]{2,8})/);
    const deptM = chunk.match(/主管部门：<\/span>\s*([^<\s][^<]{0,30}?)\s*(?:<|$)/);
    const schM = marks[i].href.match(/schId-(\d+)/);
    out.push({
      name: marks[i].name,
      prov: provM ? provM[1] : '',
      dept: deptM ? deptM[1].replace(/\s+/g, '') : '',
      schId: schM ? schM[1] : '',
    });
  }
  return out;
}

async function listProv(ssdm, yxls) {
  const all = [];
  let start = 0;
  for (let page = 0; page < 30; page++) {
    const { status, html } = await fetchPage(ssdm, yxls, start);
    if (status !== 200) break;
    const rows = parseSchools(html);
    if (!rows.length) break;
    // 去重（翻页时偶尔重复）
    for (const r of rows) {
      if (!all.some((x) => x.schId && x.schId === r.schId)) all.push(r);
    }
    if (rows.length < 20) break;
    start += 20;
  }
  return all;
}

async function main() {
  if (has('help') || argv.length === 0) {
    console.log(`研招网院校库筛选 CLI

用法:
  node yz.mjs --prov 甘肃                  # 该省全部招生单位
  node yz.mjs --prov 甘肃 --dept min       # 其他部委主管
  node yz.mjs --sweep min --min 3          # 全国：其他部委 >=3 所的省
  node yz.mjs --prov 天津 --dept min --json

  --prov  <省名|省代码>   省份
  --dept  <moe|min|loc>   教育部 / 其他部委 / 地方
  --sweep <moe|min|loc>   遍历全国统计
  --min   <N>             配合 --sweep
  --json                  机器可读`);
    done(argv.length === 0 ? 1 : 0);
  }

  const AS_JSON = has('json');
  const t0 = Date.now();

  // ---------- sweep 模式 ----------
  if (opt('sweep')) {
    const yxls = opt('sweep');
    if (!DEPT[yxls]) { console.error('--sweep 只支持 moe|min|loc'); done(1); }
    const minN = parseInt(opt('min', '1'), 10);
    const results = [];
    for (const [name, code] of Object.entries(PROV)) {
      if (code === '81' || code === '91' || code === '71') continue; // 港澳台跳过
      const rows = await listProv(code, yxls);
      results.push({ prov: name, code, count: rows.length, schools: rows.map((r) => r.name) });
      process.stderr.write(`  ${name}(${code}) ${rows.length} 所\n`);
    }
    const hit = results.filter((r) => r.count >= minN).sort((a, b) => b.count - a.count);
    if (AS_JSON) {
      console.log(JSON.stringify({ dept: DEPT[yxls], min: minN, hit, all: results, ms: Date.now() - t0 }, null, 2));
    } else {
      console.log(`\n=== ${DEPT[yxls]}主管 · 招生单位 >= ${minN} 所的省份 ===`);
      for (const h of hit) {
        console.log(`  ${h.prov.padEnd(4, '　')} ${String(h.count).padStart(2)} 所   ${h.schools.join('、')}`);
      }
      console.log(`\n命中 ${hit.length} 个省；耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    }
    done(0);
  }

  // ---------- 单省模式 ----------
  const provArg = opt('prov');
  if (!provArg) { console.error('需要 --prov <省名|省代码>，或 --sweep <moe|min|loc>'); done(1); }
  const ssdm = PROV[provArg] || (/^\d+$/.test(provArg) ? provArg : null);
  if (!ssdm) { console.error(`未知省份：${provArg}`); done(1); }
  const yxls = opt('dept', '') || '';

  const rows = await listProv(ssdm, yxls);
  const ms = Date.now() - t0;

  if (AS_JSON) {
    console.log(JSON.stringify({ prov: provArg, ssdm, dept: yxls ? DEPT[yxls] : '全部', count: rows.length, schools: rows, ms }, null, 2));
    done(0);
  }

  console.log(`\n=== ${provArg}（ssdm=${ssdm}）${yxls ? '· ' + DEPT[yxls] : '· 全部'} 招生单位 ===`);
  console.log(`共 ${rows.length} 所\n`);
  for (const r of rows) {
    console.log(`  ${r.name}${r.dept ? '   [' + r.dept + ']' : ''}`);
  }
  if (yxls) {
    const byDept = {};
    for (const r of rows) byDept[r.dept] = (byDept[r.dept] || 0) + 1;
    console.log(`\n按主管部门分布：${Object.entries(byDept).map(([k, v]) => k + ' ' + v).join(' / ')}`);
  }
  console.log(`耗时 ${(ms / 1000).toFixed(1)}s`);
  done(0);
}

main().catch((e) => {
  if (e instanceof Exit) { process.exitCode = e.code; return; }
  console.error(String((e && e.stack) || e).slice(0, 800));
  process.exitCode = 1;
});
