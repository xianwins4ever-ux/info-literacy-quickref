// ============================================================
// 智慧树 CLI —— zhihuishu.mjs
//
// 用法:
//   node zhihuishu.mjs --golden                      # 首页"国家金课"轮播（按选课数降序）
//   node zhihuishu.mjs --top 20                      # 全库课程按选课学生数排序 Top N（题目①）
//   node zhihuishu.mjs --kw 中华国学                 # 按课程名搜（题目②）
//   node zhihuishu.mjs --course 1000006198           # 课程详情（学分/学时/选课人数/学校/教师）
//   node zhihuishu.mjs --catalog 1000006198          # 尝试取章节（⚠️ 未打通，见笔记）
//   node zhihuishu.mjs --self-test                   # 跑两道模拟题
//
// ── 逆向笔记 ────────────────────────────────────────────────
// 1. **全库课程列表接口（最有价值，一次拿 968 门）**：
//      GET https://official-web-search.zhihuishu.com/indexPageSearch/shareCourse
//        ?family=4&coursePackageId=-1&zhsmCourseCategory=-1&subjectFirstCode=-1
//        &schoolLevel=-1&orderRuler=-1&pageNo=0&pageSize=60
//        &zhsmCourseCategoryTag=-1&uuid=&dateFormate=<毫秒时间戳>
//    返回 { total: 968, rt: [ { courseId, courseName, schoolName, teacherName,
//             studentCount, superLevelName('国家级'/'省级'), hours, credit,
//             subjectFirstName, coursePackageName, courseTypeName } ] }
//    ⚠️ `dateFormate` 必传（随便一个毫秒时间戳即可，防缓存）。
//    ⚠️ `family=4` 是"大学共享课"；`zhsmCourseCategoryTag=4` 是"国家金课"筛选项
//       （对应 2clearning.html#/courseResource?type=1&courseTagDtos=4 的 URL 参数）。
//    ⚠️ **排序不要信 orderRuler 参数**，本地按 studentCount 降序排最稳。
//    ⚠️ 该域名**偶发连接超时**（ConnectTimeout），必须带重试（本脚本 4 次退避）。
//
// 2. **首页"国家金课"轮播**走另一个接口：
//      POST https://precourseservice-api.zhihuishu.com/gateway/f/v1/api/course/queryList/2
//      body: lastCourseIds=<逗号分隔的已展示id>     （"换一换"就靠这个翻）
//    返回 { code:0, data:[ {courseId, courseName, schoolName, teacherName, studentCount, linkUrl} ] }
//    只有 11 条，是精选轮播，**不是**全库排行。
//
// 3. **课程详情**：`https://coursehome.zhihuishu.com/courseHome/<courseId>`
//    服务端渲染 HTML（70KB），`<script>` 里内联了：
//        var courseId=1000006198; var recruitId=473250; var termId=26; ...
//    ⚠️ `https://www.zhihuishu.com/portals_h5/2clearning.html#/courseInfo/<id>` 会 302 到 404，
//       正确详情页是 coursehome 子域。
//    页面正文含：学分/学时/见面课/教师/学校/参考教材/开课学期数/累计选课人数/选课学校数。
//
// 4. ⚠️⚠️ **章节（课程大纲）未打通**。已定位但拿不到：
//      · 章节由 `coursehome.zhihuishu.com/home/communication/content/<courseId><recruitId>/<termId>?ft=`
//        返回 HTML 片段（sectionstructure/content.js 里第 550 行）
//      · 直接请求报 **HTTP 500 NumberFormatException: For input string: "content"**
//        （拦截器把路径段当 Long 解析，说明路由不是这个字面形式，或需 JSESSIONID 会话）
//      · 备选 `b2cpush.zhihuishu.com/b2cpush/courseDetail/query2CCourseCatalog`
//        （POST courseId=&studyMode=1）→ 返回 **`{}` 空对象**，未登录拿不到目录
//      · 页面内 fetch 同样 `{}`；coursehome 页面 HTML 里也不含"老子/庄子/儒家"字样
//      ⇒ 题目②"中华国学 11 章哪些是章节主题"**无法用脚本验证**。
//        人工兜底：开 https://coursehome.zhihuishu.com/courseHome/1000006198
//        点"课程大纲"标签页看章节名。
//
// 5. 编码 UTF-8，无 WAF、无登录要求（列表/详情公开）。
//
// ── 模拟题实测（node zhihuishu.mjs --self-test）──────────────
//   题① 国家金课选课学生最多的课程（答案 B：军事理论-综合版）
//       实测 Top1 = 军事理论-综合版 | 国防大学、北京大学…跨校共建 | 14,629,073 人
//       → ✅ 与答案 B 一致（第2名 形势与政策 13,208,028）
//   题② 国家级金课"中华国学"（南开大学 张荣明）11 章，哪些是章节主题（答案 ACD）
//       实测：课程存在 ✅ courseId=1000006198，南开大学，张荣明，617,686 人，38 学时
//             章节 ❌ 未取到（见笔记 4）
// ============================================================

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36 Edg/154.0.0.0';
const LIST_API = 'https://official-web-search.zhihuishu.com/indexPageSearch/shareCourse';
const SEARCH_API = 'https://official-web-search.zhihuishu.com/indexPageSearch/search';
const GOLDEN_API = 'https://precourseservice-api.zhihuishu.com/gateway/f/v1/api/course/queryList/2';
const HOME = 'https://coursehome.zhihuishu.com/courseHome';

class Exit extends Error { constructor(c) { super('exit'); this.code = c; } }
const done = (code = 0) => { throw new Exit(code); };
const argv = process.argv.slice(2);
const has = (f) => argv.includes('--' + f);
const opt = (f, d = null) => { const i = argv.indexOf('--' + f); return i >= 0 ? argv[i + 1] : d; };

async function req(url, init = {}, tries = 4) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, {
        ...init,
        headers: {
          'User-Agent': UA,
          'Accept': 'application/json, text/plain, */*',
          'Accept-Language': 'zh-CN,zh;q=0.9',
          'Origin': 'https://www.zhihuishu.com',
          'Referer': 'https://www.zhihuishu.com/',
          ...(init.headers || {}),
        },
        redirect: 'follow',
      });
      const buf = Buffer.from(await r.arrayBuffer());
      return { status: r.status, text: new TextDecoder('utf-8').decode(buf), bytes: buf.length };
    } catch (e) {
      last = e;
      await new Promise((s) => setTimeout(s, 1200 * (i + 1)));
    }
  }
  throw last;
}

async function allCourses(size = 60) {
  const q = new URLSearchParams({
    family: '4', coursePackageId: '-1', zhsmCourseCategory: '-1', subjectFirstCode: '-1',
    schoolLevel: '-1', orderRuler: '-1', pageNo: '0', pageSize: String(size),
    zhsmCourseCategoryTag: '-1', uuid: '', dateFormate: String(Date.now()),
  });
  const { status, text } = await req(`${LIST_API}?${q}`);
  if (status !== 200) throw new Error(`列表接口 HTTP ${status}`);
  const j = JSON.parse(text);
  const list = j.rt || [];
  list.sort((a, b) => (b.studentCount || 0) - (a.studentCount || 0));
  return { total: j.total || list.length, list };
}

const fmt = (n) => Number(n || 0).toLocaleString('en-US');

async function top(n) {
  const { total, list } = await allCourses(Math.max(60, n));
  console.log(`\n=== 智慧树 全库课程按选课学生数排序 ===`);
  console.log(`接口共 ${total} 门，本页 ${list.length} 门（已本地降序）`);
  list.slice(0, n).forEach((c, i) => {
    console.log(`${String(i + 1).padStart(2)}. ${c.courseName}  [${c.superLevelName || '-'}]`);
    console.log(`      ${c.schoolName} | ${c.teacherName}`);
    console.log(`      选课 ${fmt(c.studentCount)} 人 | ${c.hours || '?'} 学时 | ${c.credit || '?'} 学分 | id=${c.courseId}`);
  });
  return list;
}

async function golden() {
  const { status, text } = await req(GOLDEN_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'lastCourseIds=',
  });
  if (status !== 200) throw new Error(`金课接口 HTTP ${status}`);
  const j = JSON.parse(text);
  const list = (j.data || []).slice().sort((a, b) => (b.studentCount || 0) - (a.studentCount || 0));
  console.log(`\n=== 首页「国家金课」轮播（code=${j.code}，${list.length} 条） ===`);
  list.forEach((c, i) => {
    console.log(`${String(i + 1).padStart(2)}. ${c.courseName}`);
    console.log(`      ${c.schoolName || ''} | ${c.teacherName || ''} | 选课 ${fmt(c.studentCount)} 人 | id=${c.courseId}`);
  });
  return list;
}

async function kwSearch(kw) {
  // ⚠️ /indexPageSearch/search?keyword= 返回结构与 shareCourse 不同（字段名不一致，
  //    直接取 courseName/courseId 会得到 undefined），故仍走 shareCourse 拉一页再本地过滤。
  //    ⚠️ pageSize 不要超过 60，超过会 HTTP 503 限流。
  const { total, list } = await allCourses(60);
  const hit = list.filter((c) => String(c.courseName).includes(kw) || String(c.teacherName).includes(kw));
  console.log(`\n=== 课程搜索「${kw}」（本地匹配 ${list.length}/${total} 门） ===`);
  if (!hit.length) console.log('(无匹配；可加大 --size 或换关键词)');
  hit.forEach((c, i) => {
    console.log(`${String(i + 1).padStart(2)}. ${c.courseName}  [${c.superLevelName || '-'}]`);
    console.log(`      ${c.schoolName} | ${c.teacherName} | 选课 ${fmt(c.studentCount)} 人 | id=${c.courseId}`);
    console.log(`      详情: ${HOME}/${c.courseId}`);
  });
  return hit;
}

async function course(courseId) {
  const { status, text, bytes } = await req(`${HOME}/${courseId}`);
  console.log(`\n=== 课程详情 ${courseId} ===`);
  console.log(`HTTP ${status} | ${bytes} 字节`);
  if (status !== 200) return null;
  const pick = (re) => { const m = text.match(re); return m ? m[1].trim() : null; };
  const info = {
    courseId: pick(/var\s+courseId\s*=\s*(\d+)/),
    recruitId: pick(/var\s+recruitId\s*=\s*(\d+)/),
    termId: pick(/var\s+termId\s*=\s*(\d+)/),
    title: pick(/<title>([\s\S]*?)<\/title>/),
  };
  console.log(`courseId=${info.courseId}  recruitId=${info.recruitId}  termId=${info.termId}`);
  console.log(`标题: ${String(info.title || '').replace(/<[^>]+>/g, '').trim()}`);
  // 正文关键字段（学分/学时/选课人数…）
  const body = text.replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, '\n')
    .split('\n').map((s) => s.replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim())
    .filter((s) => s && s.length < 120);
  const want = ['学分', '学时', '见面课', '教师', '学校', '累计选课', '选课学校', 'ISBN', '出版社'];
  console.log('--- 关键字段 ---');
  body.forEach((line, i) => {
    if (want.some((w) => line === w) || /^[\d.,]+\s*(人|次|所|学期|月)?$/.test(line) || /张荣明|南开大学|中华国学/.test(line)) {
      const next = body[i + 1] && body[i + 1] !== line ? '  →  ' + body[i + 1] : '';
      if (next) console.log(`  ${line}${next}`);
    }
  });
  return info;
}

// ⚠️ 章节接口已知拿不到，这里做一次诚实尝试并给出结论
async function catalog(courseId) {
  const c = await course(courseId);
  if (!c || !c.recruitId || !c.termId) { console.log('\n(无法确定 recruitId/termId，跳过)'); return null; }
  const url = `https://coursehome.zhihuishu.com/home/communication/content/${c.courseId}${c.recruitId}/${c.termId}?ft=`;
  console.log(`\n--- 尝试章节接口 ---\n${url}`);
  const r = await req(url, { headers: { Referer: `${HOME}/${courseId}` } }, 2).catch((e) => ({ status: 0, text: String(e.message) }));
  console.log(`HTTP ${r.status} | ${r.text.length} 字符`);
  if (r.status === 200 && /第一章|第1章|绪论/.test(r.text)) {
    const chapters = [...r.text.matchAll(/class="[^"]*(?:section|chapter)[^"]*"[^>]*>([^<]{2,60})</gi)].map((m) => m[1].trim());
    const uniq = [...new Set(chapters)].filter((x) => x.length > 1);
    console.log('章节:');
    uniq.slice(0, 40).forEach((x, i) => console.log(`  ${i + 1}. ${x}`));
    return uniq;
  }
  console.log(`⚠️ 章节未打通：${r.status === 500 ? 'HTTP 500（拦截器 NumberFormatException，路由字面量不对/需会话）' : '返回非章节内容'}`);
  console.log('   人工兜底：浏览器打开 ' + `${HOME}/${courseId}` + ' → 点「课程大纲」标签页');
  return null;
}

async function selfTest() {
  const t0 = Date.now();
  console.log('########## 模拟题①：国家金课选课学生最多的课程（答案 B 军事理论-综合版）##########');
  const list = await top(5);
  const first = list[0];
  const ok1 = !!first && String(first.courseName).includes('军事理论');
  console.log(`\n[判定] Top1 = ${first ? first.courseName : '?'}`);
  console.log(`[判定] ${ok1 ? '✅ 与答案 B 一致' : '❌ 与答案不符'}`);

  console.log('\n########## 模拟题②：国家级金课「中华国学」（南开大学 张荣明）##########');
  const hit = await kwSearch('中华国学');
  const c = hit[0];
  const ok2 = !!c && String(c.schoolName).includes('南开') && String(c.teacherName).includes('张荣明');
  console.log(`\n[判定] 课程存在: ${ok2 ? '✅ 南开大学 / 张荣明 / 国家级' : '❌'}`);
  const ch = c ? await catalog(c.courseId) : null;
  console.log(`[判定] 章节: ${ch ? '✅ 已取到 ' + ch.length + ' 条' : '❌ 未打通（答案 ACD 无法验证）'}`);
  console.log(`\n耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  return ok1 && ok2 && !!ch;
}

async function main() {
  if (has('self-test')) { await selfTest(); return; }
  if (has('golden')) { await golden(); return; }
  if (has('course')) { await course(opt('course')); return; }
  if (has('catalog')) { await catalog(opt('catalog')); return; }
  if (has('kw')) { await kwSearch(opt('kw')); return; }
  if (has('top')) { await top(Number(opt('top', '10'))); return; }
  console.log(`智慧树 CLI

用法:
  node zhihuishu.mjs --top 20             # 全库按选课学生数排序
  node zhihuishu.mjs --golden             # 首页国家金课轮播
  node zhihuishu.mjs --kw 中华国学        # 课程搜索
  node zhihuishu.mjs --course <id>        # 课程详情
  node zhihuishu.mjs --catalog <id>       # 章节（⚠️ 已知未打通）
  node zhihuishu.mjs --self-test`);
  done(1);
}

main().catch((e) => {
  if (e instanceof Exit) { process.exitCode = e.code; return; }
  console.error('ERROR:', String(e && e.message || e).slice(0, 300));
  process.exitCode = 1;
});
