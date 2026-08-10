#!/usr/bin/env bash
# Chrome 136+ 只有在使用非默认 user-data-dir 时才会开放远程调试端口。
set -euo pipefail

PROJECT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${WE_READER_CHROME_PORT:-9222}"
PROFILE="${WE_READER_CHROME_PROFILE:-$PROJECT/data/chrome-debug-profile}"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "此快捷脚本面向 macOS。请用 Chrome 的 --remote-debugging-port=$PORT 和非默认 --user-data-dir 启动 Chrome。" >&2
  exit 2
fi
if [[ ! -d "/Applications/Google Chrome.app" ]]; then
  echo "未找到 /Applications/Google Chrome.app。请安装 Google Chrome 后重试。" >&2
  exit 2
fi

mkdir -p "$PROFILE"
open -na "Google Chrome" --args \
  "--remote-debugging-address=127.0.0.1" \
  "--remote-debugging-port=$PORT" \
  "--user-data-dir=$PROFILE" \
  "https://weread.qq.com/"

cat <<EOF
已启动 We-Read 专用 Chrome（调试端口：$PORT）。
请在这个新打开的 Chrome 窗口中登录微信读书，并保持至少一个 weread.qq.com 标签页打开。
该专用配置目录位于：$PROFILE
EOF
