// PM2 进程管理配置
module.exports = {
  apps: [{
    name: 'bookworm-web',
    script: 'server.js',
    cwd: '/opt/bookworm-web',
    instances: 1,                 // 单进程 (JSON 文件存储，多进程会导致写入竞态)
    exec_mode: 'fork',
    watch: false,
    max_memory_restart: '512M',   // 内存超 512M 自动重启
    env: {
      NODE_ENV: 'production',
      PORT: 3211,
    },
    // 日志
    error_file: '/opt/bookworm-web/logs/error.log',
    out_file: '/opt/bookworm-web/logs/access.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    merge_logs: true,
    // 重启策略
    min_uptime: '10s',
    max_restarts: 10,
    restart_delay: 3000,
    // 优雅关闭
    kill_timeout: 5000,
    listen_timeout: 8000,
  }],
};
