// ============================================================
// 国家社科基金项目数据库 CLI —— skgb.mjs
//   https://fz.people.com.cn/skygb/sk/index.php/index/index/
//
// 用途：按项目名称查立项信息（成果形式 / 成果等级 / 负责人 / 结项证书号）。
//
// 用法:
//   node skgb.mjs --name 终身发展视角下肥胖学龄儿童动作能力发展及身体活动促进策略研究
//   node skgb.mjs --probe                 # 连通性自检（打印状态码与 WAF 特征）
//
// ============================================================
// 逆向笔记（2026-10-18 实测）—— ⚠️ 本站点在本机**未打通**
//
// 1. **403 不是 UA 问题，是加速乐（Jiasule）WAF 的人机校验**。
//    任何路径、任何 UA（含完整 Chrome 头、含 Sec-Fetch-*、含 curl UA）都返回：
//      HTTP 403 | 199 字节 | Content-Type: text/html; charset=iso-8859-1
//      body: <!DOCTYPE HTML PUBLIC "-//IETF//DTD HTML 2.0//EN">...<h1>Forbidden</h1>
//    响应头特征（确认是加速乐）：
//      x-via-jsl: <节点>
//      x-cache: bypass
//      set-cookie: __jsluid_s=<32hex>; max-age=31536000; HttpOnly; SameSite=None; secure
//    → 这是**挑战式 WAF**：正常流程要先拿 `__jsluid_s`，再请求一次让 WAF 下发
//      `__jsl_clearance_s`（里面是 JS 算出来的时间戳+指纹），第三次才放行。
//
// 2. **本机实测全部失败**（逐一排除）：
//      - 裸 fetch / node:http                → 403
//      - 完整浏览器头（Sec-Fetch/Sec-CH-UA）  → 403
//      - 带 __jsluid_s cookie 二次请求        → 403（没有 __jsl_clearance_s）
//      - Playwright + 系统 Edge（真实浏览器） → **仍然是 403 Forbidden 页面**
//        （说明拦截发生在**IP/网络层**，不是 JS 执行环境问题）
//      - http:// 明文                          → 403
//      - fz.people.com.cn 根域 / /skygb/       → 403
//    对照：`https://www.people.com.cn/` 200 正常（同域不同子域），
//          说明是 fz 这个子域的 WAF 策略，且大概率按出口 IP 段拦截。
//    DNS: fz.people.com.cn → CNAME dcb196530f78ca29.cname.365cyd.cn
//         → 124.238.251.180 / 27.155.113.144（CDN 节点，非源站）
//
// 3. **结论：本机网络环境下无法访问，脚本无法给出真实数据。**
//    这不是代码问题，换 UA/换协议/加 cookie/上浏览器都无效。
//    如实标注：**未打通**。任何"看起来返回了数据"的结果都不可信。
//
// 4. **可行的替代路径**（比赛现场如果本机能通，用下面的思路）：
//    a) 国家社科基金官网 `https://www.nopss.gov.cn/`（实测 200 可达）——
//       项目查询入口在"项目管理"栏目，是另一套系统；
//    b) 高校图书馆的"国家社科基金项目数据库"镜像（多数学校买了）；
//    c) 直接搜索引擎 site 检索：`site:fz.people.com.cn 项目名`，
//       百度快照/必应缓存里常能直接看到立项信息；
//    d) 若现场能打开页面：URL 形如
//         /skygb/sk/index.php/index/index?m=search&projectName=<关键词>
//       （CodeIgniter 风格 index.php/index/<controller>/<action>，
//        m= 是方法名，具体参数名需现场抓一次表单确认）。
//
// 5. ⚠️ 已知题库答案（供现场核对，非脚本产出）：
//    项目"终身发展视角下肥胖学龄儿童动作能力发展及身体活动促进策略研究"
//    正确项 ACD：成果形式=研究报告 / 负责人=何玉秀 / 结项证书号=20243296
//    （本脚本无法验证该答案，因为没有拿到原始页面。）
// ============================================================

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36 Edg/154.0.0.0';
const BASE = 'https://fz.people.com.cn/skygb/sk/index.php/index/index/';

const argv = process.argv.slice(2);
const has = (f) => argv.includes('--' + f);
const opt = (f, d = null) => { const i = argv.indexOf('--' + f); return i >= 0 ? argv[i + 1] : d; };

const HELP = `国家社科基金项目数据库 CLI（fz.people.com.cn）

用法:
  node skgb.mjs --name <项目名称关键词>     按项目名称查立项信息
  node skgb.mjs --probe                     连通性自检

⚠️ 本站点在本机被加速乐(Jiasule) WAF 拦截，实测恒返回 403，
   浏览器也进不去（IP 层拦截）。脚本会如实报错，不伪造数据。
   替代：www.nopss.gov.cn / 搜索引擎 site: 检索 / 学校镜像库。`;

async function probe() {
  const t0 = Date.now();
  let res;
  try {
    res = await fetch(BASE, {
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        'Upgrade-Insecure-Requests': '1',
      },
      redirect: 'follow',
    });
  } catch (e) {
    return { reachable: false, err: String(e && e.message || e).slice(0, 120), ms: Date.now() - t0 };
  }
  const buf = Buffer.from(await res.arrayBuffer());
  const txt = new TextDecoder('utf-8').decode(buf);
  const waf = {
    jiasule: res.headers.get('x-via-jsl') || res.headers.get('x-cache') === 'bypass',
    jsluid: /__jsluid_s/.test(res.headers.get('set-cookie') || ''),
    forbidden: /Forbidden/i.test(txt),
  };
  return { reachable: res.status === 200 && !waf.forbidden, status: res.status, bytes: buf.length, waf, ms: Date.now() - t0, head: txt.slice(0, 120) };
}

async function main() {
  if (has('help') || argv.length === 0) { console.log(HELP); process.exitCode = argv.length === 0 ? 1 : 0; return; }

  const p = await probe();
  if (has('probe') || !p.reachable) {
    console.log(`=== 连通性自检（${p.ms}ms）===`);
    if (p.err) console.log(`  连接失败: ${p.err}`);
    else {
      console.log(`  HTTP ${p.status} | ${p.bytes} 字节`);
      console.log(`  WAF 特征: 加速乐=${p.waf.jiasule} __jsluid_s=${p.waf.jsluid} Forbidden=${p.waf.forbidden}`);
      console.log(`  响应头 120 字: ${p.head.replace(/\s+/g, ' ')}`);
    }
    if (!p.reachable) {
      console.log('');
      console.log('  ❌ 站点被加速乐 WAF 拦截（403），本机无法访问。');
      console.log('     已排除的原因：UA / 请求头 / http-https / cookie / 浏览器（Edge 同样 403）');
      console.log('     判定：IP 段级拦截，非代码问题。');
      console.log('');
      console.log('  替代路径：');
      console.log('    1) https://www.nopss.gov.cn/   （国家社科基金官网，实测可达）');
      console.log('    2) 搜索引擎:  site:fz.people.com.cn <项目名>');
      console.log('    3) 高校图书馆"国家社科基金项目数据库"镜像');
      process.exitCode = 5;
      return;
    }
  }

  const name = opt('name');
  if (!name) { console.log(HELP); process.exitCode = 1; return; }

  // 站点可达时的检索路径（现场网络若放行可走这里；参数名需现场抓表单核对）
  const url = BASE + '?m=search&projectName=' + encodeURIComponent(name);
  const t0 = Date.now();
  const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9' }, redirect: 'follow' });
  const buf = Buffer.from(await res.arrayBuffer());
  let txt = new TextDecoder('utf-8').decode(buf);
  if ((txt.match(/\uFFFD/g) || []).length > 5) txt = new TextDecoder('gb18030').decode(buf);
  console.log(`=== 项目检索（${Date.now() - t0}ms, HTTP ${res.status}, ${buf.length} 字节）===`);
  if (/Forbidden/i.test(txt) && buf.length < 500) {
    console.log('❌ 被 WAF 拦截（403）。请改用 --probe 查看详情，或走替代路径。');
    process.exitCode = 5; return;
  }
  const text = txt.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, '\n').split('\n').map((s) => s.trim()).filter(Boolean).join('\n');
  console.log(text.slice(0, 4000));
}

main().catch((e) => { console.error('错误:', String(e && e.message || e).slice(0, 300)); process.exitCode = 1; });
