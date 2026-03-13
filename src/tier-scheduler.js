'use strict';

// ─── 套餐到期自动降级调度器 ───
// 每小时检查一次，过期用户自动降级到 free

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');

let _timer = null;

function loadUsers() {
  if (!fs.existsSync(USERS_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); } catch { return []; }
}

function saveUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), 'utf8');
}

/**
 * 扫描并降级过期用户
 * @returns {{ checked: number, downgraded: string[] }}
 */
function checkExpiredTiers() {
  const now = new Date().toISOString();
  const users = loadUsers();
  const downgraded = [];

  for (const user of users) {
    if (!user.tier || user.tier === 'free') continue;
    if (!user.tier_expires_at) continue;
    if (user.tier_expires_at < now) {
      const oldTier = user.tier;
      user.tier = 'free';
      user.tier_expires_at = null;
      user.updated_at = now;
      downgraded.push(`${user.email} (${oldTier} → free)`);
    }
  }

  if (downgraded.length > 0) {
    saveUsers(users);
    const entry = {
      ts: now,
      event: 'tier_expiry_downgrade',
      count: downgraded.length,
      users: downgraded,
    };
    // 写入日志
    const logFile = path.join(DATA_DIR, 'tier-events.jsonl');
    fs.appendFileSync(logFile, JSON.stringify(entry) + '\n', 'utf8');
  }

  return { checked: users.length, downgraded };
}

/**
 * 启动定时检查 (默认每小时)
 */
function startScheduler(intervalMs = 3600_000) {
  // 启动时立即检查一次
  const result = checkExpiredTiers();
  if (result.downgraded.length > 0) {
    process.stdout.write(JSON.stringify({
      ts: new Date().toISOString(),
      level: 'info',
      msg: '套餐到期降级',
      count: result.downgraded.length,
      users: result.downgraded,
    }) + '\n');
  }

  // 定时检查
  _timer = setInterval(() => {
    try {
      const r = checkExpiredTiers();
      if (r.downgraded.length > 0) {
        process.stdout.write(JSON.stringify({
          ts: new Date().toISOString(),
          level: 'info',
          msg: '套餐到期降级',
          count: r.downgraded.length,
        }) + '\n');
      }
    } catch (err) {
      process.stderr.write(`套餐调度器错误: ${err.message}\n`);
    }
  }, intervalMs);

  _timer.unref(); // 不阻止进程退出
}

function stopScheduler() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}

module.exports = { checkExpiredTiers, startScheduler, stopScheduler };
