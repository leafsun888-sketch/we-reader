# We-Read

本地优先的微信公众号阅读器：从你自己的微信读书书架低频拉取文章目录，将正文、Markdown 和图片保存到本机，并在 `http://localhost:8041` 阅读、收藏和划线。

> 这不是官方微信或微信读书客户端。只处理自己有权访问的内容；不绕过登录、验证码或访问控制。

## 快速开始（macOS）

```bash
git clone https://github.com/leafsun888-sketch/we-reader.git
cd we-reader
./start.sh --check                 # 完整检查 Node、Python、转换器和 Chrome
./scripts/start-chrome-debug.sh    # 打开 We-Read 专用 Chrome 窗口
./start.sh                         # 启动阅读器
```

然后：

1. 在**专用 Chrome 窗口**中登录 <https://weread.qq.com/>，并保持至少一个微信读书标签页打开；验证码必须由用户手动完成。
2. 打开 <http://localhost:8041>。
3. 在“全部书架”粘贴任意 `https://mp.weixin.qq.com/s/...` 文章链接以添加公众号。
4. 点击“拉取更新”。新号默认导入最近 50 篇；已初始化的号仅拉取增量。

空书库是正常状态。首次通过网页添加公众号时，`fetcher/config.json` 会自动在本机创建。

## Chrome 136+：必须使用专用配置目录

Chrome 136 起，使用**默认 Chrome profile** 启动 `--remote-debugging-port` 不再可靠。`./scripts/start-chrome-debug.sh` 已同时传入：

```text
--remote-debugging-address=127.0.0.1
--remote-debugging-port=9222
--user-data-dir=<项目>/data/chrome-debug-profile
```

因此无需关闭日常 Chrome，也不会读取或上传日常 Chrome profile。第一次运行时请在这个独立窗口重新登录微信读书。请不要将调试端口暴露到局域网或公网。

Linux/Windows 用户请用同等参数启动 Chrome/Chromium：关键是 `--remote-debugging-port=9222` 与一个**非默认** `--user-data-dir`。

## 依赖与归档

- Node.js 18+；不需要 `npm install`。
- Google Chrome。
- Python 3.11+：正文转换器 [fetcher/vendor/readgzh.py](fetcher/vendor/readgzh.py) 已随仓库交付，只使用 Python 标准库，不依赖 Codex 或 `pip`。

`./start.sh` 会在启动前检查这些依赖。若 macOS 的 `/usr/bin/python3` 是要求安装/接受 Xcode 的占位程序，启动器会优先选用已安装的 `uv` Python；也可自行指定：

```bash
export WE_READER_PYTHON=/path/to/python3
./start.sh
```

归档输出采用：

```text
data/文章/<公众号名>/<YYYY-MM-DD 标题>/<YYYY-MM-DD 标题>.md
data/文章/<公众号名>/<YYYY-MM-DD 标题>/assets/
```

转换器遇到验证码、空白页或错误页会失败，不会把它们保存为文章。同步结果有三种状态：

- `同步完成`：目录、书库和本地正文都已完成；
- `同步部分完成`：例如目录已更新但个别正文归档失败，界面会明确显示失败数量；
- `上次任务未完成`：目录抓取或书库导出失败。

## 日常使用与频率

- “拉取更新”会处理所有订阅号；默认建议每日最多 2 次、账号之间间隔 3 秒。
- 到达建议上限后仍可点击，但会要求二次确认。
- 不要频繁重试、并发抓取或把它设置为高频定时任务；遇到验证码或白屏请暂停，稍后由用户处理。
- 点击文章优先打开本地 Markdown；“微信原文”只是备用链接。图片会尽力本地化；可中断的补拉任务为：

```bash
"${WE_READER_PYTHON:-python3}" fetcher/bin/backfill-local-images.py --root data --delay 0.35
```

## 数据、隐私与备份

以下文件均被 `.gitignore` 排除，**绝不可提交**到 GitHub：

```text
data/                    # 文章、图片、收藏、划线、Chrome 专用 profile
fetcher/config.json      # 订阅、频率和调试端口
fetcher/data/            # 抓取结果与当日额度
```

若要迁移给自己，复制整个 `data/` 与 `fetcher/config.json`；不要上传 Cookie、浏览器 profile、日志或文章内容。

## 给 AI / Codex 操作员

1. 先运行 `./start.sh --check`；不要猜测依赖已存在。
2. 仅让用户在 `./scripts/start-chrome-debug.sh` 打开的专用 Chrome 中完成登录和验证码；不得索要 Cookie、密码或导出浏览器资料。
3. 只接受用户给出的公众号文章链接，不绕过验证码、权限或平台限制。
4. 归档失败时必须报告具体阶段；不得声称“同步完成”。
5. 永远排除 `data/`、`fetcher/config.json`、`fetcher/data/` 和任何浏览器 profile 后再提交。

## 开发与验证

```bash
npm test --prefix app       # HTTP 集成测试：书库、文章、收藏、订阅、归档失败状态
npm test --prefix fetcher   # 抓取判据与纯逻辑离线测试
node --check app/server.mjs
node --check app/public/app.js
python3 -m py_compile fetcher/vendor/readgzh.py
```

## 版本、发布与维护

- 当前版本见 [VERSION](VERSION)，变更记录见 [CHANGELOG.md](CHANGELOG.md)。
- 每次发布更新 `VERSION`、两个 `package.json` 与 `CHANGELOG.md`，运行完整验证后创建 `vX.Y.Z` GitHub Release。
- 兼容性与安全问题请按 [CONTRIBUTING.md](CONTRIBUTING.md) 提交 Issue；报告中不得包含 Cookie、文章正文或浏览器资料。
- 这是一个本地工具，平台接口可能变化。维护者应优先修复可靠性、数据安全和低频保护，而不是扩大抓取规模。

## 许可证

[MIT](LICENSE)
