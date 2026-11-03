#!/usr/bin/env node
// ============================================================
// 环境体检（doctor）—— skill 能否正常工作的唯一判据
//
// 为什么必须有这个文件：
//   skill 能打包「知识 + 脚本代码」，但**打包不了运行时状态**：
//     · playwright-core 装在哪个路径（11 个脚本依赖）
//     · 各站点的持久化 profile（登录态 / 过滑块的放行 cookie）
//     · 本机网络对目标站点的可达性（有些站是 IP 级封锁）
//   换机器、重装、隔几周再跑，这些都可能变。doctor 一眼看出问题在哪。
//
// 用法:
//   node doctor.mjs            # 快速体检（只查本地，1 秒）
//   node doctor.mjs --net      # 加网络连通性（约 30 秒）
//   node doctor.mjs --fix      # 尝试自动修复能修的部分（建目录/装依赖提示）
//   node doctor.mjs --json
//
// 退出码: 0=全绿  1=有警告（能跑但可能不稳）  2=有致命问题（跑不了）
// ============================================================

import { existsSync, statSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { playwrightCandidates, resolveProfile } from './scripts/_env.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = join(HERE, 'scripts');

const argv = process.argv.slice(2);
const has = (f) => argv.includes('--' + f);
const AS_JSON = has('json');

const report = { fatal: [], warn: [], ok: [], info: {} };
const F = (m) => report.fatal.push(m);
const W = (m) => report.warn.push(m);
const OK = (m) => report.ok.push(m);

// ---------- 1. Node 版本 ----------
// ⚠️ 脚本用了 fetch/AbortSignal/TextDecoder，需要 Node >= 18。
//    nsfc.mjs 还自带纯 JS DES 实现（因为 Node 24 的 OpenSSL3 禁了 DES），
//    所以 Node 版本过低/过高都要留意。
const nodeVer = process.versions.node;
const major = Number(nodeVer.split('.')[0]);
report.info.node = nodeVer;
if (major < 18) F(`Node ${nodeVer} 太低，需要 >= 18（fetch/AbortSignal 不可用）`);
else if (major >= 18 && major <= 26) OK(`Node ${nodeVer}`);
else W(`Node ${nodeVer} 未实测过（实测通过的是 24.x）`);

// ---------- 2. playwright-core（11 个浏览器类脚本的硬依赖） ----------
// 每个脚本的 CANDIDATES 都是 [...playwrightCandidates(), 'playwright-core']，
// 即「自动探测到的绝对路径」+「裸包名」两种方式，任意一种能找到就能跑。
const PW_CANDIDATES = playwrightCandidates();
let pwFound = null;
for (const p of PW_CANDIDATES) if (existsSync(p)) { pwFound = p; break; }
if (!pwFound) {
  // 试裸包名
  try {
    const r = execSync('node -e "import(\'playwright-core\').then(m=>console.log(\'ok\')).catch(e=>console.log(\'no\'))"',
      { encoding: 'utf8', timeout: 15000 }).trim();
    if (r === 'ok') pwFound = 'playwright-core (裸包名可解析)';
  } catch { /* ignore */ }
}
report.info.playwrightCore = pwFound;
if (pwFound) OK(`playwright-core: ${pwFound.length > 70 ? '...' + pwFound.slice(-60) : pwFound}`);
else F(`找不到 playwright-core —— 浏览器类脚本（cnki/wf/vp/nbs/nmpa/zxgk/bdxs/lawyer/unesdoc/nlc_guji/std）全部不可用。
     修复: npm i -g @playwright/mcp   （或 npm i -g playwright-core）`);

// ---------- 3. 浏览器（脚本用 channel: "msedge"，即系统装的正版 Edge） ----------
const EDGE_CANDIDATES = process.platform === 'win32'
  ? [
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  ]
  : process.platform === 'darwin'
    ? ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge']
    : ['/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable', '/opt/microsoft/msedge/msedge'];
const EDGE = EDGE_CANDIDATES.find((p) => existsSync(p)) || null;
report.info.edge = Boolean(EDGE);
if (EDGE) OK(`系统 Edge 存在: ${EDGE}`);
else W(`未找到系统 Edge（查过 ${EDGE_CANDIDATES.length} 个常见位置），浏览器类脚本可能失败。
     请安装 Edge，或把脚本里的 channel:'msedge' 改成 'chrome'（装 Chrome 亦可）`);

// ---------- 4. 持久化 profile（登录态 / 放行 cookie） ----------
// ⚠️ 这是 skill **打包不了**的东西。删了就得重新登录/重新过滑块。
// 路径由 scripts/_env.mjs 统一解析：~/.dsh/<名字>，可用 <SITE>_PROFILE 环境变量覆盖。
// 第 4 列是「首次放行」该加的参数（只有实测存在的标志才写，不臆造）。
const PROFILES = [
  ['cnki', resolveProfile('cnki-profile', 'CNKI_PROFILE'), '知网：过 blockPuzzle 后的放行态', '--headed'],
  ['wf', resolveProfile('wf-profile', 'WF_PROFILE'), '万方：过阿里云滑块后的放行 cookie（最常失效）', '--login'],
  ['vp', resolveProfile('vp-profile', 'VP_PROFILE'), '维普', '--headed'],
  ['nbs', resolveProfile('nbs-profile', 'NBS_PROFILE'), '国家统计局', '--headed'],
  ['nmpa', resolveProfile('nmpa-profile', 'NMPA_PROFILE'), '药监局', ''],
  ['zxgk', resolveProfile('zxgk-profile', 'ZXGK_PROFILE'), '法院（瑞数 WAF，被污染需删掉重建）', '--headed'],
  ['std', resolveProfile('std-profile', 'STD_PROFILE'), '国家标准', '--headed'],
  ['nlc', resolveProfile('nlc-profile', 'NLC_PROFILE'), '国图古籍（nlc_guji.mjs）', ''],
  ['bdxs', resolveProfile('bdxs-profile', 'BDXS_PROFILE'), '百度学术', '--headed'],
  ['lawyer', resolveProfile('lawyer-profile', 'LAWYER_PROFILE'), '律师诚信平台', '--headed'],
  ['unesdoc', resolveProfile('unesdoc-profile', 'UNESDOC_PROFILE'), 'UNESCO（需 headed 过 CF）', '--headed'],
];
const profileStatus = {};
for (const [name, p, desc, flag] of PROFILES) {
  const exists = existsSync(p);
  profileStatus[name] = exists;
  if (exists) {
    let size = 0;
    try { size = statSync(p).size; } catch { /* dir */ }
    OK(`profile ${name.padEnd(8)} 存在  (${desc})`);
  } else {
    W(`profile ${name.padEnd(8)} 缺失 —— ${desc}；首次运行会自动创建`);
    if (flag) W(`         首次放行：任意检索命令加 ${flag}，在有头浏览器里人工过验证`);
    else W('         该站通常 headless 直连即可，无需人工放行');
  }
}
report.info.profiles = profileStatus;

// ---------- 5. 脚本完整性 ----------
// 期望 26 个 .mjs + 2 个 .ps1（不含 _selftest / doctor）
const EXPECT = [
  '12371.mjs', 'bdxs.mjs', 'cnki.mjs', 'cqulib.mjs', 'fjlib.mjs', 'lawyer.mjs',
  'nbs.mjs', 'ncpssd.mjs', 'nlc_guji.mjs', 'nlc.mjs', 'nmpa.mjs', 'nsfc.mjs',
  'piyao.mjs', 'pubmed.mjs', 'sac.mjs', 'skgb.mjs', 'smartedu.mjs', 'std.mjs',
  'tingshen.mjs', 'unesdoc.mjs', 'vp.mjs', 'webq.mjs', 'wf.mjs', 'yz.mjs',
  'zhihuishu.mjs', 'zxgk.mjs',
  'dspace.ps1', 'pubscholar.ps1',
];
const missing = EXPECT.filter((f) => !existsSync(join(SCRIPTS, f)));
if (missing.length) F(`脚本缺失 ${missing.length} 个: ${missing.join(', ')}`);
else OK(`脚本完整 ${EXPECT.length} 个（26 .mjs + 2 .ps1）`);

// 语法快检（只查最大的几个，全查太慢）
if (!missing.length) {
  const syntaxBad = [];
  for (const f of EXPECT.filter((x) => x.endsWith('.mjs'))) {
    try {
      execSync(`node --check "${join(SCRIPTS, f)}"`, { stdio: 'ignore', timeout: 15000 });
    } catch { syntaxBad.push(f); }
  }
  if (syntaxBad.length) F(`语法错误: ${syntaxBad.join(', ')}`);
  else OK('全部 .mjs 语法检查通过');
}

// ---------- 6. 网络连通性（--net） ----------
// ⚠️ 只探测「纯 HTTP 且无风控」的站点，避免把带风控的站误判为不可用。
//    带风控的站（cnki/wf/vp）用浏览器，探测它们会消耗放行额度。
if (has('net')) {
  const PROBES = [
    ['eutils.ncbi.nlm.nih.gov', 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=cancer&retmode=json&retmax=1'],
    ['openstd.samr.gov.cn', 'https://openstd.samr.gov.cn/bzgk/gb/std_list?p.p1=0&p.p2=GB%2FT%205750.1-2023'],
    ['read.nlc.cn', 'http://read.nlc.cn/allSearch/searchList?searchType=24&showType=1&indexName=data_416&searchWord=%E9%9B%B7%E9%9B%A8'],
    ['kd.nsfc.cn', 'https://kd.nsfc.cn/'],
    ['api.github.com', 'https://api.github.com/repos/onnx/onnx'],
    ['xueshu.baidu.com', 'https://xueshu.baidu.com/'],
    ['ieeexplore.ieee.org', 'https://ieeexplore.ieee.org/'],
    ['fz.people.com.cn', 'https://fz.people.com.cn/skygb/sk/index.php/index/index/'],
  ];
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36 Edg/154.0.0.0';
  report.info.net = {};
  for (const [name, url] of PROBES) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 10000);
    const t0 = Date.now();
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: ac.signal });
      clearTimeout(t);
      const ms = Date.now() - t0;
      report.info.net[name] = { status: r.status, ms };
      // 已知封锁：418 / 403 的特定站点
      if (name === 'ieeexplore.ieee.org' && (r.status === 418 || r.status === 403)) {
        W(`IEEE ${r.status}（已知 IP 级封锁，非本 skill 问题）`);
      } else if (name === 'fz.people.com.cn' && (r.status === 403 || r.status === 199)) {
        W(`国家社科基金 ${r.status}（加速乐 WAF 按 IP 段拦截，已知不可用）`);
      } else if (r.status === 200 || r.status === 202) {
        OK(`网络 ${name.padEnd(26)} ${r.status} ${ms}ms`);
      } else {
        W(`网络 ${name.padEnd(26)} ${r.status} ${ms}ms`);
      }
    } catch (e) {
      clearTimeout(t);
      report.info.net[name] = { err: String(e).slice(0, 60) };
      W(`网络 ${name.padEnd(26)} 失败: ${String(e).slice(0, 50)}`);
    }
  }
}

// ---------- 7. 输出 ----------
if (AS_JSON) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log('\n========== 环境体检 ==========\n');
  console.log('Node ' + nodeVer + ' | ' + HERE + '\n');
  for (const m of report.ok) console.log('  ✅ ' + m);
  for (const m of report.warn) console.log('  ⚠️  ' + m);
  for (const m of report.fatal) console.log('  ❌ ' + m);
  console.log('\n------------------------------');
  console.log(`通过 ${report.ok.length} / 警告 ${report.warn.length} / 致命 ${report.fatal.length}`);
  if (report.fatal.length) {
    console.log('\n🔴 有致命问题，浏览器类脚本可能全部不可用。按上面提示修复后重跑。');
  } else if (report.warn.length) {
    console.log('\n🟡 可以跑，但注意警告项。最常失效的是 wf-profile（万方放行）。');
    console.log('   万方失效时的表现：检索跳 /verify。修复：node scripts/wf.mjs --login（有头手动拖一次滑块）');
  } else {
    console.log('\n🟢 全绿，可以直接开赛。建议再跑一次 node scripts/_selftest.mjs 做端到端验证。');
  }
}

process.exitCode = report.fatal.length ? 2 : report.warn.length ? 1 : 0;
