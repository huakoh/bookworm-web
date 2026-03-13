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
const { findUserById, updateApiKey, updateUserTier, updateStorageUsed, getTodayChatCount, logUsage, getUserUsage, listAllUsers, getSystemStats, closeDb } = require('./src/db');
const quota = require('./src/quota');
const { LoginGuard } = require('./src/login-guard');
const { Metrics } = require('./src/metrics');
const { handleUpgrade } = require('./src/ws-handler');
const { detectProvider, getProviderConfig, sendLLMRequest, PROVIDERS } = require('./src/llm-router');
const fileManager = require('./src/file-manager');
const payment = require('./src/payment');
const { startScheduler, stopScheduler } = require('./src/tier-scheduler');
const inviteCodes = require('./src/invite-codes');

// ─── 配置 ───
const PORT = parseInt(process.env.PORT) || 3211;
const MAX_BODY = parseInt(process.env.MAX_BODY_SIZE) || 524288; // 512KB
const MAX_UPLOAD_BODY = 70 * 1024 * 1024; // 70MB (5 files * 10MB * 1.33 base64)
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

function readBody(req, limit) {
  const maxSize = limit || MAX_BODY;
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let destroyed = false;
    req.on('data', (chunk) => {
      if (destroyed) return;
      size += chunk.length;
      if (size > maxSize) {
        destroyed = true;
        reject({ status: 413, message: `请求体超过 ${Math.round(maxSize / 1024 / 1024)}MB 限制` });
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
  const tier = quota.getUserTier(user);
  const storageCheck = quota.checkStorageQuota(user);
  const todayChats = getTodayChatCount(userId);
  const chatCheck = quota.checkDailyChatQuota(user, todayChats);
  json(res, 200, {
    id: user.id,
    email: user.email,
    hasApiKey: Object.values(apiKeys).some(v => v),
    apiKeys,
    tier: { id: tier.id, name: tier.name, price: tier.price },
    quota: {
      storage: storageCheck,
      dailyChats: chatCheck,
    },
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

  // #7 智能模型推荐: 根据任务复杂度推荐最优模型
  let suggestedModel = null;
  if (result.complexity === 'complex') {
    suggestedModel = { model: 'claude-sonnet-4-5-20250514', reason: '复杂任务建议使用 Claude' };
  } else if (result.complexity === 'medium') {
    suggestedModel = { model: 'qwen-max', reason: '中等复杂度推荐 Qwen-Max' };
  } else {
    suggestedModel = { model: 'qwen-plus', reason: '简单任务推荐 Qwen-Plus (性价比最优)' };
  }

  log('info', '路由分析', {
    userId, primary: result.primary,
    confidence: result.confidence, latencyMs: result.latencyMs,
  });
  json(res, 200, { ok: true, ...result, suggestedModel });
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

// ─── #9 上下文窗口管理 ───
const MAX_CTX_TOKENS = { qwen: 120000, openai: 120000, anthropic: 180000, deepseek: 60000 };
function trimContext(messages, systemPrompt, providerName) {
  const ctxLimit = MAX_CTX_TOKENS[providerName] || 120000;
  let estTokens = ((systemPrompt || '').length / 3) | 0;
  const trimmed = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const content = typeof messages[i].content === 'string' ? messages[i].content : '';
    const msgTokens = (content.length / 3) | 0;
    if (estTokens + msgTokens > ctxLimit * 0.85) break;
    estTokens += msgTokens;
    trimmed.unshift(messages[i]);
  }
  if (trimmed.length === 0 && messages.length > 0) trimmed.push(messages[messages.length - 1]);
  return { trimmed, estTokens, truncated: trimmed.length < messages.length };
}

routes['POST:/v1/chat'] = async (req, res) => {
  const userId = requireAuth(req);
  const body = await parseJsonBody(req);

  // 配额检查: 每日对话
  const user = findUserById(userId);
  const todayChats = getTodayChatCount(userId);
  const chatCheck = quota.checkDailyChatQuota(user, todayChats);
  if (!chatCheck.allowed) throw { status: 403, message: chatCheck.message };

  const apiKey = await resolveApiKey(userId, body);
  const model = body.model || 'claude-sonnet-4-5-20250514';

  // #13 自动检测 provider
  const providerName = detectProvider(model);
  const startMs = Date.now();

  // ─── 技能 System Prompt 自动注入 ───
  let systemPrompt = body.system || '';
  if (!systemPrompt && body.messages && body.messages.length > 0) {
    const lastUserMsg = [...body.messages].reverse().find(m => m.role === 'user');
    if (lastUserMsg) {
      try {
        const routeResult = route(typeof lastUserMsg.content === 'string' ? lastUserMsg.content : '');
        if (routeResult.primary && routeResult.confidence >= 0.5) {
          const skill = listSkills().find(s => s.name === routeResult.primary);
          if (skill && skill.description) {
            systemPrompt = `你是 ${skill.name} 专家。${skill.description}\n请用中文回复，先给代码再解释。`;
            log('info', '技能注入', { userId, skill: routeResult.primary, confidence: routeResult.confidence });
          }
        }
      } catch { /* 路由失败不阻塞对话 */ }
    }
  }

  // #9 上下文截断
  const ctx = trimContext(body.messages, systemPrompt, providerName);
  if (ctx.truncated) log('info', '上下文截断', { userId, original: body.messages.length, kept: ctx.trimmed.length, estTokens: ctx.estTokens });
  body.messages = ctx.trimmed;

  // 多模态: 将含 fileIds 的消息转换为 LLM content 数组
  body.messages = body.messages.map(msg => {
    if (msg.fileIds && msg.fileIds.length > 0) {
      return { role: msg.role, content: fileManager.buildMultimodalContent(userId, msg, providerName) };
    }
    return msg;
  });

  if (METRICS_ENABLED) metrics.incCounter('chat_requests_total', { model, stream: 'false' });

  if (providerName === 'anthropic' && !body.base_url && !body.baseUrl) {
    // Anthropic: 用原有 proxy (支持 SSRF 防护)
    const result = await proxyChat({
      apiKey, model,
      messages: body.messages,
      maxTokens: body.max_tokens || body.maxTokens,
      stream: false,
      baseUrl: body.base_url || body.baseUrl,
      systemPrompt,
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
      systemPrompt,
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

  // 配额检查: 每日对话
  const userS = findUserById(userId);
  const todayChatsS = getTodayChatCount(userId);
  const chatCheckS = quota.checkDailyChatQuota(userS, todayChatsS);
  if (!chatCheckS.allowed) throw { status: 403, message: chatCheckS.message };

  const apiKey = await resolveApiKey(userId, body);
  const model = body.model || 'claude-sonnet-4-5-20250514';
  const providerName = detectProvider(model);
  const startMs = Date.now();

  // ─── 技能 System Prompt 自动注入 ───
  // 如果用户没有手动指定 system prompt，从最后一条用户消息自动路由到最佳技能
  let systemPrompt = body.system || '';
  if (!systemPrompt && body.messages && body.messages.length > 0) {
    const lastUserMsg = [...body.messages].reverse().find(m => m.role === 'user');
    if (lastUserMsg) {
      try {
        const routeResult = route(typeof lastUserMsg.content === 'string' ? lastUserMsg.content : '');
        if (routeResult.primary && routeResult.confidence >= 0.5) {
          const skill = listSkills().find(s => s.name === routeResult.primary);
          if (skill && skill.description) {
            systemPrompt = `你是 ${skill.name} 专家。${skill.description}\n请用中文回复，先给代码再解释。`;
            log('info', '技能注入', { userId, skill: routeResult.primary, confidence: routeResult.confidence });
          }
        }
      } catch { /* 路由失败不阻塞对话 */ }
    }
  }

  // #9 上下文截断
  const ctxS = trimContext(body.messages, systemPrompt, providerName);
  if (ctxS.truncated) log('info', '上下文截断', { userId, original: body.messages.length, kept: ctxS.trimmed.length, estTokens: ctxS.estTokens });
  body.messages = ctxS.trimmed;

  // 多模态: 将含 fileIds 的消息转换为 LLM content 数组
  body.messages = body.messages.map(msg => {
    if (msg.fileIds && msg.fileIds.length > 0) {
      return { role: msg.role, content: fileManager.buildMultimodalContent(userId, msg, providerName) };
    }
    return msg;
  });

  if (METRICS_ENABLED) metrics.incCounter('chat_requests_total', { model, stream: 'true' });

  log('info', 'Chat 流式开始', { userId, model, provider: providerName, hasFiles: body.messages.some(m => Array.isArray(m.content)) });

  if (providerName === 'anthropic' && !body.base_url && !body.baseUrl) {
    const result = await proxyChat({
      apiKey, model,
      messages: body.messages,
      maxTokens: body.max_tokens || body.maxTokens,
      stream: true,
      baseUrl: body.base_url || body.baseUrl,
      systemPrompt,
    }, res);

    const latencyMs = Date.now() - startMs;
    const sUsage = result?.usage || {};
    logUsage(userId, '/v1/chat/stream', sUsage.input_tokens || 0, sUsage.output_tokens || 0, model, latencyMs);

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
      systemPrompt,
    });

    const result = await sendLLMRequest(
      { name: providerName, baseUrl: config.baseUrl },
      apiKey, reqBody, res, true
    );

    const latencyMs = Date.now() - startMs;
    const sUsage = result?.usage || {};
    logUsage(userId, '/v1/chat/stream', sUsage.input_tokens || 0, sUsage.output_tokens || 0, model, latencyMs);

    if (result && !result.streamed && !res.headersSent) {
      json(res, 502, { error: '上游 API 返回错误', upstream_status: result.status, detail: result.data });
    }
  }
};

// ─── 套餐 & 配额端点 ───

routes['GET:/v1/tiers'] = async (req, res) => {
  // 公开接口，无需认证
  const tiers = quota.listTiers();
  json(res, 200, { ok: true, tiers });
};

routes['GET:/v1/me/quota'] = async (req, res) => {
  const userId = requireAuth(req);
  const user = findUserById(userId);
  const tier = quota.getUserTier(user);
  const todayChats = getTodayChatCount(userId);
  json(res, 200, {
    ok: true,
    tier: { id: tier.id, name: tier.name, price: tier.price },
    storage: quota.checkStorageQuota(user),
    dailyChats: quota.checkDailyChatQuota(user, todayChats),
    limits: {
      files_per_msg: tier.files_per_msg,
      max_file_mb: tier.max_file_mb,
      memory_days: tier.memory_days,
      projects: tier.projects,
    },
    features: tier.features,
  });
};

routes['POST:/v1/me/tier'] = async (req, res) => {
  const userId = requireAuth(req);
  const body = await parseJsonBody(req);
  const user = findUserById(userId);
  const currentTier = user.tier || 'free';
  const newTier = body.tier;

  const validation = quota.validateTierChange(currentTier, newTier);
  if (!validation.valid) throw { status: 400, message: validation.error };

  // Phase 1: 直接切换 (Phase 3 会加入支付验证)
  const expiresAt = newTier === 'free' ? null : new Date(Date.now() + 30 * 86400000).toISOString();
  await updateUserTier(userId, newTier, expiresAt);

  log('info', '套餐变更', { userId, from: currentTier, to: newTier });
  json(res, 200, {
    ok: true,
    message: `已切换到${validation.tier.name}`,
    tier: { id: validation.tier.id, name: validation.tier.name, price: validation.tier.price },
    expiresAt,
  });
};

// ─── 支付端点 (Phase 3) ───

routes['POST:/v1/payment/create'] = async (req, res) => {
  const userId = requireAuth(req);
  const body = await parseJsonBody(req);
  const { tier, payMethod } = body;
  if (!tier || !payMethod) throw { status: 400, message: '缺少 tier 或 payMethod' };
  if (!['alipay', 'wechat'].includes(payMethod)) throw { status: 400, message: '支付方式仅支持 alipay/wechat' };

  const order = payment.createOrder(userId, tier, payMethod);
  const payInfo = payment.initiatePayment(order);

  log('info', '订单创建', { userId, orderId: order.orderId, tier, amount: order.amountYuan });
  json(res, 200, { ok: true, order: { orderId: order.orderId, amount: order.amountYuan, tier }, payment: payInfo });
};

routes['GET:/v1/payment/status'] = async (req, res) => {
  const userId = requireAuth(req);
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const orderId = url.searchParams.get('orderId');
  if (!orderId) throw { status: 400, message: '缺少 orderId' };

  const order = payment.getOrder(orderId);
  if (!order || order.userId !== userId) throw { status: 404, message: '订单不存在' };

  json(res, 200, { ok: true, order: { orderId: order.orderId, status: order.status, tier: order.tier, amount: order.amountYuan, paidAt: order.paidAt } });
};

routes['GET:/v1/payment/orders'] = async (req, res) => {
  const userId = requireAuth(req);
  const orders = payment.getUserOrders(userId).map(o => ({
    orderId: o.orderId, tier: o.tier, amount: o.amountYuan,
    status: o.status, payMethod: o.payMethod, createdAt: o.createdAt, paidAt: o.paidAt,
  }));
  json(res, 200, { ok: true, orders });
};

// 模拟支付确认 (开发/测试用, 生产环境应禁用)
routes['GET:/v1/payment/mock-confirm'] = async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const orderId = url.searchParams.get('orderId');
  if (!orderId) throw { status: 400, message: '缺少 orderId' };

  const result = await payment.completeOrder(orderId, 'mock_' + Date.now());
  if (!result.success) throw { status: 400, message: result.error };

  log('info', '模拟支付完成', { orderId, tier: result.order.tier });
  // 返回成功页面
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...corsHeaders() });
  res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>支付成功</title></head>
<body style="background:#0A0C10;color:#F0F4FF;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh">
<div style="text-align:center"><h1 style="color:#34D399">支付成功</h1>
<p>已升级到 ${result.order.tier} 套餐</p>
<p><a href="/" style="color:#4F8EF7">返回应用</a></p></div></body></html>`);
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
  const codeStats = inviteCodes.getCodeStats();

  // 计算付费转化率 & MRR
  const paidUsers = (stats.tierDistribution.pro || 0) + (stats.tierDistribution.team || 0);
  const mrr = (stats.tierDistribution.pro || 0) * 29 + (stats.tierDistribution.team || 0) * 79;
  const arpu = stats.totalUsers > 0 ? Math.round(mrr / stats.totalUsers * 100) / 100 : 0;

  json(res, 200, {
    ...stats,
    uptime: Math.floor((Date.now() - startTime) / 1000),
    memory: {
      rss: Math.round(process.memoryUsage().rss / 1024 / 1024) + 'MB',
      heap: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + 'MB',
    },
    revenue: { paidUsers, conversionRate: stats.totalUsers > 0 ? Math.round(paidUsers / stats.totalUsers * 10000) / 100 + '%' : '0%', mrr, arpu },
    inviteCodes: codeStats,
  });
};

// ─── 邀请码管理 (管理员) ───

routes['POST:/v1/admin/codes'] = async (req, res) => {
  requireAdmin(req);
  const body = await parseJsonBody(req);
  const code = inviteCodes.createCode(body);
  log('info', '邀请码创建', { code: code.code, type: code.type });
  json(res, 200, { ok: true, code });
};

routes['GET:/v1/admin/codes'] = async (req, res) => {
  requireAdmin(req);
  const codes = inviteCodes.listCodes();
  json(res, 200, { ok: true, count: codes.length, codes });
};

routes['DELETE:/v1/admin/codes'] = async (req, res) => {
  requireAdmin(req);
  const body = await parseJsonBody(req);
  if (!body.code) throw { status: 400, message: '缺少 code' };
  const ok = inviteCodes.deactivateCode(body.code);
  if (!ok) throw { status: 404, message: '邀请码不存在' };
  json(res, 200, { ok: true });
};

// 用户兑换邀请码
routes['POST:/v1/me/redeem'] = async (req, res) => {
  const userId = requireAuth(req);
  const body = await parseJsonBody(req);
  if (!body.code) throw { status: 400, message: '请输入邀请码' };

  const result = inviteCodes.redeemCode(body.code, userId);
  if (!result.valid) throw { status: 400, message: result.error };

  const code = result.code;
  let message = '邀请码兑换成功';

  // 赠送套餐
  if (code.grantTier && code.grantDays > 0) {
    const expiresAt = new Date(Date.now() + code.grantDays * 86400000).toISOString();
    await updateUserTier(userId, code.grantTier, expiresAt);
    message = `已激活 ${code.grantTier} 套餐 (${code.grantDays} 天)`;
  }

  log('info', '邀请码兑换', { userId, code: code.code, type: code.type });
  json(res, 200, { ok: true, message, type: code.type, grantTier: code.grantTier, grantDays: code.grantDays, discountPct: code.discountPct });
};

// ─── 文件上传/下载 ───

routes['POST:/v1/files/upload'] = async (req, res) => {
  const userId = requireAuth(req);
  const user = findUserById(userId);
  const raw = await readBody(req, MAX_UPLOAD_BODY);
  let body;
  try { body = JSON.parse(raw); } catch { throw { status: 400, message: 'JSON 格式错误' }; }

  const files = body.files;
  if (!Array.isArray(files) || files.length === 0) throw { status: 400, message: '缺少 files 数组' };

  // 配额检查: 附件数量
  const fileCountCheck = quota.checkFileCountQuota(user, files.length);
  if (!fileCountCheck.allowed) throw { status: 403, message: fileCountCheck.message };

  // 预估总大小用于存储配额检查
  let estimatedTotal = 0;
  for (const f of files) {
    const estSize = f.data ? Math.ceil(f.data.length * 3 / 4) : 0;
    // 配额检查: 单文件大小
    const sizeCheck = quota.checkFileSizeQuota(user, estSize);
    if (!sizeCheck.allowed) throw { status: 403, message: sizeCheck.message };
    estimatedTotal += estSize;
  }

  // 配额检查: 存储空间
  const storageCheck = quota.checkStorageQuota(user, estimatedTotal);
  if (!storageCheck.allowed) throw { status: 403, message: storageCheck.message };

  const results = [];
  let totalSaved = 0;
  for (const f of files) {
    const meta = fileManager.saveFile(userId, { name: f.name, mimeType: f.mimeType, data: f.data });
    results.push({ fileId: meta.fileId, name: meta.originalName, mimeType: meta.mimeType, size: meta.size, category: meta.category });
    totalSaved += meta.size;
  }

  // 更新用户已用存储
  await updateStorageUsed(userId, totalSaved);

  log('info', '文件上传', { userId, count: results.length, totalSize: totalSaved });
  json(res, 200, { ok: true, files: results });
};

routes['GET:/v1/files/list'] = async (req, res) => {
  const userId = requireAuth(req);
  const files = fileManager.listFiles(userId);
  json(res, 200, { ok: true, files });
};

// 文件下载/预览 — 动态路由在 HTTP handler 中处理

routes['DELETE:/v1/files'] = async (req, res) => {
  const userId = requireAuth(req);
  const body = await parseJsonBody(req);
  if (!body.fileId) throw { status: 400, message: '缺少 fileId' };
  // 获取文件大小用于回退存储计数
  const file = fileManager.getFile(userId, body.fileId);
  const ok = fileManager.deleteFile(userId, body.fileId);
  if (!ok) throw { status: 404, message: '文件不存在' };
  // 减少已用存储
  if (file && file.metadata) {
    await updateStorageUsed(userId, -(file.metadata.size || 0));
  }
  json(res, 200, { ok: true });
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

  // 动态路由: 文件下载 GET /v1/files/:fileId
  if (method === 'GET' && pathname.startsWith('/v1/files/') && pathname !== '/v1/files/list') {
    try {
      const fileId = pathname.split('/').pop();
      // 支持 query token (img/a 标签无法发 header)
      if (!req.headers.authorization && url.searchParams.get('token')) {
        req.headers.authorization = 'Bearer ' + url.searchParams.get('token');
      }
      const userId = requireAuth(req);
      const file = fileManager.getFile(userId, fileId);
      if (!file) { json(res, 404, { error: '文件不存在' }); return; }
      const stat = fs.statSync(file.filePath);
      res.writeHead(200, {
        'Content-Type': file.metadata.mimeType,
        'Content-Length': stat.size,
        'Content-Disposition': `inline; filename="${encodeURIComponent(file.metadata.originalName)}"`,
        'Cache-Control': 'private, max-age=3600',
        ...corsHeaders(),
      });
      fs.createReadStream(file.filePath).pipe(res);
      return;
    } catch (e) {
      if (e.status) { json(res, e.status, { error: e.message }); return; }
      json(res, 500, { error: '文件下载失败' }); return;
    }
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
  // 启动套餐到期自动降级调度器 (每小时检查)
  startScheduler();
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
    stopScheduler();
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
