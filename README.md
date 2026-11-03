# info-literacy-contest

互联网信息素养大赛（信息检索竞赛）的检索作战包。

## 这个 skill 解决什么问题

比赛是"给一道题，30 秒内从某个数据库里取一个具体字段"。手工点网站来不及，
而各站都有反爬（滑块/瑞数/阿里云验证码/JS 挑战/reCAPTCHA）。

本 skill 把 26 个站点逆向成 CLI，一条命令直接出答案字段。

## 快速开始

```bash
# 1. 体检（唯一必做，30 秒）
node doctor.mjs

# 2. 端到端验证（约 5 分钟，确认 24/24）
node scripts/_selftest.mjs
```

`doctor.mjs` 报红就是真跑不了，别硬试——它检查的是**skill 打包不了的东西**：
playwright-core 路径、各站点持久化 profile（登录态/放行 cookie）、网络可达性。

## 用法

拿到题目后，打开 `SKILL.md` 第 1 节查表：题目里出现哪个站点关键词，就用对应命令。

不确定用哪个？用万能兜底：
```bash
node scripts/webq.mjs "<URL>" --grep "关键词" --ctx 3
```

## 目录结构

```
info-literacy-contest/
├── SKILL.md                    # 入口：决策表 + 五个必记的坑（8.5 KB，读这个就够开赛）
├── doctor.mjs                  # 环境体检（skill 能否工作的唯一判据）
├── scripts/                    # 26 个 CLI + 2 个 PS 脚本 + 自检
└── references/
    ├── cheatsheet.md           # 26 个脚本完整对照（耗时/状态）
    ├── pitfalls.md             # 各站反爬细节、环境铁律（修脚本时看这个）
    ├── answers.md              # 150 道模拟题答案速查
    ├── reverse-notes.md        # 站点 API 逆向过程
    └── sessions.md             # 各次实战记录与口径偏差
```

## 设计原则

1. **自包含**：所有脚本在 `scripts/` 内，不引用任何外部绝对路径（已用"把原目录改名"验证过）。
2. **SKILL.md 要短**：决策表 + 最常用的坑放在主文件，细节按需读 `references/`。避免一次塞满上下文。
3. **doctor 优先**：新对话最容易踩的坑不是"不会用"，而是"环境变了却不知道"。
4. **知识优先于代码**：脚本会因网站改版失效，但 `pitfalls.md` 里的知识不会。修脚本时先读那里。

## 已验证的等价性

本 skill 做过一次**隔离测试**：把原始开发目录整体改名后，
在 skill 目录里跑 `_selftest.mjs` → **24/24 通过**。
证明它不依赖任何外部路径，新对话直接可用。

## 已知边界

- **打包不了运行时状态**：profile 里的登录态/放行 cookie 会过期。万方最常失效，修复：`node scripts/wf.mjs --login`
- **IP 级封锁**：IEEE Xplore（418）、国家社科基金（403）在本机网络下不可用，换网络可能不同
- **网站改版**：万方滑块参数、知网 DOM 随时可能变。修法见 `SKILL.md` 第 6 节
- **桌面软件题**（QQ 截图、雨课堂、Zotero）人工操作更快，未做脚本

## 维护

改完脚本必须用一道真题回测，对不上不算修好。然后把新坑写回：
- 脚本**头部注释**（具体接口细节）
- `references/pitfalls.md`（通用教训）
