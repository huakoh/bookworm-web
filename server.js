'use strict';

// ─── 环境变量加载 ───
const fs = require('fs');
const path = require('path');
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx > 0) {
      const key = trimmed.slice(0, idx).trim();
      // 剥离引号包裹的值
      let val = trimmed.slice(idx + 1).trim();
      val = val.replace(/^["'](.*)["']$/, '$1');
      if (!process.env[key]) process.env[key] = val;
    }
  }
}

const http = require('http');
const { register, login, requireAuth } = require('./src/auth');
const { encrypt, decrypt } = require('./src/crypto-utils');
const { route, listSkills, getIndexMeta } = require('./src/router-engine');
const { proxyChat } = require('./src/proxy');
const { RateLimiter } = require('./src/rate-limiter');
const { findUserById, updateApiKey, logUsage, getUserUsage, closeDb } = require('./src/db');

// ─── 配置 ───
const PORT = parseInt(process.env.PORT) || 3211;
const MAX_BODY = parseInt(process.env.MAX_BODY_SIZE) || 524288; // 512KB
const RPM = parseInt(process.env.RATE_LIMIT_RPM) || 30;

// ❻ CORS 白名单 — 默认 * (可通过 CORS_ORIGIN 配置逗号分隔的域名)
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';

const limiter = new RateLimiter(RPM, 60_000);
const startTime = Date.now();

// ─── 工具函数 ───

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let destroyed = false;
    req.on('data', (chunk) => {
      if (destroyed) return;
      size += chunk.length;
      if (size > MAX_BODY) {
        destroyed = true;
        reject({ status: 413, message: `请求体超过 ${MAX_BODY} 字节限制` });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!destroyed) resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', (err) => {
      if (!destroyed) reject(err);
    });
  });
}

// ❸ 统一 JSON body 解析 — SyntaxError → 400
async function parseJsonBody(req) {
  const raw = await readBody(req);
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw { status: 400, message: 'JSON 格式错误' };
  }
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': CORS_ORIGIN,
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  };
}

function json(res, code, data) {
  if (res.headersSent) return; // 防止重复发送
  const body = JSON.stringify(data);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    ...corsHeaders(),
  });
  res.end(body);
}

function getClientIp(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim()
    || req.headers['x-real-ip']
    || req.socket.remoteAddress
    || '0.0.0.0';
}

// 缓存日志级别，避免每次读取 env
const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const LOG_LEVEL = LOG_LEVELS[process.env.LOG_LEVEL || 'info'] || 1;

function log(level, msg, meta = {}) {
  if ((LOG_LEVELS[level] || 0) < LOG_LEVEL) return;
  const entry = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...meta,
  };
  process.stdout.write(JSON.stringify(entry) + '\n');
}

// ─── 路由表 ───

const routes = {};

// CORS 预检
routes['OPTIONS:*'] = (req, res) => {
  res.writeHead(204, {
    ...corsHeaders(),
    'Access-Control-Max-Age': '86400',
  });
  res.end();
};

// 欢迎页
routes['GET:/'] = (req, res) => {
  json(res, 200, {
    name: 'Bookworm Web Service',
    version: '1.0.0',
    mode: 'BYOK (Bring Your Own Key)',
    endpoints: {
      'POST /v1/register': '注册账户',
      'POST /v1/login': '登录获取 Token',
      'POST /v1/route': '智能路由分析 (核心)',
      'POST /v1/chat': 'Claude API 透传 (BYOK)',
      'POST /v1/chat/stream': 'Claude API 流式透传 (SSE)',
      'GET  /v1/skills': '技能列表',
      'GET  /v1/me': '用户信息',
      'PUT  /v1/me/key': '更新 API Key',
      'GET  /v1/me/usage': '用量统计',
      'GET  /health': '健康检查',
    },
  });
};

// 健康检查
routes['GET:/health'] = (req, res) => {
  let indexStatus = 'ok';
  let indexMeta = {};
  try {
    indexMeta = getIndexMeta();
  } catch (e) {
    indexStatus = 'error: ' + e.message;
  }

  json(res, 200, {
    status: 'ok',
    uptime: Math.floor((Date.now() - startTime) / 1000),
    index: { status: indexStatus, ...indexMeta },
    memory: {
      rss: Math.round(process.memoryUsage().rss / 1024 / 1024) + 'MB',
      heap: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + 'MB',
    },
    ts: new Date().toISOString(),
  });
};

// ─── 认证端点 ───

routes['POST:/v1/register'] = async (req, res) => {
  const body = await parseJsonBody(req);
  const result = await register(body.email, body.password);
  log('info', '用户注册', { email: body.email, userId: result.id });
  json(res, 201, { ok: true, ...result });
};

routes['POST:/v1/login'] = async (req, res) => {
  const body = await parseJsonBody(req);
  const result = await login(body.email, body.password);
  log('info', '用户登录', { email: body.email });
  json(res, 200, { ok: true, ...result });
};

// ─── 用户信息 ───

routes['GET:/v1/me'] = async (req, res) => {
  const userId = requireAuth(req);
  const user = findUserById(userId);
  json(res, 200, {
    id: user.id,
    email: user.email,
    hasApiKey: !!user.api_key_enc,
    createdAt: user.created_at,
  });
};

routes['PUT:/v1/me/key'] = async (req, res) => {
  const userId = requireAuth(req);
  const body = await parseJsonBody(req);
  const { apiKey } = body;

  if (!apiKey) throw { status: 400, message: '缺少 apiKey 字段' };
  if (!apiKey.startsWith('sk-ant-')) {
    throw { status: 400, message: 'API Key 格式错误，应以 sk-ant- 开头' };
  }

  const encrypted = encrypt(apiKey);
  await updateApiKey(userId, encrypted);
  log('info', 'API Key 更新', { userId });
  json(res, 200, { ok: true, message: 'API Key 已安全加密存储' });
};

routes['GET:/v1/me/usage'] = async (req, res) => {
  const userId = requireAuth(req);
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const days = parseInt(url.searchParams.get('days')) || 30;
  const usage = getUserUsage(userId, days);
  json(res, 200, { days, usage });
};

// ─── 核心路由 API ───

routes['POST:/v1/route'] = async (req, res) => {
  const userId = requireAuth(req);
  const body = await parseJsonBody(req);
  const { text } = body;

  if (!text || typeof text !== 'string') {
    throw { status: 400, message: '缺少 text 字段' };
  }

  const result = route(text);

  // 记录用量
  logUsage(userId, '/v1/route', text.length, 0, '', result.latencyMs);

  log('info', '路由分析', {
    userId,
    primary: result.primary,
    confidence: result.confidence,
    latencyMs: result.latencyMs,
  });

  json(res, 200, { ok: true, ...result });
};

// ─── 技能列表 ───

routes['GET:/v1/skills'] = async (req, res) => {
  requireAuth(req);
  const skills = listSkills();
  json(res, 200, { count: skills.length, skills });
};

// ─── Claude API 透传 (BYOK) ───

routes['POST:/v1/chat'] = async (req, res) => {
  const userId = requireAuth(req);
  const body = await parseJsonBody(req);

  // 获取用户 API Key
  const apiKey = await resolveApiKey(userId, body);

  const startMs = Date.now();
  const result = await proxyChat({
    apiKey,
    model: body.model,
    messages: body.messages,
    maxTokens: body.max_tokens || body.maxTokens,
    stream: false,
    baseUrl: body.base_url || body.baseUrl,
    systemPrompt: body.system,
  }, res);

  const latencyMs = Date.now() - startMs;

  // 记录用量 (从响应中提取 token 计数)
  const usage = result.data?.usage || {};
  logUsage(userId, '/v1/chat', usage.input_tokens || 0, usage.output_tokens || 0, body.model || '', latencyMs);

  log('info', 'Chat 完成', { userId, model: body.model, latencyMs });

  // 包装上游错误，区分 Bookworm 错误和 Anthropic 错误
  if (result.status >= 400) {
    json(res, 502, {
      error: '上游 API 返回错误',
      upstream_status: result.status,
      detail: result.data,
    });
  } else {
    json(res, result.status, result.data);
  }
};

routes['POST:/v1/chat/stream'] = async (req, res) => {
  const userId = requireAuth(req);
  const body = await parseJsonBody(req);

  const apiKey = await resolveApiKey(userId, body);

  const startMs = Date.now();
  log('info', 'Chat 流式开始', { userId, model: body.model });

  const result = await proxyChat({
    apiKey,
    model: body.model,
    messages: body.messages,
    maxTokens: body.max_tokens || body.maxTokens,
    stream: true,
    baseUrl: body.base_url || body.baseUrl,
    systemPrompt: body.system,
  }, res);

  const latencyMs = Date.now() - startMs;
  logUsage(userId, '/v1/chat/stream', 0, 0, body.model || '', latencyMs);

  // ❼ 如果上游返回错误（proxyChat 收集了 JSON 而非 SSE），需要发送 JSON 响应
  if (result && !result.streamed && !res.headersSent) {
    json(res, 502, {
      error: '上游 API 返回错误',
      upstream_status: result.status,
      detail: result.data,
    });
  }
};

// ─── 辅助函数 ───

async function resolveApiKey(userId, body) {
  // 优先用请求中传入的 Key (即时 BYOK)
  if (body.apiKey || body.api_key) {
    const key = body.apiKey || body.api_key;
    if (!key.startsWith('sk-ant-')) throw { status: 400, message: 'API Key 格式错误' };
    return key;
  }

  // 否则用已存储的加密 Key
  const user = findUserById(userId);
  if (!user?.api_key_enc) {
    throw { status: 400, message: '未配置 API Key，请先调用 PUT /v1/me/key 或在请求中传入 apiKey' };
  }

  return decrypt(user.api_key_enc);
}

// ─── HTTP 服务器 ───

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const method = req.method.toUpperCase();
  const pathname = url.pathname;
  const clientIp = getClientIp(req);

  // CORS 预检
  if (method === 'OPTIONS') {
    routes['OPTIONS:*'](req, res);
    return;
  }

  // 限流检查 (用 IP)
  const { allowed, remaining, resetMs } = limiter.check(clientIp);
  res.setHeader('X-RateLimit-Remaining', remaining);
  res.setHeader('X-RateLimit-Reset', Math.ceil(resetMs / 1000));
  if (!allowed) {
    json(res, 429, { error: '请求过于频繁，请稍后再试', retryAfter: Math.ceil(resetMs / 1000) });
    return;
  }

  // 路由匹配
  const routeKey = `${method}:${pathname}`;
  const handler = routes[routeKey];

  if (!handler) {
    json(res, 404, { error: `未知端点: ${method} ${pathname}` });
    return;
  }

  try {
    await handler(req, res);
  } catch (err) {
    // 业务错误 (带 status 字段)
    if (err.status) {
      json(res, err.status, { error: err.message });
      return;
    }
    // 系统错误 — 不暴露堆栈
    log('error', '请求处理失败', {
      method,
      path: pathname,
      error: err.message,
    });
    json(res, 500, { error: '服务器内部错误' });
  }
});

server.listen(PORT, () => {
  log('info', `Bookworm Web Service 启动`, { port: PORT, mode: 'BYOK' });
  console.log(`
  ╔══════════════════════════════════════════════╗
  ║  Bookworm Web Service v1.0.0                ║
  ║  Mode: BYOK (Bring Your Own Key)            ║
  ║  Port: ${String(PORT).padEnd(38)}║
  ║  CORS: ${CORS_ORIGIN.slice(0, 37).padEnd(38)}║
  ╚══════════════════════════════════════════════╝
  `);
});

// ─── ❽ 优雅关闭 + 强制超时 ───

function gracefulShutdown(signal) {
  log('info', `收到 ${signal}，正在关闭...`);
  // 强制退出兜底 (10s)
  const forceTimer = setTimeout(() => {
    log('warn', '优雅关闭超时，强制退出');
    process.exit(1);
  }, 10_000);
  forceTimer.unref();

  server.close(() => {
    closeDb();
    limiter.destroy();
    process.exit(0);
  });
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

// ❽ uncaughtException 后退出，让 PM2 重启
process.on('uncaughtException', (err) => {
  log('error', '未捕获异常，进程即将退出', { error: err.message });
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  log('error', '未处理的 Promise 拒绝', { reason: String(reason) });
});
