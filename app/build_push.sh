#!/bin/bash
#clearLog=true
#noParity=true
#argumentDescription=请输入要构建推送的版本号
#argumentDefault=1.0.0

# ====================== 配置部分 ======================
HUB_USER="gldl137"
# 自动定位项目目录：build_push.sh 本身就在 app/ 目录下，直接以其所在目录为构建上下文
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IMAGE_NAME="musichub"
VERSION="${1:-2.0.0}"                       # 版本号: 插件参数优先, 缺省用默认(2.0.0)

# ====================== 校验 ======================
echo "[$(date +"%Y-%m-%d %H:%M:%S")] === 构建推送开始: 版本 $VERSION ==="
echo "[$(date +"%Y-%m-%d %H:%M:%S")] 项目目录: $APP_DIR"

if [ ! -d "$APP_DIR" ]; then
    echo "[$(date +"%Y-%m-%d %H:%M:%S")] [ERROR] 项目目录不存在: $APP_DIR，退出"
    exit 1
fi
if [ ! -f "$APP_DIR/Dockerfile" ]; then
    echo "[$(date +"%Y-%m-%d %H:%M:%S")] [ERROR] $APP_DIR/Dockerfile 不存在，退出"
    exit 1
fi

# 检查是否已登录 DockerHub
if [ ! -f "/root/.docker/config.json" ]; then
    echo "[$(date +"%Y-%m-%d %H:%M:%S")] [ERROR] 尚未登录 DockerHub，请先运行 docker_login 脚本，退出"
    exit 1
fi

# 检查前端产物（MusicHub 前端为纯静态文件，由 backend 直接 serve frontend/）
if [ ! -f "$APP_DIR/frontend/index.html" ]; then
    echo "[$(date +"%Y-%m-%d %H:%M:%S")] [WARN] 前端产物 $APP_DIR/frontend/index.html 不存在，镜像将不含前端页面"
fi

# ====================== 执行 ======================
cd "$APP_DIR" || { echo "[ERROR] 无法进入 $APP_DIR"; exit 1; }

echo "[$(date +"%Y-%m-%d %H:%M:%S")] 【1】docker build -> $HUB_USER/$IMAGE_NAME:$VERSION"
docker build -t "$HUB_USER/$IMAGE_NAME:$VERSION" . || { echo "[ERROR] 构建失败"; exit 1; }

echo "[$(date +"%Y-%m-%d %H:%M:%S")] 【2】docker push -> $HUB_USER/$IMAGE_NAME:$VERSION"
docker push "$HUB_USER/$IMAGE_NAME:$VERSION" || { echo "[ERROR] 推送失败"; exit 1; }

echo ""
echo "[$(date +"%Y-%m-%d %H:%M:%S")] ✅ 完成: $HUB_USER/$IMAGE_NAME:$VERSION"
docker images "$HUB_USER/$IMAGE_NAME"
