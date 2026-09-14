#!/bin/bash
# MusicHub 测试阶段启动脚本：安装依赖 + 启动后端
# 用法：在容器内执行  bash /app/scripts/start-frontend.sh
set -e

# 脚本位于 app/scripts/ 下，backend 在上级的 backend/
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BACKEND_DIR="$(cd "$SCRIPT_DIR/../backend" && pwd)"
echo "=========================================="
echo "MusicHub 启动脚本 (测试阶段)"
echo "后端目录: $BACKEND_DIR"
echo "=========================================="

cd "$BACKEND_DIR"

# 预检查：sqlite3 是否可用（不可用则先尝试自动编译，仍失败才提示手动操作）
if ! node -e "require('sqlite3')" >/dev/null 2>&1; then
  echo "[提示] 检测到 sqlite3 未就绪，尝试在容器内自动重新编译..."
  # 关键：node-gyp 拉 Node 头文件走国内镜像，否则在国内网络下编译必失败
  # 注意：npmmirror 二进制镜像正确前缀是 /-/binary/node（旧 /mirrors/node 会 404）
  export npm_config_build_from_source=true
  export npm_config_disturl=https://registry.npmmirror.com/-/binary/node
  if npm rebuild sqlite3 >/dev/null 2>&1 && node -e "require('sqlite3')" >/dev/null 2>&1; then
    echo "[提示] sqlite3 已重新编译并通过校验，继续执行。"
  else
    echo "[失败] 自动编译未成功，请先在容器内手动执行以下命令："
    echo "       cd /app/backend"
    echo "       npm config set build-from-source true"
    echo "       npm config set disturl https://registry.npmmirror.com/-/binary/node"
    echo "       npm rebuild sqlite3"
    echo "       （编译工具已在镜像内，按上面顺序执行即可）"
    exit 1
  fi
fi

# 1. 安装依赖
echo "[1/2] 安装 npm 依赖..."
npm install --registry=https://registry.npmmirror.com

# 2. 启动
echo "[2/2] 启动后端服务 (端口 ${PORT:-8000})..."
echo "      访问 http://<容器IP>:${PORT:-8000}"
echo "=========================================="
exec node server.js
