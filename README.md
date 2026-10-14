# We-Read

一个以本机存储和本机服务为核心的公众号、YouTube、Twitter 与小宇宙阅读、订阅和归档工具。原始内容、订阅和阅读状态保存在本机；Twitter 价值审核及音视频文稿整理会调用配置的模型，并消耗对应账户额度。

打开：<http://localhost:8041/>

## 启动

需要 Node.js 18+、Python 3.10+ 和 Google Chrome。公众号转换器已随仓库提供，不依赖个人 Codex Skill 目录。

```bash
cp fetcher/config.example.json fetcher/config.json
./scripts/check-dependencies.sh
./start.sh
```

首次拉取在自动打开的专用 Chrome 中登录微信读书。YouTube、Twitter 和小宇宙的可选 Python 环境分别见 [YouTube](youtube/README.md)、[Twitter](twitter/README.md)、[小宇宙](podcast/README.md)；模型整理另需已登录的 Codex CLI。可通过 `WE_READ_PYTHON` 指定公众号归档或小宇宙使用的解释器，通过 `READGZH_SCRIPT` 指定兼容的转换器。

## 日常使用

- **管理订阅**：在“全部书架”的统一添加入口登记公众号文章链接、Twitter 用户名、YouTube 频道或小宇宙节目网址。
- **拉取更新**：右上角按钮只抓取增量；首次订阅默认抓取最近 50 篇。按钮左侧会先显示索引处理动画；文章索引写入后会立刻出现在网页里，并切换为 Markdown 与图片归档的 `已完成 / 总数` 进度。按钮会自动启动项目专用的 Chrome 窗口；第一次在该窗口登录微信读书，之后会持续复用本地登录态。微信读书出现验证码时，需要在这个窗口里手动完成验证。
- **阅读原文**：点击任意文章会直接在浏览器新标签页打开微信原文；右侧星标仍可加入收藏待读。
- **书架分组**：宏观、价值、成长、Youtube、小宇宙、Twitter 独立管理，左侧目录可快速跳转。公众号默认归入价值；Twitter 的高低频与屏蔽在对应书卡下调整。
- **YouTube 频道**：通过频道 RSS 增量发现视频，优先取得英文字幕并保存本地原稿；模型生成中文梗概和分段中文文稿。标题打开本地文字，右侧按钮打开 YouTube 原视频。
- **小宇宙**：独立 Tab 与书架分组；公开音频下载到本机，使用 MLX Whisper 转录，再由模型生成梗概和分段文稿。原始转录保留，不抓私有或付费内容。
- **Twitter 账号**：默认展示低频（最近 2 个月），点击后切换高频（最近 2 周）；标签下可按人物筛选，按原始发布时间倒序，每批加载 30 条。Twikit 只读复用专用 `chrome-twitter` 登录态。新推文先经 Agent 价值审核，再保存并展示原文，不再自动完整翻译；已有译文保留在本地归档。长推文可生成英文标题和摘要。屏蔽只隐藏信息流，不停止同步。服务在本地时间 12:00、20:00 检查更新，打开页面也会低频检查。
- **Twitter 删除**：Twitter 条目的星标旁有一个减号。确认后会删除本地 Markdown、书库条目、收藏和划线，并写入删除标记，之后同步不会重新导入该条推文。
- **超级大盘**：独立 Tab 用分类书架保存常看的市场 Dashboard。点击整张卡会在新标签页打开原网站；“关注 Dashboard”可以继续添加名称、网址、分类和简介，右上角 × 只移除本机保存的链接。首张卡为 [Kim Premium](https://kimpremium.com/) 的韩国散户杠杆与去杠杆监控。
- **设置**：可调整每日抓取上限、请求间隔和首批文章数量。默认值偏保守，减少触发风控的概率。
- **移除订阅**：停止之后的同步并从阅读器隐藏；已归档文章会保留，避免误删知识资产。

## 目录

```text
we-reader/
├── app/                 # 本地网页与管理接口
├── fetcher/             # 微信读书订阅、增量抓取与归档逻辑
├── youtube/             # YouTube 频道发现、字幕同步和 Markdown 归档
├── podcast/             # 小宇宙节目、音频转录与可读文稿
├── twitter/             # Twitter 公开账号订阅、增量同步与 Markdown 归档
├── data/                # 全部用户数据
│   ├── 文章/             # Markdown 正文和本地图片
│   ├── 数据/             # 书库、收藏、分组与抓取状态
│   ├── 日报/             # 每次同步生成的日报
│   └── feed.xml          # RSS
└── README.md
```

备份时保留本机 `data/` 和私人配置；不要上传到公开仓库。迁移新机器需重新配置运行环境及登录态。YouTube 不需要 API Key；Twitter 的 X Cookie 只保存在私有 `data/` 中。音视频整理会把字幕或逐字稿提交给配置的模型，Twitter 候选推文会提交给价值审核模型。

## 微信正文与原文链接

归档优先从已登录的微信读书阅读器请求 `/web/mp/content?reviewId=`，提取真实正文，再转换为 Markdown 并下载图片。新版 WR1 标识不直接拼成微信短链：从文章 HTML 的 canonical/og:url 取得真实微信地址，文章标题仍打开该原文。验证码必须手动完成；删除、隐私限制和不完整转载卡片不视为归档成功。

历史链接修复与只补正文均通过服务端任务锁执行，不重新拉取文章索引，也不消耗索引次数：

```bash
curl -X POST http://localhost:8041/api/refresh -H 'Content-Type: application/json' -d '{"repairUrlsOnly":true}'
curl -X POST http://localhost:8041/api/refresh -H 'Content-Type: application/json' -d '{"archiveOnly":true}'
```

不要同时执行这两个请求。链接修复先保存本地 JSON 备份，文章 ID、收藏和划线保持不变。缓存和备份都在忽略的 `data/` 内。

## 手动启动

```bash
cd app
node server.mjs
```
