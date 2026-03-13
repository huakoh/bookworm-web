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
const { register, login, requireAuth, verifyToken, refreshAccessToken } = require('./src/auth');
const { encrypt, decrypt } = require('./src/crypto-utils');
const { route, listSkills, getIndexMeta } = require('./src/router-engine');
const { proxyChat } = require('./src/proxy');
const { RateLimiter } = require('./src/rate-limiter');
const { findUserById, updateApiKey, logUsage, getUserUsage, listAllUsers, getSystemStats, closeDb } = require('./src/db');
const { LoginGuard } = require('./src/login-guard');
const { Metrics } = require('./src/metrics');
const { handleUpgrade } = require('./src/ws-handler');
const { detectProvider, getProviderConfig, sendLLMRequest, PROVIDERS } = require('./src/llm-router');

// ─── 配置 ───
const PORT = parseInt(process.env.PORT) || 3211;
const MAX_BODY = parseInt(process.env.MAX_BODY_SIZE) || 524288; // 512KB
const RPM = parseInt(process.env.RATE_LIMIT_RPM) || 30;
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const METRICS_ENABLED = process.env.METRICS_ENABLED !== 'false';

const limiter = new RateLimiter(RPM, 60_000);
const loginGuard = new LoginGuard();
const metrics = new Metrics();
const startTime = Date.now();

// ─── 静态文件目录 ───
const PUBLIC_DIR = path.join(__dirname, 'public');

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
  if (res.headersSent) return;
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

const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const LOG_LEVEL = LOG_LEVELS[process.env.LOG_LEVEL || 'info'] || 1;

function log(level, msg, meta = {}) {
  if ((LOG_LEVELS[level] || 0) < LOG_LEVEL) return;
  const entry = { ts: new Date().toISOString(), level, msg, ...meta };
  process.stdout.write(JSON.stringify(entry) + '\n');
}

// ─── #10 管理员认证 ───

function requireAdmin(req) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Admin ')) {
    throw { status: 401, message: '缺少管理员 Token' };
  }
  if (!ADMIN_TOKEN) {
    throw { status: 503, message: '管理员功能未配置 (ADMIN_TOKEN)' };
  }
  if (auth.slice(6) !== ADMIN_TOKEN) {
    throw { status: 403, message: '管理员 Token 无效' };
  }
}

// ─── #3 静态文件服务 ───

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function serveStatic(req, res) {
  // 剥离 query string，避免 /?_v=2 无法匹配静态文件
  const cleanUrl = req.url.split('?')[0];
  let filePath = path.join(PUBLIC_DIR, cleanUrl === '/' ? 'index.html' : cleanUrl);
  // 安全: 防止路径穿越
  filePath = path.normalize(filePath);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    json(res, 403, { error: '禁止访问' });
    return true;
  }
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    return false; // 非静态文件，继续 API 路由
  }
  const ext = path.extname(filePath);
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';
  const content = fs.readFileSync(filePath);
  // HTML 不缓存 (确保用户总是拿到最新版), 其他静态资源缓存 1h
  const cacheControl = ext === '.html' ? 'no-cache, no-store, must-revalidate' : 'public, max-age=3600';
  res.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': content.length,
    'Cache-Control': cacheControl,
    ...corsHeaders(),
  });
  res.end(content);
  return true;
}

// ─── 路由表 ───

const routes = {};

// CORS 预检
routes['OPTIONS:*'] = (req, res) => {
  res.writeHead(204, { ...corsHeaders(), 'Access-Control-Max-Age': '86400' });
  res.end();
};

// 健康检查
routes['GET:/health'] = (req, res) => {
  let indexStatus = 'ok';
  let indexMeta = {};
  try { indexMeta = getIndexMeta(); } catch (e) { indexStatus = 'error: ' + e.message; }

  if (METRICS_ENABLED) {
    metrics.setGauge('uptime_seconds', Math.floor((Date.now() - startTime) / 1000));
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

// ─── #11 Prometheus 指标端点 ───

routes['GET:/metrics'] = (req, res) => {
  if (!METRICS_ENABLED) {
    json(res, 404, { error: '指标功能未启用' });
    return;
  }
  metrics.setGauge('uptime_seconds', Math.floor((Date.now() - startTime) / 1000));
  const body = metrics.serialize();
  res.writeHead(200, {
    'Content-Type': 'text/plain; version=0.0.4; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
};

// ─── 认证端点 ───

routes['POST:/v1/register'] = async (req, res) => {
  const body = await parseJsonBody(req);
  const result = await register(body.email, body.password);
  log('info', '用户注册', { email: body.email, userId: result.id });
  if (METRICS_ENABLED) metrics.incCounter('auth_events_total', { event: 'register' });
  json(res, 201, { ok: true, ...result });
};

routes['POST:/v1/login'] = async (req, res) => {
  const body = await parseJsonBody(req);
  const { email, password } = body;

  // #6 暴力破解防护
  const guardCheck = loginGuard.check(email || '');
  if (guardCheck.locked) {
    if (METRICS_ENABLED) metrics.incCounter('auth_events_total', { event: 'login_locked' });
    throw {
      status: 429,
      message: `登录尝试过多，请 ${Math.ceil(guardCheck.retryAfterMs / 60000)} 分钟后重试`,
    };
  }

  try {
    const result = await login(email, password);
    loginGuard.recordSuccess(email);
    log('info', '用户登录', { email });
    if (METRICS_ENABLED) metrics.incCounter('auth_events_total', { event: 'login_success' });
    json(res, 200, { ok: true, ...result });
  } catch (err) {
    if (err.status === 401) {
      loginGuard.recordFailure(email || '');
      if (METRICS_ENABLED) metrics.incCounter('auth_events_total', { event: 'login_fail' });
    }
    throw err;
  }
};

// ─── #9 Token 刷新 ───

routes['POST:/v1/token/refresh'] = async (req, res) => {
  const body = await parseJsonBody(req);
  const result = refreshAccessToken(body.refreshToken);
  json(res, 200, { ok: true, ...result });
};

// ─── 用户信息 ───

routes['GET:/v1/me'] = async (req, res) => {
  const userId = requireAuth(req);
  const user = findUserById(userId);
  // 返回各 provider 的 API Key 配置状态
  let apiKeys = {};
  if (user.api_key_enc && typeof user.api_key_enc === 'object') {
    for (const [prov, enc] of Object.entries(user.api_key_enc)) {
      apiKeys[prov] = !!enc;
    }
  } else if (user.api_key_enc) {
    apiKeys = { anthropic: true };
  }
  json(res, 200, {
    id: user.id,
    email: user.email,
    hasApiKey: Object.values(apiKeys).some(v => v),
    apiKeys,
    createdAt: user.created_at,
  });
};

routes['PUT:/v1/me/key'] = async (req, res) => {
  const userId = requireAuth(req);
  const body = await parseJsonBody(req);
  const { apiKey, provider } = body;

  if (!apiKey) throw { status: 400, message: '缺少 apiKey 字段' };
  if (apiKey.length < 8) throw { status: 400, message: 'API Key 太短' };

  // 验证 provider (可选)
  const validProviders = ['anthropic', 'openai', 'qwen', 'deepseek'];
  const prov = provider && validProviders.includes(provider) ? provider : null;

  const encrypted = encrypt(apiKey);
  await updateApiKey(userId, encrypted, prov);
  log('info', 'API Key 更新', { userId, provider: prov || 'default' });
  json(res, 200, { ok: true, provider: prov || 'default', message: 'API Key 已安全加密存储' });
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
  logUsage(userId, '/v1/route', text.length, 0, '', result.latencyMs);

  if (METRICS_ENABLED) metrics.incCounter('route_queries_total', { primary: result.primary });

  log('info', '路由分析', {
    userId, primary: result.primary,
    confidence: result.confidence, latencyMs: result.latencyMs,
  });
  json(res, 200, { ok: true, ...result });
};

// ─── 技能列表 ───

routes['GET:/v1/skills'] = async (req, res) => {
  requireAuth(req);
  const skills = listSkills();
  json(res, 200, { count: skills.length, skills });
};

// ─── #13 Provider 列表 ───

routes['GET:/v1/providers'] = async (req, res) => {
  requireAuth(req);
  const providers = Object.entries(PROVIDERS).map(([name, config]) => ({
    name,
    models: config.modelPrefixes,
    baseUrl: config.baseUrl,
  }));
  json(res, 200, { count: providers.length, providers });
};

// ─── Claude / 多 LLM API 透传 (BYOK) ───

async function resolveApiKey(userId, body) {
  // 优先用请求中传入的 Key (即时 BYOK)
  if (body.apiKey || body.api_key) {
    const key = body.apiKey || body.api_key;
    if (key.length < 8) throw { status: 400, message: 'API Key 格式错误' };
    return key;
  }
  // 否则用已存储的加密 Key
  const user = findUserById(userId);
  if (!user?.api_key_enc) {
    throw { status: 400, message: '未配置 API Key，请先在设置中保存 API Key' };
  }

  // 多 Provider Key: 根据 model 自动选择对应 provider 的 key
  const model = body.model || '';
  const providerName = detectProvider(model);

  if (typeof user.api_key_enc === 'object' && user.api_key_enc !== null) {
    // 优先取对应 provider 的 key，回退到 anthropic 或第一个可用 key
    const key = user.api_key_enc[providerName]
      || user.api_key_enc.anthropic
      || Object.values(user.api_key_enc).find(v => v);
    if (!key) throw { status: 400, message: `未配置 ${providerName} 的 API Key` };
    return decrypt(key);
  }
  // 兼容旧格式 (单字符串)
  return decrypt(user.api_key_enc);
}

routes['POST:/v1/chat'] = async (req, res) => {
  const userId = requireAuth(req);
  const body = await parseJsonBody(req);
  const apiKey = await resolveApiKey(userId, body);
  const model = body.model || 'claude-sonnet-4-5-20250514';

  // #13 自动检测 provider
  const providerName = detectProvider(model);
  const startMs = Date.now();

  if (METRICS_ENABLED) metrics.incCounter('chat_requests_total', { model, stream: 'false' });

  if (providerName === 'anthropic' && !body.base_url && !body.baseUrl) {
    // Anthropic: 用原有 proxy (支持 SSRF 防护)
    const result = await proxyChat({
      apiKey, model,
      messages: body.messages,
      maxTokens: body.max_tokens || body.maxTokens,
      stream: false,
      baseUrl: body.base_url || body.baseUrl,
      systemPrompt: body.system,
    }, res);

    const latencyMs = Date.now() - startMs;
    const usage = result.data?.usage || {};
    logUsage(userId, '/v1/chat', usage.input_tokens || 0, usage.output_tokens || 0, model, latencyMs);
    log('info', 'Chat 完成', { userId, model, provider: 'anthropic', latencyMs });

    if (result.status >= 400) {
      json(res, 502, { error: '上游 API 返回错误', upstream_status: result.status, detail: result.data });
    } else {
      json(res, result.status, result.data);
    }
  } else {
    // 其他 provider: 用 llm-router
    const config = getProviderConfig(providerName, body.base_url || body.baseUrl);
    const reqBody = config.buildBody({
      model,
      messages: body.messages,
      maxTokens: body.max_tokens || body.maxTokens,
      stream: false,
      systemPrompt: body.system,
    });

    const result = await sendLLMRequest(
      { name: providerName, baseUrl: config.baseUrl },
      apiKey, reqBody, res, false
    );

    const latencyMs = Date.now() - startMs;
    const usage = config.parseUsage(result.data);
    logUsage(userId, '/v1/chat', usage.input_tokens, usage.output_tokens, model, latencyMs);
    log('info', 'Chat 完成', { userId, model, provider: providerName, latencyMs });

    if (result.status >= 400) {
      json(res, 502, { error: '上游 API 返回错误', upstream_status: result.status, detail: result.data });
    } else {
      json(res, result.status, result.data);
    }
  }
};

routes['POST:/v1/chat/stream'] = async (req, res) => {
  const userId = requireAuth(req);
  const body = await parseJsonBody(req);
  const apiKey = await resolveApiKey(userId, body);
  const model = body.model || 'claude-sonnet-4-5-20250514';
  const providerName = detectProvider(model);
  const startMs = Date.now();

  if (METRICS_ENABLED) metrics.incCounter('chat_requests_total', { model, stream: 'true' });

  log('info', 'Chat 流式开始', { userId, model, provider: providerName });

  if (providerName === 'anthropic' && !body.base_url && !body.baseUrl) {
    const result = await proxyChat({
      apiKey, model,
      messages: body.messages,
      maxTokens: body.max_tokens || body.maxTokens,
      stream: true,
      baseUrl: body.base_url || body.baseUrl,
      systemPrompt: body.system,
    }, res);

    const latencyMs = Date.now() - startMs;
    logUsage(userId, '/v1/chat/stream', 0, 0, model, latencyMs);

    if (result && !result.streamed && !res.headersSent) {
      json(res, 502, { error: '上游 API 返回错误', upstream_status: result.status, detail: result.data });
    }
  } else {
    const config = getProviderConfig(providerName, body.base_url || body.baseUrl);
    const reqBody = config.buildBody({
      model,
      messages: body.messages,
      maxTokens: body.max_tokens || body.maxTokens,
      stream: true,
      systemPrompt: body.system,
    });

    const result = await sendLLMRequest(
      { name: providerName, baseUrl: config.baseUrl },
      apiKey, reqBody, res, true
    );

    const latencyMs = Date.now() - startMs;
    logUsage(userId, '/v1/chat/stream', 0, 0, model, latencyMs);

    if (result && !result.streamed && !res.headersSent) {
      json(res, 502, { error: '上游 API 返回错误', upstream_status: result.status, detail: result.data });
    }
  }
};

// ─── #10 管理端点 ───

routes['GET:/v1/admin/users'] = async (req, res) => {
  requireAdmin(req);
  const users = listAllUsers();
  json(res, 200, { count: users.length, users });
};

routes['GET:/v1/admin/stats'] = async (req, res) => {
  requireAdmin(req);
  const stats = getSystemStats();
  json(res, 200, {
    ...stats,
    uptime: Math.floor((Date.now() - startTime) / 1000),
    memory: {
      rss: Math.round(process.memoryUsage().rss / 1024 / 1024) + 'MB',
      heap: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + 'MB',
    },
  });
};

// ─── HTTP 服务器 ───

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const method = req.method.toUpperCase();
  const pathname = url.pathname;
  const clientIp = getClientIp(req);
  const reqStart = Date.now();

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

  // #3 静态文件优先 (GET 请求且非 /v1/ /health /metrics 路径)
  if (method === 'GET' && !pathname.startsWith('/v1/') && pathname !== '/health' && pathname !== '/metrics') {
    if (serveStatic(req, res)) return;
  }

  // API 路由匹配
  const routeKey = `${method}:${pathname}`;
  const handler = routes[routeKey];

  if (!handler) {
    json(res, 404, { error: `未知端点: ${method} ${pathname}` });
    return;
  }

  try {
    await handler(req, res);
  } catch (err) {
    if (err.status) {
      json(res, err.status, { error: err.message });
    } else {
      log('error', '请求处理失败', { method, path: pathname, error: err.message });
      json(res, 500, { error: '服务器内部错误' });
    }
  } finally {
    // #11 请求指标
    if (METRICS_ENABLED) {
      const latency = Date.now() - reqStart;
      const status = res.statusCode || 500;
      metrics.incCounter('http_requests_total', { method, path: pathname, status: String(status) });
      metrics.observeHistogram('http_request_duration_ms', { method, path: pathname }, latency);
    }
  }
});

// ─── #12 WebSocket upgrade 处理 ───

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/ws') {
    handleUpgrade(req, socket, head, verifyToken);
  } else {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
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
  ║  Metrics: ${String(METRICS_ENABLED).padEnd(35)}║
  ║  WebSocket: /ws                             ║
  ║  Admin: ${ADMIN_TOKEN ? 'configured' : 'not configured    '}              ║
  ╚══════════════════════════════════════════════╝
  `);
});

// ─── 优雅关闭 ───

function gracefulShutdown(signal) {
  log('info', `收到 ${signal}，正在关闭...`);
  const forceTimer = setTimeout(() => {
    log('warn', '优雅关闭超时，强制退出');
    process.exit(1);
  }, 10_000);
  forceTimer.unref();

  server.close(() => {
    closeDb();
    limiter.destroy();
    loginGuard.destroy();
    process.exit(0);
  });
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

process.on('uncaughtException', (err) => {
  log('error', '未捕获异常，进程即将退出', { error: err.message });
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  log('error', '未处理的 Promise 拒绝', { reason: String(reason) });
});
