#!/usr/bin/env bash
set -Eeuo pipefail
cd -- "$(dirname -- "$(realpath -- "$0")")"
command -v node >/dev/null || { echo '请安装 Node.js 24 LTS。' >&2; exit 1; }
node -e 'if (Number(process.versions.node.split(".")[0]) < 24) process.exit(1)' || { echo '需要 Node.js 24 LTS。' >&2; exit 1; }
[[ -f .env ]] || { echo '缺少 .env，请复制 .env.example 并填写真实配置。' >&2; exit 1; }
if [[ ! -d node_modules/sharp || ! -d node_modules/bcryptjs ]]; then
    if [[ -f package-lock.json ]]; then npm ci --omit=dev; else npm install --omit=dev; fi
fi
export PORT="${PORT:-8000}"
export HOST="${HOST:-127.0.0.1}"
export LOCAL_DEV="${LOCAL_DEV:-0}"
export ALLOW_MOCK_PAYMENT=false
echo "Node.js 服务：http://127.0.0.1:${PORT}/web/index.html"
exec node backend-node/server.mjs
