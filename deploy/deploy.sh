#!/bin/bash
# Bookworm Web Service 部署脚本
# 用法: bash deploy/deploy.sh [setup|deploy|restart|logs|status]

set -euo pipefail

APP_NAME="bookworm-web"
APP_DIR="/opt/bookworm-web"
REPO_URL="git@github.com:YOUR_USER/bookworm-web.git"  # TODO: 替换
SERVER="root@8.138.11.105"

case "${1:-help}" in

  # 首次安装
  setup)
    echo ">>> 首次安装到 $SERVER"
    ssh "$SERVER" << 'EOF'
      # 创建应用目录
      mkdir -p /opt/bookworm-web/logs /opt/bookworm-web/data

      # 安装 Node.js 18+ (如未安装)
      if ! command -v node &> /dev/null; then
        curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
        apt-get install -y nodejs
      fi

      # 安装 PM2 (如未安装)
      if ! command -v pm2 &> /dev/null; then
        npm install -g pm2
        pm2 startup
      fi

      # 安装 build-essential (better-sqlite3 需要)
      apt-get install -y build-essential python3

      echo ">>> 安装完成，请上传代码"
EOF
    ;;

  # 部署代码
  deploy)
    echo ">>> 部署到 $SERVER"
    # 打包 (排除 node_modules 和 data)
    tar czf /tmp/bookworm-web.tar.gz \
      --exclude='node_modules' \
      --exclude='data/*.db*' \
      --exclude='.env' \
      --exclude='.git' \
      -C "$(dirname "$(dirname "$0")")" .

    # 上传
    scp /tmp/bookworm-web.tar.gz "$SERVER:/tmp/"

    # 远程解压并重启
    ssh "$SERVER" << EOF
      cd $APP_DIR
      tar xzf /tmp/bookworm-web.tar.gz
      npm install --production

      # 如果 .env 不存在，从模板创建
      if [ ! -f .env ]; then
        cp env.example .env
        echo ">>> 请编辑 $APP_DIR/.env 配置密钥"
      fi

      # 启动/重启 PM2
      pm2 startOrRestart deploy/ecosystem.config.js
      pm2 save

      echo ">>> 部署完成"
      pm2 status
EOF
    rm -f /tmp/bookworm-web.tar.gz
    ;;

  # 重启
  restart)
    ssh "$SERVER" "cd $APP_DIR && pm2 reload $APP_NAME"
    ;;

  # 查看日志
  logs)
    ssh "$SERVER" "pm2 logs $APP_NAME --lines 50"
    ;;

  # 状态
  status)
    ssh "$SERVER" "pm2 status $APP_NAME && curl -sf http://localhost:3211/health | python3 -m json.tool"
    ;;

  *)
    echo "用法: $0 {setup|deploy|restart|logs|status}"
    exit 1
    ;;
esac
