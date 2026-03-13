'use strict';

const fs = require('fs');
const path = require('path');

// ─── JSON 文件存储 ───
// 零原生依赖，<50 用户完全够用
// 生产 50+ 用户时迁移到 better-sqlite3 (需服务器上编译)

const DATA_DIR = path.join(__dirname, '..', 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const USAGE_FILE = path.join(DATA_DIR, 'usage.jsonl');

// ❺ 确保 data 目录存在
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// ─── ❺ 写操作互斥锁 — 防止并发 read-modify-write 竞态 ───

let _locked = false;
const _waiters = [];

function _acquireLock() {
  return new Promise(resolve => {
    if (!_locked) {
      _locked = true;
      resolve();
    } else {
      _waiters.push(resolve);
    }
  });
}

function _releaseLock() {
  if (_waiters.length > 0) {
    const next = _waiters.shift();
    next();
  } else {
    _locked = false;
  }
}

async function withWriteLock(fn) {
  await _acquireLock();
  try {
    return fn();
  } finally {
    _releaseLock();
  }
}

// ─── 用户存储 ───

function loadUsers() {
  if (!fs.existsSync(USERS_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
  } catch {
    return [];
  }
}

function saveUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), 'utf8');
}

let _nextId = null;

function getNextId(users) {
  if (_nextId === null) {
    _nextId = users.reduce((max, u) => Math.max(max, u.id), 0);
  }
  return ++_nextId;
}

async function createUser(email, passwordHash) {
  return withWriteLock(() => {
    const users = loadUsers();
    const id = getNextId(users);
    const user = {
      id,
      email,
      password: passwordHash,
      api_key_enc: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    users.push(user);
    saveUsers(users);
    return { lastInsertRowid: id };
  });
}

function findUserByEmail(email) {
  const users = loadUsers();
  return users.find(u => u.email === email) || null;
}

function findUserById(id) {
  const users = loadUsers();
  const u = users.find(u => u.id === id);
  if (!u) return null;
  return { id: u.id, email: u.email, api_key_enc: u.api_key_enc, created_at: u.created_at };
}

async function updateApiKey(userId, encryptedKey) {
  return withWriteLock(() => {
    const users = loadUsers();
    const user = users.find(u => u.id === userId);
    if (user) {
      user.api_key_enc = encryptedKey;
      user.updated_at = new Date().toISOString();
      saveUsers(users);
    }
  });
}

// ─── #7 用量记录 (JSONL append-only + 按日期轮转) ───

function getUsageFile() {
  // 按日期轮转: usage-2026-03-13.jsonl
  const date = new Date().toISOString().slice(0, 10);
  return path.join(DATA_DIR, `usage-${date}.jsonl`);
}

function logUsage(userId, endpoint, tokensIn = 0, tokensOut = 0, model = '', latencyMs = 0) {
  const entry = {
    user_id: userId,
    endpoint,
    tokens_in: tokensIn,
    tokens_out: tokensOut,
    model,
    latency_ms: latencyMs,
    created_at: new Date().toISOString(),
  };
  const file = getUsageFile();
  // 异步追加，不阻塞事件循环
  fs.appendFile(file, JSON.stringify(entry) + '\n', 'utf8', (err) => {
    if (err) process.stderr.write(`用量记录写入失败: ${err.message}\n`);
  });
}

function getUserUsage(userId, days = 30) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const cutoffStr = cutoff.toISOString();
  const byDate = {};

  // 读取所有 usage 文件 (旧格式 usage.jsonl + 新格式 usage-YYYY-MM-DD.jsonl)
  const files = fs.readdirSync(DATA_DIR).filter(f => f.startsWith('usage') && f.endsWith('.jsonl'));
  for (const file of files) {
    const filePath = path.join(DATA_DIR, file);
    let content;
    try { content = fs.readFileSync(filePath, 'utf8'); } catch { continue; }
    const lines = content.trim().split('\n').filter(Boolean);

    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry.user_id !== userId || entry.created_at < cutoffStr) continue;
        const date = entry.created_at.slice(0, 10);
        if (!byDate[date]) byDate[date] = { date, requests: 0, total_tokens_in: 0, total_tokens_out: 0 };
        byDate[date].requests++;
        byDate[date].total_tokens_in += entry.tokens_in || 0;
        byDate[date].total_tokens_out += entry.tokens_out || 0;
      } catch { /* 跳过损坏行 */ }
    }
  }

  return Object.values(byDate).sort((a, b) => b.date.localeCompare(a.date));
}

// ─── #10 管理接口辅助 ───

function listAllUsers() {
  return loadUsers().map(u => ({
    id: u.id,
    email: u.email,
    hasApiKey: !!u.api_key_enc,
    createdAt: u.created_at,
  }));
}

function getSystemStats() {
  const users = loadUsers();
  // 统计今日用量
  const todayFile = getUsageFile();
  let todayRequests = 0;
  if (fs.existsSync(todayFile)) {
    todayRequests = fs.readFileSync(todayFile, 'utf8').trim().split('\n').filter(Boolean).length;
  }
  return {
    totalUsers: users.length,
    usersWithApiKey: users.filter(u => !!u.api_key_enc).length,
    todayRequests,
  };
}

function closeDb() {
  // JSON 文件无需关闭
}

module.exports = {
  createUser,
  findUserByEmail,
  findUserById,
  updateApiKey,
  logUsage,
  getUserUsage,
  listAllUsers,
  getSystemStats,
  closeDb,
};
