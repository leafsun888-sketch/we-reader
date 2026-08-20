# Second Brain 微信公众号阅读器

一个只在本机运行的公众号、YouTube 与 Twitter 阅读器。它读取项目私有 `data/数据/library.json`，登录资料和归档内容均保留在本机。

## 启动

```sh
./start.sh
```

浏览器打开 <http://localhost:8041>。

## 结构

- 最近一天：过去 24 小时发布的文章，按时间排列。
- 最近 7 天：过去一周发布的文章，按公众号分组。
- 全部书架：按固定分组管理公众号、YouTube 频道与 Twitter 账号。
- Twitter：合并所有关注账号的本地时间流。
- YouTube：按发布时间浏览双语字幕文章。

文章详情页保留公众号、时间与原文链接。微信公众号通常不允许跨站嵌入，因此“阅读原文”会在新标签页打开微信原文。

## 更新书库

`weread-mp-fetcher` 每次成功抓取后，会自动导出书库并下载新文章的 Markdown 和图片。正常情况下无需手动执行任何同步命令。

如需在不重新抓取的情况下重试某些归档失败的文章，可运行：

```sh
cd fetcher
node bin/archive-second-brain.mjs
```

归档位置为 `data/文章/<公众号名>/<YYYY-MM-DD 标题>/<YYYY-MM-DD 标题>.md`；文内图片保存在同级 `assets/`。历史文章不会被覆盖。
