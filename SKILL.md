---
name: info-literacy-contest
description: >
  互联网信息素养大赛（信息检索竞赛）的检索作战包：26 个已逆向打通的 CLI，覆盖知网、万方、维普、
  PubMed/NCBI、国家图书馆（民国图书 + 中华古籍）、国家标准、国家统计局（含分省）、专利/药监、
  法院被执行人、国家自然科学基金、证券业协会、研招网、百度学术、辟谣平台、共产党员网、庭审公开网、
  智慧树、UNESCO、福建/重庆大学图书馆等 40+ 站点的直接取数。
  当用户：贴出一道检索类题目要答案、说"信息素养大赛/检索比赛/省赛/模拟题"、
  要求查知网/万方/维普/PubMed/国图/古籍/统计局/国标/专利/基金/证券从业/研招网、
  问"这个网站怎么查""帮我找这篇文献""这本书有几册""某年某指标是多少"、
  或需要在 30 秒内从中文数据库里取一个具体数字/字段时，立即使用本 skill。
  不要用浏览器手工点：本 skill 的脚本已绕过各站反爬（滑块/瑞数/阿里云验证码/JS 挑战/reCAPTCHA），
  一条命令直接出答案字段。
---

# 信息素养大赛检索作战包

**目标：每题 30 秒内出答案。** 这里没有"探索网站"的余地——每个站点都已被逆向成一条命令。

## 0. 开工前 30 秒（唯一必做）

```bash
node doctor.mjs          # 全绿才能开赛
node doctor.mjs --net    # 加网络连通性（约 30 秒）
```

`doctor` 检查的是 **skill 打包不了的东西**：playwright-core 路径、各站点持久化 profile（登录态/放行 cookie）、网络可达性。它报红就是真跑不了，别硬试。

---

## 1. 拿到题目后：先查这张表

| 题目里出现 | 命令 |
|---|---|
| 知网 / CNKI / 篇名+主题 / 被引最多 | `node scripts/cnki.mjs --ti "..." --su "..." --from 2020 --to 2024 --db journal` |
| 知网 / **发文量最多的作者或单位** | `node scripts/cnki.mjs --su "..." --facet author`（或 `--facet institution`） |
| **知网 / 某篇的 DOI、作者单位、基金、年卷期、页码、引用格式** | `node scripts/cnki.mjs --ti "篇名" --top 1 --detail` |
| 万方 / 会议文献 / 期刊条数 | `node scripts/wf.mjs '会议名称:"xxx"'` |
| **万方 / 某篇的在线出版日期、分类号、DOI、ISSN、引用格式** | `node scripts/wf.mjs '题名:("篇名")' --type thesis --detail` |
| 维普 / 检索式语义 / 逻辑运算符 | `node scripts/vp.mjs 'K=(5G * 通信) + (物联网 * 应用) - 军事'` |
| **维普 / 某篇的机构、基金、分类号、引用格式** | `node scripts/vp.mjs 'K=关键词' --top 1 --detail` |
| PubMed / 文献数量 / Clinical Trial | `node scripts/pubmed.mjs "CRISPR[Title/Abstract] NOT therapy[Title]" --from 2017 --to 2024 --type clinicaltrial` |
| **NCBI 电子书 → 出版社** | `node scripts/pubmed.mjs --bookshelf "书名"` |
| 民国图书 / 载体形态（页数）/ 出版地 / 中图分类 / 索书号 | `node scripts/nlc.mjs "雷雨" --filter 曹禺` |
| **古籍 / 有几册 / 版本项 / 善本书号 / 四部分类号** | `node scripts/nlc_guji.mjs "书名"`（`--filter` 会作用于详情） |
| 国标 / 发布实施日期 / CCS / ICS | `node scripts/std.mjs "GB/T 5750.1-2023"` |
| 统计局 / 某年某指标 | `node scripts/nbs.mjs "指标名" --year 2018` |
| 统计局 / **某省**某指标 | `node scripts/nbs.mjs "指标名" --year 2023 --prov 河南` |
| 被执行人 / 执行标的金额 | `node scripts/zxgk.mjs "公司名"` |
| 药监 / 注册证 → 产品名 | `node scripts/nmpa.mjs "国械注准20163401733"` |
| 国家自然科学基金 / 结题项目 | `node scripts/nsfc.mjs --complete --code G01 --year 2015 --type 青年` |
| 证券业协会 / 登记编号 / 注册地 | `node scripts/sac.mjs --person 刘焕章` ／ `--region 深圳` |
| 研招网 / 院校库 / 某省某类主管 | `node scripts/yz.mjs --prov 甘肃 --dept min` |
| 百度学术 / 期刊 H 指数 | `node scripts/bdxs.mjs --journal "中国图书馆学报"` |
| 福建省图书馆 / 索书号 | `node scripts/fjlib.mjs --title "书名"` |
| 重庆大学图书馆 / 馆藏地 / 复本 | `node scripts/cqulib.mjs --title "书名"` |
| 辟谣平台 / 访谈 / 表单限制 | `node scripts/piyao.mjs --ft --date 2023-12-15` ／ `--form` |
| 共产党员网 / 先进典型 | `node scripts/12371.mjs --title 张桂梅` |
| 庭审公开网 / 案号 | `node scripts/tingshen.mjs --no "川1703民初3924号"` |
| 智慧树 / 国家金课排序 | `node scripts/zhihuishu.mjs --top 20` |
| 国家哲社文献中心 / 核心分类 | `node scripts/ncpssd.mjs --core CSSCI` |
| UNESCO / PDF 第 N 页 | `node scripts/unesdoc.mjs --text pf0000393559 --page 12` |
| **上面都没有** | `node scripts/webq.mjs "<URL>" --grep "关键词" --ctx 3` |

**万能兜底**：`webq.mjs` 能抓任意网页（自动 GBK/UTF-8 嗅探）。返回字节数 < 3KB 说明是 SPA 壳，抓不到数据，改用专用脚本或浏览器。

---

## 2. 八个会直接答错的坑

**① 知网引号必须英文半角**
半角 `("AI" + "人工智能")` → 2365；全角 `（“AI” + “人工智能”）` → 1870。差一千多条。

**② 知网「或」必须写在括号里，不能拆成独立行**
行间只有 AND/OR 下拉、没有括号。混用会按 AND 优先错误结合：
```
篇名 AI OR 篇名 人工智能 AND 主题 法律 OR 主题 法规
→ 实际 = AI OR (人工智能 AND 法律) OR 法规    ← 错
```
正确：`篇名 ("AI"+"人工智能") AND 主题 ("法律"+"法规")`

**③ 知网分面只有前 3 个默认加载**
11 个分组里作者/机构/年度/文献来源等 8 个必须点 dt 标题才 AJAX 拉取。脚本已自动展开（看 `[facet] 展开:` 提示）。

**④ 万方时间字段是「发表时间」，不是「出版时间」**
`发表时间:(2010-2024)` ✅ ／ `出版时间:(2010-2024)` ❌ 完全无效

**⑤ 「机构」分面 ≠「学位授予单位」**
知网机构分面统计的是**作者单位**。问"哪个学校授予的学位论文最多"时两者有偏差。

**⑥ 知网的库计数用「万」单位（已修）**
页面原文是 `总库 44.21万 / 学术期刊 19.62万`。如果脚本只抓整数就会得到 44 / 19，
**所有超过 1 万的计数全错**，而且看起来像真的。脚本已支持小数+万/亿换算。

**⑦ 知网点库标签切库不生效（已修）**
点顶部「学术期刊」后，结果行第 1 条仍可能是报纸。`--db` 已改为**客户端按类型过滤**，
不点 UI，不会破坏计数。

**⑧ 维普会间歇性 412**
`qikan.cqvip.com` 是 **IP 级临时封锁**（同一时刻 `www.cqvip.com` 正常）。
脚本会明确报出并给替代源。**不要连续重试**（会延长封锁）。等 10~60 分钟或换网络。

---

## 3. 已知不可用（别浪费时间）

| 站点 | 状态 |
|---|---|
| **IEEE Xplore** | 418 全站 IP 级封锁，连主页都打不开 |
| **Google 全站**（含 patents.google.com） | 本机网络超时 |
| **CNIPA 专利** | 412 强反爬 |
| **USPTO** | WAF 挑战，PatentsView 已迁移 |
| **国家社科基金** `fz.people.com.cn` | 加速乐 WAF 按 IP 段拦截，浏览器也 403 |
| **NCBI Bookshelf 网页** | reCAPTCHA（浏览器也过不去）→ 用 `pubmed.mjs --bookshelf`（走 E-utilities） |
| **维普** | ⚠️ 间歇 412（IP 级临时封锁，10~60 分钟自愈）。脚本会报出并给替代源 |
| **MIT DSpace** | ⚠️ 间歇 429（频率限制，等 1~5 分钟） |
| 万方标准库 / 维普标准库 | SPA，未打通 |
| smartedu 章节 / zhihuishu 章节 | 需登录 token |
| 微信指数 / QQ 截图 / 雨课堂 / Zotero | 桌面软件或小程序，人工更快 |

---

## 4. 拿不到精确数时怎么办

- **题目问"最接近"**：脚本给的是当前库内数，与出题时点会有增量差（实测差 4 条属正常）。
- **四个选项都超过阈值**：优先排除**数量最小**的那个。
- **脚本报"无记录"**：先怀疑被拦截，不是真没有。看 stderr 有没有 `[fallback]` / `412` / `/verify` / `429`。
- **维普 412 / MIT 429**：是限流不是坏了，换源或等几分钟，**别连续重试**。
- **30 秒到了还没出来**：直接选最像的，别恋战。慢脚本（cnki/vp 25~40s）要一开始就跑。

---

## 5. 详细资料（按需读，不要一次全读）

| 文件 | 内容 |
|---|---|
| **`references/capabilities.md`** | **能力全景表：每个脚本到底能查哪些字段（含三库字段级对比）** |
| `references/cheatsheet.md` | 26 个脚本完整对照 + 耗时 + 状态 |
| `references/pitfalls.md` | 各站反爬细节、环境铁律、失败处理 |
| `references/answers.md` | 150 道模拟题答案速查 |
| `references/reverse-notes.md` | 各站点 API 路径与逆向过程（改版时看这个修） |

各脚本**头部注释**都有完整逆向笔记（接口路径、参数、踩过的坑）——修脚本时先读那里。

---

## 6. 改版了怎么修（最重要的一条）

网站改版是常态。修之前先看脚本头部注释里的接口定义，然后：

```bash
# 1. 用 webq 看现在的页面结构
node scripts/webq.mjs "<目标URL>" --raw | head -100

# 2. 用浏览器抓真实 XHR（改脚本时照抄 cnki.mjs 的写法）
#    关键点：launchPersistentContext + channel:'msedge' + --disable-blink-features=AutomationControlled

# 3. 改完必须用一道真题回测，对不上不算修好
```

**反爬配置不可盲目统一**（实测各站策略相反）：
- NMPA：只用 `--disable-blink-features=AutomationControlled`，**不要** addInitScript 改 webdriver（会被识破）
- 万方：**需要** addInitScript 兜一层 + 拟人拖动
- 维普：UA 与 stealth 必须**同时**给
- 国图古籍：检索要浏览器（Vue 异步渲染），详情可纯 HTTP

---

## 7. 交付纪律

1. **先给答案，附可信度**，不要长篇解释过程。
2. **不做双重验证**（除非两个来源矛盾）——验证是科研习惯，不是比赛习惯。
3. **报"查无此 X"之前，先确认脚本没报请求失败。**
4. 每次修脚本/发现新坑，**写回脚本头部注释 + references**，否则下次白干。
