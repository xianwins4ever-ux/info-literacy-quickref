// ============================================================
// 中国证券业协会 CLI —— sac.mjs
//   ① 从业人员登记编号查询（gs.sac.net.cn 公示系统）
//   ② 证券公司信息公示 / 按注册地（省）筛公司（jg.sac.net.cn 会员信息系统）
//
// 用法:
//   node sac.mjs --person 刘焕章                    # 按姓名查登记编号
//   node sac.mjs --person 刘焕章 --org 渤海证券      # 姓名 + 机构
//   node sac.mjs --cert S1150124020003              # 按登记编号反查
//   node sac.mjs --region 深圳                      # 注册地在深圳的证券公司
//   node sac.mjs --org 中信证券                      # 按公司名查
//   node sac.mjs --regions                          # 全部注册地码表（省/计划单列市）
//   node sac.mjs --all                              # 全部证券公司 + 注册地
//
// ============================================================
// 逆向笔记（2026-10-18 实测，纯 HTTP 直连，无需浏览器）
//
// 【A. 从业人员公示 gs.sac.net.cn】
// 1. 入口页：/pages/registration/new-sac-publicity-org.html（Vue3 CDN，无构建）
//    搜索页：/pages/registration/new-sac-publicity-search.html
// 2. 查询接口：**POST /publicity/v2/getPersonListByName**
//    Content-Type: application/x-www-form-urlencoded
//    body: name=<姓名>&orgName=<机构>
//    → {"success":true,"code":20000,"data":{"data":[...]}}
//    ⚠️ **两个字段都必须传**（哪怕 orgName 为空串）。
//       实测：只传 name（不带 orgName 字段）→ success:false、data:[]；
//       传 name + orgName=（空）→ 正常返回。这是最容易踩的坑。
// 3. ⚠️ 页面上的 `new-sac-publicity-report.html` 是**404**（老链接已废弃），
//    别照抄旧文档。当前有效的三个页面：
//      new-sac-publicity-org.html      机构/人员检索首页
//      new-sac-publicity-search.html   按姓名+机构列人
//      new-sac-finish-person.html?uuid= 人员详情（pracCtegCode==='3' 时用
//                                      new-sac-other-finish-person.html）
// 4. 返回字段（实测）：uuid / practnrNo / staffNo / name / **certifNo（登记编号）** /
//    regDate / orgId / orgName / pracCtegCode / pracCtegName / edu / gender /
//    regCnt / 各类违法失信计数(wfsxW4Cnt…) / bzjlCnt。
//    登记编号形如 `S1150124020003`（S + 4 位机构码 + 8 位日期 + 序号）。
// 5. 另有 GET /publicity/v2/getPersonUUID?certNo=&certifNo= → {uuid, pracCteg}，
//    用于按编号跳到详情页。
//
// 【B. 证券公司信息公示 jg.sac.net.cn】
// 1. 页面：https://jg.sac.net.cn/basicPublicityPub（Vue SPA，标题"中国证券业协会会员信息系统"）
// 2. 公司列表：**POST /api/member-manager/publicInfomation/secCompanybaseInfoList**
//    Content-Type: application/json，body: {"param":{"beltoRegiCode":"","orgName":""}}
//    → {recordsTotal, recordsFiltered, data:[{orgId, orgName, beltoRegiCode,
//        dictNameResult:{beltoRegiCode:"深圳", ...}}]}
//    ⚠️ **没有分页参数，一次返回全部**（实测 ~150 家全量）。
//    ⚠️ beltoRegiCode 是**注册地代码**，不是省名；映射见 /api/member-security/dict/queryDictCommonResult
//        body {"param":{"type":"DG0060"}} → [{code:"01",name:"上海"},{code:"02",name:"北京"},
//        {code:"03",name:"深圳"},{code:"04",name:"广东（不含深圳）"},…]
//        ⚠️ 深圳是**单列**的（计划单列市），问"注册地址在深圳"必须用 03，
//           用"广东"会漏掉中信证券、招商证券这些。
// 3. 公司详情 getSecCompanybaseInfoById 需要额外参数（实测 {"param":{"orgId":"736"}}
//    返回 -96001），本脚本只做列表级查询，详情请走页面。
//
// ============================================================
// 实测验证（模拟题）
//
// 题①：渤海证券 刘焕章的登记编号
//   node sac.mjs --person 刘焕章 --org 渤海
//   → 刘焕章 | 渤海证券股份有限公司 | 登记编号 **S1150124020003** | 一般证券业务
//   → 答案 D（S1150124020003）✅  耗时 ~0.35s
//
// 题②：注册地址在深圳的证券公司
//   node sac.mjs --region 深圳
//   → 24 家，含 **中信证券股份有限公司**（orgId 736）、招商证券、国信证券、平安证券…
//   → 答案 B（中信证券股份有限公司）✅  耗时 ~0.4s
// ============================================================

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36 Edg/154.0.0.0';
const GS = 'https://gs.sac.net.cn';
const JG = 'https://jg.sac.net.cn';

const argv = process.argv.slice(2);
const has = (f) => argv.includes('--' + f);
const opt = (f, d = null) => { const i = argv.indexOf('--' + f); return i >= 0 ? argv[i + 1] : d; };

const HELP = `中国证券业协会 CLI

用法:
  node sac.mjs --person <姓名> [--org <机构>]   从业人员登记编号
  node sac.mjs --cert <登记编号>                按编号查人
  node sac.mjs --region <注册地>                按注册地列证券公司（深圳/上海/北京/广东…）
  node sac.mjs --org <公司名>                   按名称查证券公司
  node sac.mjs --regions                        注册地码表
  node sac.mjs --all                            全部证券公司
  node sac.mjs --json                           输出原始 JSON

示例:
  node sac.mjs --person 刘焕章
  node sac.mjs --region 深圳
  node sac.mjs --org 中信证券`;

async function personList(name, orgName = '') {
  const body = new URLSearchParams({ name: name || '', orgName: orgName || '' }).toString();
  const t0 = Date.now();
  const res = await fetch(GS + '/publicity/v2/getPersonListByName', {
    method: 'POST',
    headers: {
      'User-Agent': UA,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Origin': GS,
      'Referer': GS + '/pages/registration/new-sac-publicity-search.html',
      'Accept': 'application/json, text/plain, */*',
    },
    body,
  });
  const j = await res.json();
  return { j, ms: Date.now() - t0, status: res.status };
}

async function personByCert(certifNo) {
  const q = new URLSearchParams({ certifNo }).toString();
  const res = await fetch(GS + '/publicity/v2/getPersonUUID?' + q, {
    headers: { 'User-Agent': UA, 'Referer': GS + '/pages/registration/new-sac-publicity-org.html' },
  });
  return res.json();
}

async function jpost(path, payload) {
  const t0 = Date.now();
  const res = await fetch(JG + path, {
    method: 'POST',
    headers: {
      'User-Agent': UA, 'Content-Type': 'application/json',
      'Origin': JG, 'Referer': JG + '/basicPublicityPub',
      'Accept': 'application/json, text/plain, */*',
    },
    body: JSON.stringify(payload),
  });
  const j = await res.json();
  return { j, ms: Date.now() - t0, status: res.status };
}

async function regions() {
  const { j } = await jpost('/api/member-security/dict/queryDictCommonResult', { param: { type: 'DG0060' } });
  return (j.data || []).map((d) => ({ code: d.code, name: d.name }));
}

async function companyList(beltoRegiCode = '', orgName = '') {
  const { j, ms } = await jpost('/api/member-manager/publicInfomation/secCompanybaseInfoList', {
    param: { beltoRegiCode, orgName },
  });
  return { rows: j.data || [], total: j.recordsTotal ?? (j.data || []).length, ms };
}

async function main() {
  if (has('help') || argv.length === 0) { console.log(HELP); process.exitCode = argv.length === 0 ? 1 : 0; return; }

  // ---- 从业人员 ----
  const name = opt('person');
  const org = opt('org');
  const cert = opt('cert');

  if (cert) {
    const j = await personByCert(cert);
    if (!j || !j.data || !j.data.uuid) { console.log(`未查到登记编号 ${cert} 对应人员`); return; }
    console.log(`登记编号 ${cert} → uuid=${j.data.uuid} pracCteg=${j.data.pracCteg}`);
    console.log(`详情页: ${GS}/pages/registration/new-sac-finish-person.html?uuid=${j.data.uuid}`);
    return;
  }

  if (name) {
    let { j, ms, status } = await personList(name, org || '');
    let list = (j && j.data && j.data.data) || [];
    // ⚠️ 服务端 orgName 是**精确匹配**（传"渤海"得 0，传"渤海证券股份有限公司"才对）。
    //    所以带 --org 命中 0 时，退化为「只按姓名查 + 本地模糊过滤」。
    if (!list.length && org) {
      const r2 = await personList(name, '');
      const all = (r2.j && r2.j.data && r2.j.data.data) || [];
      const hit = all.filter((p) => (p.orgName || '').includes(org));
      if (hit.length) { list = hit; ms = r2.ms; status = r2.status; console.log(`（orgName 精确匹配无果，已退化为姓名+本地模糊过滤「${org}」）`); }
      else { list = all; ms = r2.ms; status = r2.status; if (all.length) console.log(`（机构「${org}」无匹配，已改为列出该姓名的全部登记记录）`); }
    }
    console.log(`=== 从业人员查询（${ms}ms, HTTP ${status}）===`);
    console.log(`姓名: ${name}${org ? '  机构: ' + org : ''}   命中 ${list.length} 条`);
    if (!list.length) {
      console.log('（无结果。⚠️ 必须同时带 orgName 字段，本脚本已自动补空串；');
      console.log('  若仍为空，检查姓名是否准确，或加 --org 缩小范围）');
      return;
    }
    for (const p of list) {
      console.log(`\n  ★ 登记编号: ${p.certifNo || '(空)'}`);
      console.log(`    姓名: ${p.name}  性别: ${p.gender || '-'}  学历: ${p.edu || '-'}`);
      console.log(`    机构: ${p.orgName}`);
      console.log(`    执业类别: ${p.pracCtegName || '-'}   登记日期: ${p.regDate || '-'}`);
      console.log(`    执业登记次数: ${p.regCnt ?? '-'}   违法失信: ${p.wfsxCnt ?? 0}`);
    }
    return;
  }

  // ---- 证券公司 ----
  if (has('regions')) {
    const rs = await regions();
    console.log(`注册地码表 DG0060（${rs.length} 条）:`);
    for (const r of rs) console.log(`  ${r.code}\t${r.name}`);
    return;
  }

  const region = opt('region');
  const orgName = opt('org');

  if (region || orgName || has('all')) {
    let code = '';
    if (region) {
      const rs = await regions();
      const hit = rs.find((r) => r.name === region)
        || rs.find((r) => r.name.includes(region))
        || rs.find((r) => region.includes(r.name.replace(/（.*?）/g, '')));
      if (!hit) {
        console.error(`未识别的注册地「${region}」。可选：`);
        for (const r of rs) console.error(`  ${r.code} ${r.name}`);
        process.exitCode = 2; return;
      }
      code = hit.code;
      console.log(`注册地「${region}」→ 代码 ${hit.code}（${hit.name}）`);
    }
    const { rows, total, ms } = await companyList(code, orgName || '');
    console.log(`=== 证券公司信息公示（${ms}ms）===`);
    console.log(`条件: ${region ? '注册地 ' + region : ''}${orgName ? ' 名称含 ' + orgName : ''}${!region && !orgName ? ' 全部' : ''}`);
    console.log(`★ 命中 ${total} 家`);
    if (has('json')) { console.log(JSON.stringify(rows, null, 1)); return; }
    for (const d of rows) {
      const reg = (d.dictNameResult && d.dictNameResult.beltoRegiCode) || d.beltoRegiCode || '';
      console.log(`  ${String(d.orgName).padEnd(34)} 注册地 ${String(reg).padEnd(14)} orgId ${d.orgId}`);
    }
    return;
  }

  console.log(HELP);
  process.exitCode = 1;
}

main().catch((e) => {
  console.error('错误:', String(e && e.message || e).slice(0, 300));
  process.exitCode = 1;
});
