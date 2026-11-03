// 全站冒烟测试 v3.1（2026-10-17）
// 覆盖 26 个 CLI 里最关键的 24 项
// ⚠️ 两组：先纯 HTTP，再浏览器类（每个间隔 3 秒，避免 profile 锁冲突）
// ⚠️⚠️ v3.1 关键修复：DIR 改为**基于本文件位置**动态计算。
//     原版硬编码 'D:/素材/省公安厅/10.8computer use/比赛速查库'，
//     结果打包成 skill 后，在 skill 目录里跑仍然去跑**原目录的脚本** ——
//     skill 表面自包含、实际偷偷依赖原目录，原目录一删就全废。
//     现在用 import.meta.url 定位，放哪都能跑。
import { execFileSync } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = dirname(fileURLToPath(import.meta.url));
const results = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function runShell(script, args, timeoutMs = 240000) {
  const t0 = Date.now();
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', `${DIR}/${script}`, ...args],
      { cwd: DIR, encoding: 'utf8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true, out, ms: Date.now() - t0 };
  } catch (e) {
    return { ok: false, out: (e.stdout || '') + (e.stderr || ''), ms: Date.now() - t0 };
  }
}

function runNode(script, args, timeoutMs = 240000) {
  const t0 = Date.now();
  try {
    const out = execFileSync('node', [`${DIR}/${script}`, ...args],
      { cwd: DIR, encoding: 'utf8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true, out, ms: Date.now() - t0 };
  } catch (e) {
    return { ok: false, out: (e.stdout || '') + (e.stderr || ''), ms: Date.now() - t0 };
  }
}

function record(name, r, expect, retryFn = null) {
  const text = r.out || '';
  const lines = text.split('\n').map(s => s.trim()).filter(Boolean);
  const ev = expect ? lines.find(l => l.includes(expect)) : lines[0];
  const hit = expect ? lines.some(l => l.includes(expect)) : lines.length > 0;
  let pass = r.ok && hit;
  let note = '';

  // ⚠️ 偶发失败自动重试一次：知网/万方等站点偶发慢加载或风控抖动，
  //    单次失败不代表脚本坏了（实测 cnki --facet 单跑 100% 成功）。
  //    重试后仍失败才算真失败。
  if (!pass && retryFn) {
    note = ' (重试…)';
    console.log(`   ⏳ ${name} 首次未通过，重试一次…`);
    const r2 = retryFn();
    const lines2 = (r2.out || '').split('\n').map(s => s.trim()).filter(Boolean);
    const hit2 = expect ? lines2.some(l => l.includes(expect)) : lines2.length > 0;
    if (r2.ok && hit2) {
      pass = true;
      note = ' (重试通过)';
      r = r2;
    } else {
      r = r2;
    }
  }

  const finalText = (r.out || '');
  const finalLines = finalText.split('\n').map(s => s.trim()).filter(Boolean);
  const finalEv = expect ? finalLines.find(l => l.includes(expect)) : finalLines[0];
  results.push({ name, pass, ms: r.ms, evidence: (finalEv || finalLines[0] || '(无输出)').slice(0, 100) });
  console.log(`${pass ? '✅' : '❌'} ${name.padEnd(22)} ${String(r.ms).padStart(6)}ms  ${(finalEv || finalLines[0] || '(无输出)').slice(0, 85)}${note}`);
}

console.log('========== 全站冒烟测试 v3.2 ==========\n');
console.log('--- 第一组：纯 HTTP / 极快 ---');

// ⚠️ 第一组也带重试：连跑时机器负载高，纯 HTTP 脚本偶发 `fetch failed`
//    （实测 yz / ncpssd / nlc 都出现过，单独跑 100% 成功）。
//    统一用「首次失败自动重试一次」策略，避免把偶发网络抖动误报成脚本坏了。
const httpTests = [
  ['nlc.mjs', () => runNode('nlc.mjs', ['雷雨', '--fast']), '共 9 条'],
  ['nlc_guji.mjs', () => runNode('nlc_guji.mjs', ['--detail', 'searchType=1002&showType=1&indexName=data_512&fid=027042015010263']), '2 册'],
  ['std.mjs', () => runNode('std.mjs', ['GB/T 5750.1-2023']), '13.060'],
  ['pubmed.mjs', () => runNode('pubmed.mjs', ['CRISPR[Title/Abstract] NOT therapy[Title]', '--from', '2017', '--to', '2024', '--type', 'clinicaltrial']), '命中数: 44'],
  ['pubmed bookshelf', () => runNode('pubmed.mjs', ['--bookshelf', 'The Ethics of Human Enhancement Understanding the Debate']), 'Oxford University Press'],
  ['nsfc.mjs', () => runNode('nsfc.mjs', ['--complete', '--code', 'G01', '--year', '2015', '--type', '青年']), '189'],
  ['sac.mjs', () => runNode('sac.mjs', ['--person', '刘焕章']), 'S1150124020003'],
  ['yz.mjs', () => runNode('yz.mjs', ['--prov', '甘肃', '--dept', 'min']), '共 4 所'],
  ['ncpssd.mjs', () => runNode('ncpssd.mjs', ['--core', 'CSSCI']), '共 11 种'],
  ['fjlib.mjs', () => runNode('fjlib.mjs', ['--title', '历史地理大发现']), 'K916/24'],
  ['piyao.mjs', () => runNode('piyao.mjs', ['--ft', '--date', '2023-12-15']), '人工智能与网络辟谣'],
  ['12371.mjs', () => runNode('12371.mjs', ['--title', '张桂梅']), '忠诚执着守初心'],
  ['webq.mjs', () => runNode('webq.mjs', ['https://www.wenxianxue.cn/view/4.html', '--grep', '地理系统']), '地理系统'],
  ['dspace.ps1', () => runShell('dspace.ps1', ['-Query', 'Managing maintenance costs of pharmaceutical research and development', '-Size', '1']), '81 p.'],
  ['pubscholar.ps1', () => runShell('pubscholar.ps1', ['-Suggest', 'Effects of salt substitution on cumulative blood pressure: a secondary analysis of the SSaSS']), 'daa102490f17232a2fa83f8a00b7f4cb'],
];
for (const [name, fn, expect] of httpTests) {
  await sleep(500);
  record(name, fn(), expect, fn);
}

console.log('\n--- 第二组：浏览器类（每个间隔 3 秒）---');

const browserTests = [
  ['nmpa.mjs', () => runNode('nmpa.mjs', ['国械注准20163401733']), '戊型肝炎病毒'],
  ['cqulib.mjs', () => runNode('cqulib.mjs', ['--title', '文明的冲突']), '复本数'],
  ['zxgk.mjs', () => runNode('zxgk.mjs', ['星河互联集团有限公司']), '92,245'],
  ['nbs.mjs', () => runNode('nbs.mjs', ['普通、职业本专科毕业生数', '--year', '2018']), '753.3'],
  ['nbs.mjs --prov', () => runNode('nbs.mjs', ['粮食单位面积产量', '--year', '2023', '--prov', '河南']), '6141.95'],
  ['wf.mjs', () => runNode('wf.mjs', ['会议名称:"2025人工智能与工程管理学术交流会"']), '1,680'],
  ['vp.mjs', () => runNode('vp.mjs', ['K=人工智能']), '共找到'],
  ['cnki.mjs', () => runNode('cnki.mjs', ['--au', '丁耘', '--src', '中国社会科学', '--top', '1']), '共找到 7 条结果'],
  ['cnki.mjs --facet', () => runNode('cnki.mjs', ['--su', '数字经济 * 税收', '--from', '2015', '--to', '2025', '--facet', 'author', '--top', '0']), '刘奇超'],
];

// ── 第三组：详情页 + 引用格式（2026-10-17 新增，这是"能查任意字段"的核心验证）──
// ⚠️ 这三项各含一次详情页导航，比较慢（每项 25~40s），但**必须测**：
//    它们是「只能查条数」和「能查任意字段」的分界线。
const detailTests = [
  ['cnki --detail', () => runNode('cnki.mjs', ['--ti', '心物问题与气论', '--top', '1', '--detail']), 'GB/T 7714'],
  ['cnki 作者单位', () => runNode('cnki.mjs', ['--ti', '心物问题与气论', '--top', '1', '--detail']), '复旦大学哲学学院'],
  ['wf --detail', () => runNode('wf.mjs', ['题名:(碳中和)', '--type', 'paper', '--top', '1', '--detail']), 'GB/T 7714'],
  ['wf DOI', () => runNode('wf.mjs', ['题名:(碳中和)', '--type', 'paper', '--top', '1', '--detail']), 'DOI'],
  ['vp --detail', () => runNode('vp.mjs', ['K=人工智能', '--top', '1', '--detail']), 'GB/T 7714'],
  ['nlc 全字段', () => runNode('nlc.mjs', ['鲁迅', '--filter', '李长之']), '中图分类'],
  ['nlc_guji filter', () => runNode('nlc_guji.mjs', ['紅樓夢', '--filter', '萃文書屋', '--top', '1']), '册数'],
];

console.log('\n--- 第三组：详情页 + 引用格式（验证「能查任意字段」）---');
for (const [name, fn, expect] of detailTests) {
  await sleep(3000);
  record(name, fn(), expect, fn);
}

for (const [name, fn, expect] of browserTests) {
  await sleep(3000);
  // 浏览器类全部带重试（站点偶发抖动概率最高）
  record(name, fn(), expect, fn);
}

console.log('\n========== 汇总 ==========');
const pass = results.filter(r => r.pass).length;
console.log(`通过 ${pass} / ${results.length}`);
for (const r of results.filter(r => !r.pass)) {
  console.log(`  ❌ ${r.name} — ${r.evidence}`);
}
