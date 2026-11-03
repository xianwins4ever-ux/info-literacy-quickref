// ============================================================
// 国家自然科学基金大数据知识管理服务门户（kd.nsfc.cn）CLI —— nsfc.mjs
//
// 用途：结题项目 / 资助项目 / 申请代码 三类检索，直接出数字和条目。
//
// 用法:
//   node nsfc.mjs --complete --code G01 --year 2015 --type 青年        # 结题项目数量
//   node nsfc.mjs --complete --unit 清华大学 --code E0805 --year 2023  # 结题项目清单
//   node nsfc.mjs --complete --code G01 --year 2015 --type 青年 --json
//   node nsfc.mjs --detail <项目ID>          # 单个结题项目详情（含结题摘要/成果）
//   node nsfc.mjs --codes                    # 全部申请代码表（A01/E0805…）
//   node nsfc.mjs --types                    # 全部资助类别（名称 → 代码）
//
// 参数:
//   --complete           查结题项目（默认）
//   --fund               查资助项目（⚠️ 需登录，见坑 6）
//   --code <代码>        申请代码，如 G01 / E0805 / H30
//   --year <年>          结题年度（--fund 时为批准年度）
//   --unit <依托单位>     如 清华大学
//   --type <类别>        资助类别，可写中文名或数字码（脚本自动映射）
//   --name <关键词>      项目名称
//   --person <姓名>      负责人
//   --page <N> --size <N> 分页（默认第 1 页 10 条）
//   --top <N>            列出前 N 条（默认 10）
//   --json               输出原始 JSON
//
// ============================================================
// 逆向笔记（2026-10-18 实测）
//
// 1. ⚠️ **全站 API 响应是 DES/ECB/PKCS7 + Base64 加密的**，密钥硬编码在前端：
//      app.7743de85.js → `parcel(e)` 函数
//      key = "IFROMC86"（8 字节 ASCII，正好一个 DES key）
//      `CryptoJS.DES.decrypt({ciphertext: Base64.parse(e)}, Utf8.parse("IFROMC86"),
//        {mode: ECB, padding: Pkcs7})`
//    → 不解决这层，看到的永远是 `BFjkDmNuMwgFUO1t...` 这种密文。
//    ⚠️ 个别接口（如 /api/common/dataView）返回**明文 JSON**，所以解析要"先试 JSON，
//       失败再试 DES"，不能只走一条路。
//
// 2. ⚠️ **Node 24 的 OpenSSL 3 默认禁用 DES**：`crypto.createDecipheriv('des-ecb')`
//    直接抛 `ERR_OSSL_EVP_UNSUPPORTED`。`--openssl-legacy-provider` 也未必可用。
//    → 本脚本自带一份**纯 JS DES 实现**（IP/FP/E/P/PC1/PC2/SBOX 全表），零依赖、
//      稳定可复现。自测：用真实密文往返（encrypt(decrypt(x)) === x）通过。
//
// 3. **请求格式**（踩过的坑）：
//    - `Content-Type: application/json;charset=UTF-8` + JSON body  → 200 ✅
//    - `Content-Type: application/x-www-form-urlencoded` + form body → **415** ❌
//      （/api/common/dataView 例外，它是 form 的）
//    - GET → **405 Method Not Allowed**
//
// 4. **结题项目检索**：`POST /api/baseQuery/completionQueryResultsData`
//    参数对象（全部字段都要给，缺字段会 500）：
//      {code, fuzzyKeyword, complete:true, isFuzzySearch:false, conclusionYear,
//       dependUnit, keywords, pageNum, pageSize, personInCharge, projectName,
//       projectType, subPType, psPType, ratifyNo, ratifyYear, order, ordering,
//       codeScreening, dependUnitScreening, keywordsScreening, projectTypeNameScreening}
//    返回：`{code:200, data:{resultsData:[...], itotalRecords:N}}`
//    ⚠️ **空条件（全空对象）会 500**，至少要给 conclusionYear 或 code。
//    ⚠️ **projectType 必须传数字码**（"630"），传中文名（"青年科学基金项目"）→ 结果 0。
//
//    resultsData 每行是**定长数组**（19 项），按位置取值：
//      [0]  项目ID（UUID，用于 --detail）
//      [1]  项目名称
//      [2]  批准号
//      [3]  资助类别名（"青年科学基金项目（C类）"）
//      [4]  依托单位
//      [5]  负责人
//      [6]  资助经费（万元）
//      [7]  **批准年度**
//      [8]  项目关键词（分号分隔）
//      [9]  hasReport
//      [10] 成果计数串 "14;0;0;1;3"
//      [11] 依托单位ID
//      [12] 负责人ID
//      [13] ?
//      [14] **申请代码**（如 E0805）
//      [15] **结题年度**
//
// 5. **资助类别码表**（/api/common/supportTypeClassOneData，实测）：
//      630 青年科学基金项目（C类）    218 面上项目        631 地区科学基金项目
//      220 重点项目                  579 联合基金项目    339 重大研究计划
//      80  数学天元基金项目          8531 专项项目        649 专项基金项目
//      433 国际(地区)合作与交流项目   51/52 国家重大科研仪器
//    ⚠️ 老题库里的"青年科学基金项目"现在叫"青年科学基金项目（C类）"，码还是 630。
//
// 6. ⚠️ **"资助项目"（projectAnnounced / fundingProjectInit）需要统一认证登录**，
//    未登录访问会被 302 到 /login?redirect=...。所以 --fund 在本机跑不通，
//    脚本会明确报"需登录"。题库里"资助项目"的题如果非登录不可，就换思路。
//    结题项目（finalProjectInit）是**免登录**的，这是主战场。
//
// 7. **详情**：`POST /api/baseQuery/conclusionProjectInfo/<项目UUID>`（注意是 POST，
//    不是 GET；body 可为空字符串）。返回 projectName / ratifyNo / projectType /
//    code / projectAdmin / dependUnit / researchTimeScope / supportNum /
//    projectAbstractC / conclusionAbstract / projectKeywordC / resultsList。
//
// 8. **SPA 导航**：URL 不变，入口是点"信息检索"→ /finalProjectInit。
//    本脚本**完全绕过页面**直打 API，不需要浏览器，单次查询 ~0.6s。
//
// ============================================================
// 实测验证（模拟题）
//
// 题①：2015年 申请代码 G01 的青年科学基金项目 结题数量
//   node nsfc.mjs --complete --code G01 --year 2015 --type 青年
//   → itotalRecords = 189  ✅ 与答案 189 一致（选项 170/222/201/189）
//   （对照：面上项目 218 → 223，地区基金 631 → 23，G01+2015 全类别 → 440）
//
// 题②：清华大学 2023 结题、申请代码 E0805 的项目获评年度包括
//   node nsfc.mjs --complete --unit 清华大学 --code E0805 --year 2023
//   → 6 条，批准年度分布 = {2020: 3, 2019: 3}
//   → 获评年度 = 2019、2020 → 答案 CD ✅
//   （6 个项目：52008232/52008231/52008230 批准 2020；51978380/51978379/51978378 批准 2019）
// ============================================================

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36 Edg/154.0.0.0';
const BASE = 'https://kd.nsfc.cn';
const HDR = {
  'User-Agent': UA,
  'Content-Type': 'application/json;charset=UTF-8',
  'Origin': BASE,
  'Referer': BASE + '/finalProjectInit',
  'Accept': 'application/json, text/plain, */*',
};

// ---------------- 纯 JS DES（ECB / PKCS7） ----------------
const IP = [58, 50, 42, 34, 26, 18, 10, 2, 60, 52, 44, 36, 28, 20, 12, 4, 62, 54, 46, 38, 30, 22, 14, 6, 64, 56, 48, 40, 32, 24, 16, 8, 57, 49, 41, 33, 25, 17, 9, 1, 59, 51, 43, 35, 27, 19, 11, 3, 61, 53, 45, 37, 29, 21, 13, 5, 63, 55, 47, 39, 31, 23, 15, 7];
const FP = [40, 8, 48, 16, 56, 24, 64, 32, 39, 7, 47, 15, 55, 23, 63, 31, 38, 6, 46, 14, 54, 22, 62, 30, 37, 5, 45, 13, 53, 21, 61, 29, 36, 4, 44, 12, 52, 20, 60, 28, 35, 3, 43, 11, 51, 19, 59, 27, 34, 2, 42, 10, 50, 18, 58, 26, 33, 1, 41, 9, 49, 17, 57, 25];
const EB = [32, 1, 2, 3, 4, 5, 4, 5, 6, 7, 8, 9, 8, 9, 10, 11, 12, 13, 12, 13, 14, 15, 16, 17, 16, 17, 18, 19, 20, 21, 20, 21, 22, 23, 24, 25, 24, 25, 26, 27, 28, 29, 28, 29, 30, 31, 32, 1];
const PB = [16, 7, 20, 21, 29, 12, 28, 17, 1, 15, 23, 26, 5, 18, 31, 10, 2, 8, 24, 14, 32, 27, 3, 9, 19, 13, 30, 6, 22, 11, 4, 25];
const PC1 = [57, 49, 41, 33, 25, 17, 9, 1, 58, 50, 42, 34, 26, 18, 10, 2, 59, 51, 43, 35, 27, 19, 11, 3, 60, 52, 44, 36, 63, 55, 47, 39, 31, 23, 15, 7, 62, 54, 46, 38, 30, 22, 14, 6, 61, 53, 45, 37, 29, 21, 13, 5, 28, 20, 12, 4];
const PC2 = [14, 17, 11, 24, 1, 5, 3, 28, 15, 6, 21, 10, 23, 19, 12, 4, 26, 8, 16, 7, 27, 20, 13, 2, 41, 52, 31, 37, 47, 55, 30, 40, 51, 45, 33, 48, 44, 49, 39, 56, 34, 53, 46, 42, 50, 36, 29, 32];
const SH = [1, 1, 2, 2, 2, 2, 2, 2, 1, 2, 2, 2, 2, 2, 2, 1];
const SB = [
  [14, 4, 13, 1, 2, 15, 11, 8, 3, 10, 6, 12, 5, 9, 0, 7, 0, 15, 7, 4, 14, 2, 13, 1, 10, 6, 12, 11, 9, 5, 3, 8, 4, 1, 14, 8, 13, 6, 2, 11, 15, 12, 9, 7, 3, 10, 5, 0, 15, 12, 8, 2, 4, 9, 1, 7, 5, 11, 3, 14, 10, 0, 6, 13],
  [15, 1, 8, 14, 6, 11, 3, 4, 9, 7, 2, 13, 12, 0, 5, 10, 3, 13, 4, 7, 15, 2, 8, 14, 12, 0, 1, 10, 6, 9, 11, 5, 0, 14, 7, 11, 10, 4, 13, 1, 5, 8, 12, 6, 9, 3, 2, 15, 13, 8, 10, 1, 3, 15, 4, 2, 11, 6, 7, 12, 0, 5, 14, 9],
  [10, 0, 9, 14, 6, 3, 15, 5, 1, 13, 12, 7, 11, 4, 2, 8, 13, 7, 0, 9, 3, 4, 6, 10, 2, 8, 5, 14, 12, 11, 15, 1, 13, 6, 4, 9, 8, 15, 3, 0, 11, 1, 2, 12, 5, 10, 14, 7, 1, 10, 13, 0, 6, 9, 8, 7, 4, 15, 14, 3, 11, 5, 2, 12],
  [7, 13, 14, 3, 0, 6, 9, 10, 1, 2, 8, 5, 11, 12, 4, 15, 13, 8, 11, 5, 6, 15, 0, 3, 4, 7, 2, 12, 1, 10, 14, 9, 10, 6, 9, 0, 12, 11, 7, 13, 15, 1, 3, 14, 5, 2, 8, 4, 3, 15, 0, 6, 10, 1, 13, 8, 9, 4, 5, 11, 12, 7, 2, 14],
  [2, 12, 4, 1, 7, 10, 11, 6, 8, 5, 3, 15, 13, 0, 14, 9, 14, 11, 2, 12, 4, 7, 13, 1, 5, 0, 15, 10, 3, 9, 8, 6, 4, 2, 1, 11, 10, 13, 7, 8, 15, 9, 12, 5, 6, 3, 0, 14, 11, 8, 12, 7, 1, 14, 2, 13, 6, 15, 0, 9, 10, 4, 5, 3],
  [12, 1, 10, 15, 9, 2, 6, 8, 0, 13, 3, 4, 14, 7, 5, 11, 10, 15, 4, 2, 7, 12, 9, 5, 6, 1, 13, 14, 0, 11, 3, 8, 9, 14, 15, 5, 2, 8, 12, 3, 7, 0, 4, 10, 1, 13, 11, 6, 4, 3, 2, 12, 9, 5, 15, 10, 11, 14, 1, 7, 6, 0, 8, 13],
  [4, 11, 2, 14, 15, 0, 8, 13, 3, 12, 9, 7, 5, 10, 6, 1, 13, 0, 11, 7, 4, 9, 1, 10, 14, 3, 5, 12, 2, 15, 8, 6, 1, 4, 11, 13, 12, 3, 7, 14, 10, 15, 6, 8, 0, 5, 9, 2, 6, 11, 13, 8, 1, 4, 10, 7, 9, 5, 0, 15, 14, 2, 3, 12],
  [13, 2, 8, 4, 6, 15, 11, 1, 10, 9, 3, 14, 5, 0, 12, 7, 1, 15, 13, 8, 10, 3, 7, 4, 12, 5, 6, 11, 0, 14, 9, 2, 7, 11, 4, 1, 9, 12, 14, 2, 0, 6, 10, 13, 15, 3, 5, 8, 2, 1, 14, 7, 4, 10, 8, 13, 15, 12, 9, 0, 3, 5, 6, 11],
];
const toBits = (buf) => { const o = []; for (const b of buf) for (let i = 7; i >= 0; i--) o.push((b >> i) & 1); return o; };
const fromBits = (bits) => { const o = Buffer.alloc(bits.length / 8); for (let i = 0; i < o.length; i++) { let v = 0; for (let j = 0; j < 8; j++) v = (v << 1) | bits[i * 8 + j]; o[i] = v; } return o; };
const perm = (bits, t) => t.map((p) => bits[p - 1]);
function subKeys(keyBuf) {
  const k = perm(toBits(keyBuf), PC1);
  let C = k.slice(0, 28), D = k.slice(28);
  const out = [];
  for (let r = 0; r < 16; r++) {
    for (let s = 0; s < SH[r]; s++) { C.push(C.shift()); D.push(D.shift()); }
    out.push(perm(C.concat(D), PC2));
  }
  return out;
}
function feistel(R, K) {
  const x = perm(R, EB).map((v, i) => v ^ K[i]);
  const o = [];
  for (let i = 0; i < 8; i++) {
    const b = x.slice(i * 6, i * 6 + 6);
    const row = (b[0] << 1) | b[5];
    const col = (b[1] << 3) | (b[2] << 2) | (b[3] << 1) | b[4];
    const v = SB[i][row * 16 + col];
    o.push((v >> 3) & 1, (v >> 2) & 1, (v >> 1) & 1, v & 1);
  }
  return perm(o, PB);
}
function block(b8, keys) {
  const bits = perm(toBits(b8), IP);
  let L = bits.slice(0, 32), R = bits.slice(32);
  for (let i = 0; i < 16; i++) {
    const f = feistel(R, keys[i]);
    const nR = L.map((v, j) => v ^ f[j]);
    L = R; R = nR;
  }
  return fromBits(perm(R.concat(L), FP));
}
const DES_KEY = 'IFROMC86';
export function desDecrypt(b64, keyStr = DES_KEY) {
  const keys = subKeys(Buffer.from(keyStr, 'utf8')).reverse();
  const data = Buffer.from(b64, 'base64');
  const parts = [];
  for (let i = 0; i < data.length; i += 8) parts.push(block(data.subarray(i, i + 8), keys));
  let out = Buffer.concat(parts);
  const pad = out[out.length - 1];
  if (pad >= 1 && pad <= 8) out = out.subarray(0, out.length - pad);
  return out.toString('utf8');
}
export function desEncrypt(text, keyStr = DES_KEY) {
  const keys = subKeys(Buffer.from(keyStr, 'utf8'));
  let data = Buffer.from(text, 'utf8');
  const pad = 8 - (data.length % 8);
  data = Buffer.concat([data, Buffer.alloc(pad, pad)]);
  const parts = [];
  for (let i = 0; i < data.length; i += 8) parts.push(block(data.subarray(i, i + 8), keys));
  return Buffer.concat(parts).toString('base64');
}

// ---------------- HTTP ----------------
async function post(path, body) {
  const t0 = Date.now();
  const res = await fetch(BASE + path, {
    method: 'POST', headers: HDR,
    body: typeof body === 'string' ? body : JSON.stringify(body || {}),
  });
  const txt = await res.text();
  const ms = Date.now() - t0;
  let j = null;
  try { j = JSON.parse(txt); } catch { try { j = JSON.parse(desDecrypt(txt)); } catch { /* 非 JSON */ } }
  if (!j) throw new Error(`响应无法解析（HTTP ${res.status}）：${txt.slice(0, 120)}`);
  if (res.status !== 200) throw new Error(`HTTP ${res.status}: ${JSON.stringify(j).slice(0, 160)}`);
  return { json: j, ms };
}

// ---------------- 码表 ----------------
const TYPE_ALIAS = {
  '青年': '630', '青年科学基金': '630', '青年科学基金项目': '630', '青年基金': '630', '青基': '630', 'C类': '630',
  '面上': '218', '面上项目': '218',
  '地区': '631', '地区科学基金': '631', '地区科学基金项目': '631',
  '重点': '220', '重点项目': '220',
  '联合基金': '579', '重大研究计划': '339', '天元': '80', '数学天元': '80',
  '专项': '8531', '专项项目': '8531', '国际': '433', '国际合作': '433',
};
const TYPE_NAME = {
  630: '青年科学基金项目（C类）', 218: '面上项目', 631: '地区科学基金项目',
  220: '重点项目', 579: '联合基金项目', 339: '重大研究计划',
  80: '数学天元基金项目', 8531: '专项项目', 433: '国际(地区)合作与交流项目',
};

const argv = process.argv.slice(2);
const has = (f) => argv.includes('--' + f);
const opt = (f, d = null) => { const i = argv.indexOf('--' + f); return i >= 0 ? argv[i + 1] : d; };
const num = (v, d) => (v == null || v === '' || Number.isNaN(Number(v)) ? d : Number(v));

const BASE_PARAM = {
  code: '', fuzzyKeyword: '', complete: true, isFuzzySearch: false, conclusionYear: '',
  dependUnit: '', keywords: '', pageNum: 0, pageSize: 10, personInCharge: '', projectName: '',
  projectType: '', subPType: '', psPType: '', ratifyNo: '', ratifyYear: '', order: '',
  ordering: 'desc', codeScreening: '', dependUnitScreening: '', keywordsScreening: '',
  projectTypeNameScreening: '',
};

const HELP = `NSFC 大数据知识管理门户 CLI（kd.nsfc.cn）

用法: node nsfc.mjs [条件...] [选项]

条件:
  --complete            查结题项目（默认，免登录）
  --fund                查资助项目（⚠️ 需登录，本机不可用）
  --code  <代码>        申请代码，如 G01 / E0805 / H30
  --year  <年>          结题年度（--fund 时为批准年度）
  --unit  <依托单位>     如 清华大学
  --type  <类别>        青年|面上|地区|重点|联合基金|天元… 或数字码 630/218/631
  --name  <关键词>      项目名称
  --person <姓名>       负责人

选项:
  --page <N>  --size <N>   分页（默认 1 / 10）
  --top  <N>               列出前 N 条（默认 10）
  --json                   原始 JSON
  --detail <项目ID>        查单个结题项目详情
  --codes                  打印申请代码表
  --types                  打印资助类别码表

示例:
  node nsfc.mjs --complete --code G01 --year 2015 --type 青年
  node nsfc.mjs --complete --unit 清华大学 --code E0805 --year 2023 --top 10
  node nsfc.mjs --detail f6a20eddba2f056abcc45fd9dd696400`;

async function main() {
  if (has('help') || argv.length === 0) { console.log(HELP); process.exitCode = argv.length === 0 ? 1 : 0; return; }

  // ---- 码表 ----
  if (has('codes') || has('types')) {
    if (has('codes')) {
      const { json } = await post('/api/common/fieldCode', {});
      const list = json.data || [];
      console.log(`申请代码表（${list.length} 条，只显示 2 位学科代码 + 4/6 位代码前 60 条）`);
      for (const it of list.slice(0, 60)) console.log(`  ${it.code}\t${it.name}`);
      if (list.length > 60) console.log(`  …（共 ${list.length} 条）`);
    }
    if (has('types')) {
      const { json } = await post('/api/common/supportTypeClassOneData', {});
      console.log('\n资助类别（--type 可直接传数字码）:');
      for (const it of json.data || []) console.log(`  ${it.value}\t${it.name}`);
    }
    return;
  }

  // ---- 详情 ----
  const detailId = opt('detail');
  if (detailId) {
    const { json, ms } = await post('/api/baseQuery/conclusionProjectInfo/' + detailId, '');
    const d = json.data || {};
    console.log(`=== 结题项目详情（${ms}ms）===`);
    const kv = {
      '项目名称': d.projectName, '批准号': d.ratifyNo, '申请代码': d.code,
      '资助类别': TYPE_NAME[d.projectType] || d.projectType, '负责人': d.projectAdmin,
      '依托单位': d.dependUnit, '研究期限': d.researchTimeScope, '资助经费(万元)': d.supportNum,
    };
    for (const [k, v] of Object.entries(kv)) if (v != null && v !== '') console.log(`  ${k}: ${v}`);
    if (d.projectKeywordC) console.log(`  关键词: ${d.projectKeywordC}`);
    if (d.projectAbstractC) console.log(`\n【项目摘要】\n${d.projectAbstractC}`);
    if (d.conclusionAbstract) console.log(`\n【结题摘要】\n${String(d.conclusionAbstract).slice(0, 1500)}`);
    const rs = d.resultsList || [];
    if (rs.length) { console.log(`\n【成果 ${rs.length} 条】`); rs.slice(0, 10).forEach((r, i) => console.log(`  ${i + 1}. ${(r.result || []).slice(1, 4).join(' | ')}`)); }
    return;
  }

  if (has('fund')) {
    console.error('⚠️ 资助项目检索（/projectAnnounced、/fundingProjectInit）需要统一认证登录，');
    console.error('   未登录会被 302 到 /login。本机无账号，此功能不可用。');
    console.error('   可用替代：结题项目检索（--complete）免登录，数据量 62 万+。');
    process.exitCode = 3;
    return;
  }

  // ---- 结题项目 ----
  const typeRaw = opt('type');
  const projectType = typeRaw ? (TYPE_ALIAS[typeRaw] || typeRaw) : '';
  const p = {
    ...BASE_PARAM,
    code: opt('code', ''),
    conclusionYear: opt('year', ''),
    dependUnit: opt('unit', ''),
    projectName: opt('name', ''),
    personInCharge: opt('person', ''),
    keywords: opt('keywords', ''),
    projectType,
    pageNum: Math.max(0, num(opt('page'), 1) - 1),
    pageSize: num(opt('size'), 10),
  };

  if (!p.code && !p.conclusionYear && !p.dependUnit && !p.projectName && !p.personInCharge) {
    console.error('⚠️ 至少要给一个条件（--code / --year / --unit / --name / --person）。');
    console.error('   实测：全空参数服务端返回 500。');
    process.exitCode = 2;
    return;
  }

  const { json, ms } = await post('/api/baseQuery/completionQueryResultsData', p);
  if (json.code !== 200) throw new Error(`接口 code=${json.code} message=${json.message || ''}`);
  const d = json.data || {};
  const rows = d.resultsData || [];
  const total = d.itotalRecords ?? 0;

  const cond = [
    p.code && `申请代码 ${p.code}`,
    p.conclusionYear && `结题年度 ${p.conclusionYear}`,
    p.projectType && `资助类别 ${TYPE_NAME[p.projectType] || p.projectType}`,
    p.dependUnit && `依托单位 ${p.dependUnit}`,
    p.projectName && `项目名称 ${p.projectName}`,
    p.personInCharge && `负责人 ${p.personInCharge}`,
  ].filter(Boolean).join(' + ');

  console.log(`=== 结题项目检索（${ms}ms）===`);
  console.log(`条件: ${cond || '(无)'}`);
  console.log(`★ 命中总数: ${total}`);
  if (opt('json')) { console.log(JSON.stringify(json, null, 1)); return; }

  const top = num(opt('top'), 10);
  if (rows.length) {
    console.log('\n  批准号      类别                负责人   批准年  结题年  代码     项目名称');
    for (const r of rows.slice(0, top)) {
      console.log(`  ${String(r[2]).padEnd(11)} ${String(r[3] || '').slice(0, 18).padEnd(18)} ${String(r[5] || '').padEnd(8)} ${String(r[7] || '').padEnd(7)} ${String(r[15] || '').padEnd(7)} ${String(r[14] || '').padEnd(8)} ${String(r[1] || '').slice(0, 40)}`);
    }
    // 批准年度分布 —— "获评年度包括" 类题目直接看这个
    const years = {};
    for (const r of rows) years[r[7]] = (years[r[7]] || 0) + 1;
    const dist = Object.entries(years).sort((a, b) => b[1] - a[1]);
    if (dist.length) console.log(`\n  批准年度分布: ${dist.map(([y, n]) => `${y}年×${n}`).join('  ')}`);
    if (rows.length < total) console.log(`  （显示 ${rows.length} / ${total} 条，用 --size N 取更多）`);
  }
}

main().catch((e) => {
  console.error('错误:', String(e && e.message || e).slice(0, 400));
  process.exitCode = 1;
});
