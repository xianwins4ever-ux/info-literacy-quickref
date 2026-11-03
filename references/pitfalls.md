# 各站反爬细节与环境铁律

> 这份文件是"踩过的坑"总集。修脚本、排查失败时看这里。
> 每个脚本头部注释还有更细的逆向过程。

---

## 一、反爬配置**不可盲目统一**（实测各站策略相反）

这是最容易犯的错：看到某站要 stealth，就给所有站都加。实测四个站策略不同：

| 站点 | `--disable-blink-features=AutomationControlled` | `addInitScript` 改 webdriver | 原因 |
|---|---|---|---|
| **NMPA 药监局** | ✅ 必须 | ❌ **禁止** | 属性存在但值为 `undefined` 是异常特征，WAF 一眼识破 |
| **万方** | ✅ 必须 | ✅ **需要** | 阿里云滑块会检查，需要兜一层 |
| **维普** | ✅ 必须 | — | UA 与 stealth 必须**同时**给，单给一个仍 412 |
| **知网** | ✅ 必须 | ✅ 需要 | blockPuzzle 滑块 |
| **国图古籍** | ✅ 必须 | — | Vue 异步渲染，必须真浏览器 |

**NMPA 的三组对照实测**（同一请求，只改浏览器配置）：

| 配置 | `navigator.webdriver` | 结果 |
|---|---|---|
| 无 stealth | `true` | ❌ 400 |
| stealth + addInitScript 改成 `undefined` | `undefined` | ❌ 400 |
| **仅 stealth 参数** | `false` | ✅ **200** |

---

## 二、滑块类验证码

### 2.1 阿里云滑块（万方）

**DOM**：
```
#aliyunCaptcha-sliding-wrapper   轨道（320×50）
#aliyunCaptcha-sliding-slider    滑块按钮（50×50）
#aliyunCaptcha-sliding-left      已滑过区域（宽 0 = 未过或被重置）
```

**⚠️ 两个致命缺陷（原实现导致连续 3 轮全败）**：

1. **没等滑块出现** —— 阿里云验证码是**异步注入**的，页面 `domcontentloaded` 后约 **3 秒**才出现元素。
   原来只等 4.5 秒就取元素，经常拿到 `null` 直接 return false。
   → **轮询最多 20 秒**等元素出现。

2. **缺少"预热"** —— 直接 `mousedown` 后匀速拖，被判定为机器。
   → 增加：hover 400ms → mousedown → 300ms → 小幅抖动 5 步 → 主拖 55 步
     （前 20% 步间 30~55ms、之后 10~24ms）→ 到位前 -3px 微调 → 精确到位 → 停 400ms → mouseup。

**修正后第 1 次即通过。**

**放行绑定在 profile 上，不是纯 IP**：换 profile 或换 MCP 浏览器仍被拦。
固定用 `~/.dsh/wf-profile`，首次 `--login` 手动过一次即长期复用。

### 2.2 blockPuzzle 滑块（知网）

**结构**：背景图 310×155 + 拼图块 47×155 + `.verify-move-block` 40×40

**算法**：把拼图块的 alpha 掩膜按不同 dx 平移到背景图上，比较「掩膜内平均亮度」vs「掩膜外环平均亮度」——
缺口是半透明压暗的，差值最大处即答案。（与天爱滑块同一套思路）

**两个必要条件**：
1. 必须等两张图都 `naturalWidth>0` 再算，否则拿到 0×0 直接失败
2. **失败后必须刷新换图重试**（原地重算用的是旧数据）

### 2.3 天爱滑块（法院被执行人）

`gen` 返回的 `type` 在 `SLIDER` / `WORD_IMAGE_CLICK` 之间随机，`?type=SLIDER` 参数**不可靠**（约 75% 生效）
→ 循环重试直到拿到 SLIDER。

校验体只有 `left` 是决定性的，`trackList` 伪造不影响。

### 2.4 律师诚信平台的滑块（特殊）

`GET /credit/captcha/gen?type=CONCAT` + `POST /credit/captcha/verify`
- `data` = 缺口高度，`seam = H - data`
- 上半图是平移 dx 的原图，用加权 NCC 扫 dx 求峰
- **`moveX = -dx × 260/590`（负号是关键，符号反了 0/8，改后 8/8）**
- 上限 206 是前端写死
- 验证成功必须手动把 iframe 里 `#verifyResult` 设 `"true"`，否则父页面不 reload

---

## 三、WAF 类

### 3.1 瑞数（法院被执行人 `zxgk.mjs`）

请求 URL 上挂的 `vG5nbKcB=...` 是瑞数动态 token，由页面 JS 自动补。**两个必要条件，缺一即 400**：
1. `--disable-blink-features=AutomationControlled`
2. 覆盖 UA，去掉 `HeadlessChrome` 字样

**另一个坑：profile 会被标记且不自愈。**
一旦某 profile 在**非 stealth** 状态下访问过，瑞数会打标记 cookie，之后即使补上 stealth 也恒 400。
→ 从第一次访问起就带 stealth；已污染的 profile 删掉换新。脚本已内置自愈（首次失败换全新 profile）。

### 3.2 JS 挑战页（国家统计局）

接口返回的不是 JSON，而是：
```html
<noscript><h1><strong>Please enable JavaScript and refresh the page.</strong></h1></noscript>
```

**两个触发条件**：
1. **纯 Node fetch 必触发** → 必须用真实浏览器加载页面、让挑战脚本跑完，**再在页面上下文内发请求**
2. **请求量过大后升级** —— 实测建索引约 450+ 请求后，连之前正常的浏览器会话也一起被拦，需等待恢复

**⚠️ 风控可能按「接口路径」生效**：`stream/esData`（取数）可用，而 `queryIndexTreeAsync`（建索引）被拦。
**所以"某个功能挂了"不等于"整个脚本挂了"** —— 先试试最常用的那条命令。

### 3.3 加速乐 Jiasule（国家社科基金 `fz.people.com.cn`）

**恒 403 / 199 字节，按 IP 段拦截。**
已逐一排除：UA、完整浏览器头、Sec-Fetch-*、http/https、带 `__jsluid_s` 二次请求、
**Playwright + 系统 Edge 真实浏览器（同样 403）**。
对照 `www.people.com.cn` 200 正常 → 是 fz 子域策略。**不可用，别浪费时间。**

### 3.4 Cloudflare（UNESDOC）

**headless 是硬墙**，不是"多等等就过"：
- headless 永远停在"请稍候"
- 把 `cf_clearance` cookie 外带给裸 fetch 仍 403
- **headed 1 秒过**

→ 必须接受 headed 窗口（可挪到屏幕外）。

### 3.5 reCAPTCHA（NCBI Bookshelf 网页）

`https://www.ncbi.nlm.nih.gov/books/?term=` 现在返回「正在检查您的浏览器 - reCAPTCHA」，**浏览器也过不去**。
→ 改用 **E-utilities 的 `db=books`**（纯 API，不受挑战影响）：
```
esearch.fcgi?db=books&term=<书名>   → count + idlist
esummary.fcgi?db=books&id=<ids>     → bookinfo XML 含 <PublicationStatement>
```
`"Oxford (UK): Oxford University Press; 2016 Dec."` → 冒号后分号前就是出版社。

---

## 四、编码类

### 4.1 PowerShell 5.1（本机没有 pwsh）

| 铁律 | 原因 |
|---|---|
| **本机没有 `pwsh`，只有 5.1** | 用 `& ".\xxx.ps1"` 或 `powershell -File xxx.ps1` |
| **含中文的 `.ps1` 必须带 UTF-8 BOM** | PS 5.1 读无 BOM 文件按 GBK 解码 → 中文全乱码 |
| **PS 5.1 默认 TLS 1.0，直连 HTTPS 会失败** | 脚本内需 `[Net.ServicePointManager]::SecurityProtocol = 'Tls12'` |
| **给脚本传中文参数用单引号** | 双引号会吃掉 `\"`，检索式被截断 |

### 4.2 网页编码嗅探（`webq.mjs`）

国内老站点大量 GBK/GB2312，直接 `res.text()` 会乱码。
正确做法：先看 `Content-Type` 的 charset，缺失时先试 UTF-8、**坏字符（U+FFFD）占比高再按 GBK**。

### 4.3 去标签顺序

**必须先删 `<script>`/`<style>` 再删标签**，否则 JS 里的字符串会被当成正文。

---

## 五、Node / JS 类

### 5.1 不要用 `process.exit()`

在 fetch 连接未完全关闭时强退会触发：
```
Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c, line 94
```
退出码变成 `-1073740791`，看起来像崩溃。

**正确做法**：设 `process.exitCode` 让进程自然退出（见 `webq.mjs` 的 `done()` 写法）。

**⚠️ 连带坑**：`cmd` 里 `if not errorlevel 1` 会把负的崩溃码判为"不小于 1"→ **崩溃被当成成功**。
跨语言传退出码一律字符串比较 `if "!RC!"=="0"`。

### 5.2 浏览器上下文里没有 `process`

早期在页内 IIFE 里写 `Number(process.env.XXX)`，导致 IIFE 抛 `ReferenceError`、
`window.__nbs` 从未被赋值。**所有外部配置必须通过参数传入。**

### 5.3 `addInitScript` 只接受一个参数

传多个会报 `Too many arguments`。配置要包成对象：`addInitScript(fn, { a, b })`。

### 5.4 `.catch(() => [])` 是静默失败

早期每个请求都 `.catch(() => [])`，结果遇到风控时**"抓到 0 条但显示成功"** —— 比赛里最危险的失败模式。
**必须显式报错**，区分「请求失败」与「真的无记录」。

### 5.5 Node 24 OpenSSL3 禁了 DES

`nsfc.mjs` 的 API 响应是 DES/ECB+PKCS7+Base64 加密（密钥 `IFROMC86`），
Node 24 会报 `ERR_OSSL_EVP_UNSUPPORTED` → 脚本自带纯 JS DES 实现。

### 5.6 浏览器类脚本不能连跑

持久化 profile 的锁在前一进程退出后**未完全释放**，下一个会拿到"被验证/空结果"的假象。
自检必须分两组，浏览器类**每个之间停 3 秒**。

---

## 六、请求量纪律

| 铁律 | 原因 |
|---|---|
| **绝不做批量爬取** | 统计局建索引 450+ 请求 → **IP 级封禁**（约 1 小时才恢复） |
| **每个 CLI 单次只发 1~2 个请求** | 这是安全的；慢但不会把自己搞死 |
| **知网分面只在需要时展开** | 每次展开都是一批 AJAX 请求 |

---

## 七、各站关键参数备忘

### 知网（CNKI）
- 结果页 URL 不变（`POST /kns8s/brief/grid` 渲染），**无法用 URL 复现检索**，只能走表单
- 提交按钮 `input.btn-search` **必须 JS click**（locator 点击会 5s 超时）
- 时间框 `input.publishdate` 是 **readonly**，须先 `removeAttribute` 再设值并派发事件
- 分面 DOM：`#divGroup > dl > dt>b(名) + dd[tit] > ul>li>a(名称)+span(数量)`
- **分面只有前 3 个默认加载**，其余 8 个必须点 dt 标题

### 万方
- 三个子域风控不同：`www.`（主站不拦）、`c.`（会议导航免滑块）、`s.`（**检索，阿里云滑块**）
- 结果页是 Vue + **protobuf**，分面 API 响应是二进制（这解释了直连报 415）
- 详情页记录 id 在 `<span class="title-id-hidden">thesis_Y2342024</span>`（不是 `<a href>`）
- 详情页 URL = `https://d.wanfangdata.com.cn/<id前缀>/<id编号>`，**期刊前缀是 `periodical` 不是 `paper`**
- 时间字段是 **`发表时间`**，不是「出版时间」

### 维普
- `qikan.cqvip.com`（检索）对 pwsh 返回 **412**；`www.cqvip.com`（帮助文档）可直连
- 检索式检索操作链：点 `li`「检索式检索」→ `textarea[placeholder=请输入检索式]` → `button.behavior-advanceexpresssearch`
- 结果**不跳转**，同页显示「共找到 X 篇文章」
- 结果项 `dl` 里**第一个 `dd` 是序号不是作者**

### 国图
- 民国图书（`data_416`）：**服务端渲染**，纯 HTTP 0.25 秒
- 中华古籍（`searchType=1002`）：**Vue 异步渲染**，检索必须浏览器
- 古籍详情页不是 `<label>`，是「字段：值」纯文本行 + 「第N册」列表，**册数 = 数第N册**
- 该库是**分词 OR 匹配**，噪音极大，必须按书名/出版时间逐条核对

### 国家标准
- `gbQueryPage` 返回的 `id` **不是** openstd 的 hcno
- 正确 hcno 来源：`openstd.samr.gov.cn/bzgk/gb/std_list?p.p1=0&p.p2=<标准号>`，每行 `onclick="showInfo('<32位HEX>')"`
- **必须按标准号精确匹配那一行**（列表会同时返回旧版）

### 统计局
- `esData` 请求体字段名必须完全一致，少一个就 500
- 分省：`das:[{text:"河南省",value:"410000000000"}]`（12 位行政区划码 = 前2位+10个0）
- **精度坑**：返回的是按指标显示精度四舍五入的字符串（2018 给 "753.3"，真值 753.3087）

### 药监局
- 站点已迁移到 `datasearch.nmpa.gov.cn`（旧地址跳 url_change，裸根路径 403）
- 签名：`md5(encodeURIComponent(qs+'&'+appSecret) 再替换 ( ) ! ~)`，`appSecret = "nmpasecret2020"`
- **替换必须在 encodeURIComponent 之后**（顺序反了纯中文能过、含半角括号必失败）
- `search` 用单数 `itemId`，`countNums` 用复数 `itemIds`
- **过期注册证会从「注册」库移到「历史数据」库**，查不到先换库

### 证券业协会
- `POST /publicity/v2/getPersonListByName` **必须同时传 name 和 orgName 两个字段**（空串也要传）
- orgName 是**精确匹配**（传"渤海"得 0），脚本已内置模糊退化
- 深圳在注册地码表里是**独立代码 03**，用"广东"会漏掉中信/招商/国信

### 研招网
- 主管部门参数是 **`yxls`** 不是 `ylgx`（`ylgx` 是院校特性，传 2/3 直接"搜索无结果"）
- 每页 20，需翻页

### 辟谣平台
- `frontsql.htm?kw=` 只是页面外壳，真实接口是 `so.news.cn/xhtvapp/rumourSearch`
- 访谈列表是**静态 JSON** `ds_<32位id>.json`，id 从 `ft.htm` 的 `data="datasource:"` 现抓

### 共产党员网
- 站内**不存在**"全国优秀共产党员展播"这个栏目名，实际是 `/special/dzby/dy/`
- 导航链接只能靠 `--links` 抓（grep 文字抓不到）

### 庭审公开网
- 高级检索（案号精确字段）**必须登录**，点了会触发 5 分钟限流
- 普通检索 `/search/common?keywords=<案号>` 可直连，效果等价
- `/live/<id>` 详情页有 WAF 滑块，**视频时长拿不到**

### 智慧树
- 列表接口 `indexPageSearch/shareCourse` 一次给 968 门，但 **pageSize>60 会 503**
- `orderRuler` 排序不可信，本地按 `studentCount` 排
- 章节接口报 500 `NumberFormatException`（需登录态）

### 百度学术
- 直连 `s?wd=` 必 403「百度安全验证」，首页是 Nuxt 空壳
- `_token/_sign` 是前端签名，无法伪造 → 必须 Playwright
- 输入后**按 Enter 无效**，必须点联想项再点按钮
- 联想项有《…年刊英文版》干扰

### 福建省图书馆
- 「书目检索」是 **POST** 到 `opac.fjlib.net`（GET 只回检索表单页）
- 解析用 `class="title-link"` / `class="callnosSpan"` 锚点，纯文本回溯会漏

### 重庆大学图书馆
- `filterRule` 的 key 名必须**原样照抄**，自编 key 直接 500 且无报错
- `requestAggsType` 必须 = 1（=2 时 `hits.source` 恒空）
- 复本数/索书号在检索结果里是 null，必须另调 `collection-status-by-ids`
- **Node fetch 可以，Playwright 带 msedge UA 反而 403** → 全程不用浏览器

---

## 八、本机网络限制（IP 级，换网络可能不同）

| 站点 | 状态 | 说明 |
|---|---|---|
| **IEEE Xplore** | ❌ 418 全站 | 连主页都打不开，换 profile/加 stealth 全无效 |
| **Google 全站** | ❌ 超时 | 含 patents.google.com |
| **CNIPA 专利** | ❌ 412 | pss-system |
| **USPTO** | ❌ WAF | PatentsView 已迁移 |
| **国家社科基金** `fz.people.com.cn` | ❌ 403 | 加速乐按 IP 段拦截 |
| **万方标准库** | ⚠️ SPA | 解析不到条数 |
| **维普标准库** | ⚠️ 需浏览器 | 未做 |
| **smart.edu** | ⚠️ 未定位 | `/api/edu/*` 全 401 需 token |

**用 `node doctor.mjs --net` 现场复核**，不要凭记忆。
