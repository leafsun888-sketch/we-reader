#!/usr/bin/env bash
set -euo pipefail

PROJECT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# macOS 上 /usr/bin/python3 可能只是要求安装/接受 Xcode 的占位程序。
# 如果用户没显式指定解释器，优先自动选一个 uv 已安装的可运行 Python。
if [[ -z "${WE_READER_PYTHON:-}" ]] && ! python3 --version >/dev/null 2>&1 && command -v uv >/dev/null 2>&1; then
  for version in 3.12 3.11 3.13; do
    candidate="$(uv python find "$version" 2>/dev/null || true)"
    if [[ -n "$candidate" ]] && "$candidate" --version >/dev/null 2>&1; then
      export WE_READER_PYTHON="$candidate"
      break
    fi
  done
fi
"$PROJECT/scripts/check-dependencies.sh"
if [[ "${1:-}" == "--check" ]]; then
  exit 0
fi
cd "$PROJECT/app"
exec node server.mjs
