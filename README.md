# 信息素养速查库 · info-literacy-quickref

> 为大学生「AI+信息素养」大赛（互联网信息素养大赛）而做的检索作战包。
> **26 个已逆向打通的 CLI**，覆盖知网、万方、维普、国家图书馆、PubMed/NCBI、国家标准、
> 国家统计局、专利药监、法院、基金、证券业协会等 **40+ 站点**，一条命令直出答案字段。

比赛考的是"给一道题，30 秒内从某个数据库里取一个具体数字/字段"。手工点网站来不及，
而各站都有反爬（滑块 / 瑞数 / 阿里云验证码 / JS 挑战 / reCAPTCHA）。本仓库把这些站点
逆向成命令，跳过浏览器交互，直接取数。

---

## 快速开始（3 步）

```bash
# 1. 安装 skill（全局，所有会话可用）
npx skills add xianwins4ever-ux/info-literacy-quickref -g -y

# 2. 装浏览器依赖（只有 11 个"需要开浏览器"的脚本用得上）
npm i -g playwright-core          # 或 npm i -g @playwright/mcp

# 3. 体检 —— 全绿才能开赛
cd ~/.agents/skills/info-literacy-quickref
node doctor.mjs
```

`doctor.mjs` 报红就是真跑不了，别硬试。它检查的是**打包不了的东西**：
playwright-core 位置、各站点 profile（登录态 / 过滑块的放行 cookie）、网络可达性。

体检全绿后建议再跑一次端到端验证：

```bash
node scripts/_selftest.mjs        # 约 5 分钟，确认 24/24
```

> Windows 下 `~` 即 `C:\Users\<你的用户名>`，skill 会装到
> `C:\Users\<你的用户名>\.agents\skills\info-literacy-quickref`。

---

## 首次放行清单（新用户必读）

**这一步不做，浏览器类脚本会在验证码页卡住。** 各站的"放行 cookie"存在 profile 目录里，
无法随仓库分发 —— 必须你本人在有头浏览器里过一次验证，之后长期复用。

| 站点 | 脚本 | 首次放行命令 |
|---|---|---|
| 知网 | `cnki.mjs` | `node scripts/cnki.mjs --ti 测试 --headed` |
| 万方 | `wf.mjs` | `node scripts/wf.mjs "测试" --login` |
| 维普 | `vp.mjs` | `node scripts/vp.mjs 'K=测试' --headed` |
| 国家统计局 | `nbs.mjs` | `node scripts/nbs.mjs "GDP" --headed` |
| 法院被执行人 | `zxgk.mjs` | `node scripts/zxgk.mjs "测试" --headed` |
| 国家标准 | `std.mjs` | `node scripts/std.mjs "GB/T 5750.1-2023" --headed` |
| 百度学术 | `bdxs.mjs` | `node scripts/bdxs.mjs --journal "中国图书馆学报" --headed` |
| 律师诚信平台 | `lawyer.mjs` | `node scripts/lawyer.mjs --unlock` |
| UNESCO | `unesdoc.mjs` | `node scripts/unesdoc.mjs --record pf0000393559 --headed` |
| 药监局 | `nmpa.mjs` | 无需放行，headless 直连即可 |
| 国图古籍 | `nlc_guji.mjs` | 无需放行，headless 直连即可 |

放行完再跑 `node doctor.mjs`，对应 profile 应显示"存在"。

**其余 15 个脚本是纯 HTTP，不需要放行**（PubMed、国图民国书、研招网、证券业协会、
基金、庭审公开网、智慧树、webq 兜底等），装好 Node 就能用。

---

## 拿到题目怎么用

打开 [`SKILL.md`](SKILL.md) 第 1 节查表：题目里出现哪个站点关键词，就用对应命令。
最常用的几条：

```bash
# 知网：篇名 + 主题 + 时间 + 只看期刊
node scripts/cnki.mjs --ti "AI + 人工智能" --su "法律 + 法规" --from 2020 --to 2024 --db journal

# 知网：发文量最多的作者 / 单位
node scripts/cnki.mjs --su "数字经济 * 税收" --facet author

# 知网：某篇的 DOI / 作者单位 / 基金 / 年卷期 / 页码
node scripts/cnki.mjs --ti "篇名" --top 1 --detail

# 国图古籍：这本书有几册
node scripts/nlc_guji.mjs "南岑吴氏宗谱"

# 国家统计局：某省某年的指标
node scripts/nbs.mjs "粮食单位面积产量" --year 2023 --prov 河南

# PubMed：限定条件数文献
node scripts/pubmed.mjs "CRISPR[Title/Abstract] NOT therapy[Title]" --from 2017 --to 2024

# 上面都没有 → 万能兜底：抓任意网页并 grep
node scripts/webq.mjs "<URL>" --grep "关键词" --ctx 3
```

**26 个脚本的完整对照（字段 / 耗时 / 状态）** 见 [`references/capabilities.md`](references/capabilities.md)
和 [`references/cheatsheet.md`](references/cheatsheet.md)。

---

## 目录结构

```
info-literacy-quickref/
├── SKILL.md                    # 入口：检索决策表 + 8 个必踩的坑（读这个就够开赛）
├── README.md                   # 本文件
├── package.json                # Node 版本 / 可选依赖声明
├── doctor.mjs                  # 环境体检（skill 能否工作的唯一判据）
├── scripts/
│   ├── _env.mjs                # 跨平台路径解析（profile / playwright-core）
│   ├── _selftest.mjs           # 端到端自检（24 项）
│   └── *.mjs / *.ps1           # 26 个站点的 CLI
└── references/
    ├── capabilities.md         # 能力全景：每个脚本能查哪些字段（三库字段级对比）
    ├── cheatsheet.md           # 26 个脚本完整对照（耗时/状态）
    ├── pitfalls.md             # 各站反爬细节、环境铁律（修脚本时看这个）
    ├── reverse-notes.md        # 站点 API 逆向过程
    ├── sessions.md             # 实战记录与口径偏差
    └── answers.md              # 三套模拟题答案速查（150 题）
```

---

## 适配你自己的环境

不需要改任何代码。三件事都可配：

| 想改什么 | 怎么做 |
|---|---|
| profile 存放位置 | 设环境变量 `<站点>_PROFILE`，如 `CNKI_PROFILE=/data/cnki-profile` |
| playwright-core 位置 | 设 `PLAYWRIGHT_CORE_PATH=<...>/playwright-core/index.js` |
| 默认浏览器 | 脚本用 `channel:'msedge'`（系统 Edge）；装了 Chrome 可改成 `'chrome'` |

不做任何配置时的默认行为：

- profile → `~/.dsh/<站点>-profile`（自动创建）
- playwright-core → 依次试 `PLAYWRIGHT_CORE_PATH` → 平台常见全局位置 →
  `npm root -g` → 裸包名 `playwright-core`

> 早期版本把路径硬编码成了开发机的绝对路径。已全部改为上述动态解析，
> 换机器 / 换用户名 / 换系统都能跑（Windows / macOS / Linux）。

---

## 已知边界

- **打包不了运行时状态**：profile 里的登录态 / 放行 cookie 会过期。万方最常失效，
  重跑 `node scripts/wf.mjs "测试" --login` 即可。
- **网站改版会失效**：脚本是对着 2026-10 的页面结构写的。改版后按 `SKILL.md` 第 6 节修
  （先读脚本头部注释里的接口定义，再用一道真题回测）。
- **IP 级封锁**（开发机网络实测，换网络可能不同）：IEEE Xplore（418）、
  Google 全站（超时）、CNIPA 专利（412）、国家社科基金（403）。
- **限流不等于坏了**：维普会间歇 412、MIT DSpace 会 429。等 10~60 分钟，
  **不要连续重试**（会延长封锁）。
- **桌面软件题**（QQ 截图、雨课堂、Zotero、微信指数）没做脚本 —— 人工操作更快。

---

## 设计原则

1. **自包含**：所有脚本在 `scripts/` 内，不引用任何外部绝对路径。
2. **SKILL.md 要短**：决策表 + 最常用的坑放主文件，细节按需读 `references/`，
   避免一次塞满上下文。
3. **doctor 优先**：新环境最容易踩的坑不是"不会用"，而是"环境变了却不知道"。
4. **知识优先于代码**：脚本会因改版失效，但 `pitfalls.md` 里的知识不会。
   修脚本时先读那里。

---

## 合规与免责

- 本仓库是**个人学习与备赛**的产物，用于减少重复的机械点击。
- 所有数据都来自各站点的公开页面，脚本不做绕过付费墙、不批量爬取全站、
  不修改任何站点数据。
- 请遵守各站点的服务条款与 robots 协议，**控制请求频率**。因使用本仓库产生的
  任何后果由使用者自负。
- 站点方改版或加强风控后脚本会失效，属正常现象，欢迎提 issue 但不要期待
  永远可用。

## License

MIT
