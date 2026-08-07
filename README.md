# we-reader

把微信公众号整理为一个完全本地的阅读器与知识库。

它提供三件事：

- 从已登录的微信读书中增量获取公众号文章目录；
- 将文章正文、Markdown 和图片保存到本机；
- 在 `http://localhost:8041` 中按“最近一天 / 收藏 / 最近 7 天 / 全部书架”阅读、收藏和划线。

> 这是个人本地工具，不是官方微信或微信读书客户端。请只处理自己有权访问的内容，并保持低频使用。

## 给 AI / Codex 操作员的快速指令

如果你是刚克隆仓库后接手的 AI，请按以下顺序执行，**不要**要求用户提供 Cookie、密码或导出浏览器资料：

1. 确认 Node.js 18+ 可用；运行 `node --version`。
2. 启动本地网页：`./start.sh`，然后打开 `http://localhost:8041`。
3. 让用户在桌面 Chrome 中登录微信读书，并以远程调试端口 `9222` 启动 Chrome；不要尝试绕过验证码。若页面弹出验证码，暂停并让用户手动完成。
4. 在“全部书架”中粘贴任意一篇 `https://mp.weixin.qq.com/s/...` 链接添加公众号。首次添加会自动创建 `fetcher/config.json`，它只保留在本机。
5. 点击“拉取更新”。新公众号首次导入默认最近 50 篇；已有文章的公众号只拉取增量。每天建议最多 2 次；超出后必须由用户在界面二次确认。
6. 归档正文和图片时，优先保存为 `data/文章/<公众号>/<日期 标题>/`。不可将 `data/`、`fetcher/config.json`、浏览器 profile、Cookie、日志或任何用户文章推送到 GitHub。

## 首次安装

```bash
git clone https://github.com/<你的 GitHub 用户名>/we-reader.git
cd we-reader
node --version             # 需要 18 或更高版本
./start.sh
```

在浏览器打开 <http://localhost:8041>。空书库是正常状态；不需要预先创建数据库或配置文件。

### 连接微信读书

抓取目录会复用**你自己在 Chrome 中已登录的微信读书会话**。以 macOS 为例，关闭现有 Chrome 后运行：

```bash
open -a "Google Chrome" --args --remote-debugging-port=9222
```

随后在 Chrome 登录微信读书并保持一个微信读书网页标签打开。系统会先做只读探测；如出现验证码，请由用户自己完成，然后再点“拉取更新”。

## 日常使用

### 添加公众号

打开“全部书架” → “添加公众号” → 粘贴该公众号任意一篇文章链接，例如：

```text
https://mp.weixin.qq.com/s/xxxxxxxx
```

系统会识别公众号、加入微信读书书架，并显示“未完成初始化”。下一次拉取会导入最近 50 篇文章；之后仅拉取新增内容。

### 更新与频率

- 点击右上角“拉取更新”会处理所有当前订阅号。
- 默认每日建议 2 次、每个账号请求间隔 3 秒；可在设置中调低频率或把上限设为 1。
- 到达建议上限后按钮仍可点，但需要二次确认。额外拉取可能增加验证码、限流或账号限制的风险。

### 阅读、收藏和划线

- 点击文章会打开本地 Markdown 阅读页；“微信原文”仅作为备用链接。
- 选中文本后，鼠标旁会出现 `✓ / ×`：确认或取消划线。
- 文章阅读页左下角有固定的“返回文章列表”按钮。
- 书架卡片右上角 `×` 可以停止订阅；弹窗中可选择是否同时删除该公众号本地 Markdown 与图片。

## 本地数据与隐私

所有用户数据均在 `data/`，且根目录 `.gitignore` 已强制忽略它：

```text
data/
├── 文章/       # Markdown 正文和 assets 图片
├── 数据/       # 书库、收藏、划线、归档状态
├── 日报/       # 每次同步生成的日报
└── feed.xml    # 本地 RSS

fetcher/config.json       # 公众号订阅列表、频率、Chrome 端口
fetcher/data/             # 抓取结果与每日额度状态
```

这些文件都不会被上传到 GitHub。备份或迁移给自己时，复制整个 `data/` 目录与 `fetcher/config.json` 即可；不要把它们推送到公开仓库。

## 图片本地化

初次导入中，微信图片可能因防外链保留远程地址。可运行以下命令把已归档 Markdown 中的远程图片逐张保存到本地 `assets/` 并替换链接：

```bash
python3 fetcher/bin/backfill-local-images.py --root data --delay 0.35
```

该任务可中断并重跑；进度保存在 `data/数据/image-backfill-status.json`。建议串行低频执行。

## 文章归档依赖

文章目录抓取是 Node.js 零依赖流程；正文转 Markdown 需要一个兼容 `readgzh.py` 的文章转换脚本。Codex 环境通常已经提供该能力。非 Codex 环境中，请设置转换脚本和 Python 解释器路径后再抓取：

```bash
export WE_READER_PYTHON=/path/to/python3
export WE_READER_READGZH=/path/to/readgzh.py
```

若微信返回验证码、空白页或“参数错误”，不要反复重试；等待并让用户在浏览器完成验证。工具会把这类响应标为失败，而不会把错误页当作文章正文。

## 开发与验证

```bash
npm test --prefix app
npm test --prefix fetcher
node --check app/server.mjs
node --check app/public/app.js
```

## 目录结构

```text
we-reader/
├── app/          # 本地网页、订阅管理 API、阅读器
├── fetcher/      # 微信读书目录抓取、导出与归档逻辑
├── data/         # 仅本机数据；Git 忽略
├── start.sh      # 启动网页
└── README.md
```

## 风险边界

目录更新会使用已登录的微信读书会话；正文和图片归档则直接访问已知文章与图片地址。两者都可能遇到验证或限流，且平台规则可能变化。请保持低频、串行、人工处理验证码；不要把它用于批量公开传播或绕过访问控制。
