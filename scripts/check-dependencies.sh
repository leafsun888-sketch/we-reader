#!/usr/bin/env bash
set -euo pipefail

PROJECT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
failed=0

check_node() {
  if ! command -v node >/dev/null 2>&1; then
    echo "✗ Node.js：未安装（需要 18+）" >&2; failed=1; return
  fi
  local major
  major="$(node -p 'process.versions.node.split(".")[0]')"
  if [[ "$major" -lt 18 ]]; then
    echo "✗ Node.js：当前 $(node --version)，需要 18+" >&2; failed=1; return
  fi
  echo "✓ Node.js：$(node --version)"
}

check_python() {
  local python="${WE_READER_PYTHON:-python3}"
  if ! "$python" --version >/dev/null 2>&1 && [[ -z "${WE_READER_PYTHON:-}" ]] && command -v uv >/dev/null 2>&1; then
    for version in 3.12 3.11 3.13; do
      local candidate
      candidate="$(uv python find "$version" 2>/dev/null || true)"
      if [[ -n "$candidate" ]] && "$candidate" --version >/dev/null 2>&1; then
        python="$candidate"
        break
      fi
    done
  fi
  if ! "$python" --version >/dev/null 2>&1; then
    echo "✗ Python 3：找不到可运行解释器（正文归档需要 Python 3）。可安装 Python 3.11+，或设置 WE_READER_PYTHON=/path/to/python3。" >&2
    failed=1
    return
  fi
  echo "✓ Python：$($python --version)"
  if [[ -z "${WE_READER_PYTHON:-}" && "$python" != "python3" ]]; then
    echo "  提示：启动器会自动使用 $python；直接运行 fetcher 时可设置 WE_READER_PYTHON。"
  fi
}

check_converter() {
  if [[ ! -f "$PROJECT/fetcher/vendor/readgzh.py" ]]; then
    echo "✗ 正文转换器：缺少 fetcher/vendor/readgzh.py" >&2; failed=1; return
  fi
  echo "✓ 正文转换器：已随仓库提供"
}

check_chrome() {
  if [[ "$(uname -s)" == "Darwin" ]]; then
    if [[ -d "/Applications/Google Chrome.app" ]]; then
      echo "✓ Google Chrome：已安装（运行 ./scripts/start-chrome-debug.sh 后登录微信读书）"
    else
      echo "✗ Google Chrome：未安装" >&2; failed=1
    fi
  elif command -v google-chrome >/dev/null 2>&1 || command -v chromium >/dev/null 2>&1; then
    echo "✓ Chrome/Chromium：已安装"
  else
    echo "✗ Chrome/Chromium：未找到" >&2; failed=1
  fi
}

check_node
check_python
check_converter
check_chrome
exit "$failed"
