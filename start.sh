#!/bin/zsh
set -euo pipefail
cd "${0:A:h}/app"
exec node server.mjs
