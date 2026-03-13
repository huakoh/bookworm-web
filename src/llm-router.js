'use strict';

// ─── #13 多 LLM 路由 ───
// 支持 Anthropic / OpenAI / Qwen 等多家 API
// 根据 model 前缀自动路由到对应 provider

const https = require('https');
const http = require('http');
const { URL } = require('url');

// ─── Provider 配置 ───
const PROVIDERS = {
  anthropic: {
    baseUrl: 'https://api.anthropic.com',
    pathPrefix: '/v1/messages',
    authHeader: 'x-api-key',
    versionHeader: { 'anthropic-version': '2023-06-01' },
    modelPrefixes: ['claude-'],
    buildBody: (opts) => ({
      model: opts.model,
      messages: opts.messages,
      max_tokens: opts.maxTokens || 8192,
      stream: opts.stream || false,
      ...(opts.systemPrompt ? { system: opts.systemPrompt } : {}),
    }),
    parseUsage: (data) => ({
      input_tokens: data?.usage?.input_tokens || 0,
      output_tokens: data?.usage?.output_tokens || 0,
    }),
  },
  openai: {
    baseUrl: 'https://api.openai.com',
    pathPrefix: '/v1/chat/completions',
    authHeader: 'Authorization',
    authPrefix: 'Bearer ',
    versionHeader: {},
    modelPrefixes: ['gpt-', 'o1-', 'o3-', 'o4-'],
    buildBody: (opts) => ({
      model: opts.model,
      messages: [
        ...(opts.systemPrompt ? [{ role: 'system', content: opts.systemPrompt }] : []),
        ...opts.messages,
      ],
      max_completion_tokens: opts.maxTokens || 8192,
      stream: opts.stream || false,
    }),
    parseUsage: (data) => ({
      input_tokens: data?.usage?.prompt_tokens || 0,
      output_tokens: data?.usage?.completion_tokens || 0,
    }),
  },
  qwen: {
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode',
    pathPrefix: '/v1/chat/completions',
    authHeader: 'Authorization',
    authPrefix: 'Bearer ',
    versionHeader: {},
    modelPrefixes: ['qwen'],
    buildBody: (opts) => ({
      model: opts.model,
      messages: [
        ...(opts.systemPrompt ? [{ role: 'system', content: opts.systemPrompt }] : []),
        ...opts.messages,
      ],
      max_tokens: opts.maxTokens || 8192,
      stream: opts.stream || false,
    }),
    parseUsage: (data) => ({
      input_tokens: data?.usage?.prompt_tokens || 0,
      output_tokens: data?.usage?.completion_tokens || 0,
    }),
  },
  deepseek: {
    baseUrl: 'https://api.deepseek.com',
    pathPrefix: '/v1/chat/completions',
    authHeader: 'Authorization',
    authPrefix: 'Bearer ',
    versionHeader: {},
    modelPrefixes: ['deepseek-'],
    buildBody: (opts) => ({
      model: opts.model,
      messages: [
        ...(opts.systemPrompt ? [{ role: 'system', content: opts.systemPrompt }] : []),
        ...opts.messages,
      ],
      max_tokens: opts.maxTokens || 8192,
      stream: opts.stream || false,
    }),
    parseUsage: (data) => ({
      input_tokens: data?.usage?.prompt_tokens || 0,
      output_tokens: data?.usage?.completion_tokens || 0,
    }),
  },
};

/**
 * 根据模型名推断 provider
 * @param {string} model
 * @returns {string} provider name
 */
function detectProvider(model) {
  if (!model) return 'anthropic';
  const lower = model.toLowerCase();
  for (const [name, config] of Object.entries(PROVIDERS)) {
    if (config.modelPrefixes.some(prefix => lower.startsWith(prefix))) {
      return name;
    }
  }
  return 'anthropic'; // 默认
}

/**
 * 获取 provider 配置（支持自定义 baseUrl 覆盖）
 */
function getProviderConfig(providerName, overrideBaseUrl) {
  const config = PROVIDERS[providerName];
  if (!config) throw { status: 400, message: `不支持的 provider: ${providerName}` };
  return {
    ...config,
    baseUrl: overrideBaseUrl || config.baseUrl,
  };
}

/**
 * 列出支持的 provider
 */
function listProviders() {
  return Object.entries(PROVIDERS).map(([name, config]) => ({
    name,
    models: config.modelPrefixes,
    baseUrl: config.baseUrl,
  }));
}

/**
 * 通用 LLM 请求发送
 */
function sendLLMRequest(provider, apiKey, body, res, stream) {
  const config = PROVIDERS[provider.name || provider] || PROVIDERS.anthropic;
  const base = provider.baseUrl || config.baseUrl;
  // 正确拼接: baseUrl 可能包含路径前缀 (如 /compatible-mode)
  const baseUrl = new URL(base);
  const fullPath = baseUrl.pathname.replace(/\/$/, '') + config.pathPrefix;
  const url = new URL(fullPath, base);
  const isHttps = url.protocol === 'https:';

  const payload = JSON.stringify(body);
  const headers = {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
    ...config.versionHeader,
  };

  // 设置认证头
  if (config.authHeader === 'Authorization') {
    headers['Authorization'] = (config.authPrefix || '') + apiKey;
  } else {
    headers[config.authHeader] = apiKey;
  }

  const requestOpts = {
    hostname: url.hostname,
    port: url.port || (isHttps ? 443 : 80),
    path: url.pathname,
    method: 'POST',
    headers,
  };

  return new Promise((resolve, reject) => {
    const transport = isHttps ? https : http;
    const proxyReq = transport.request(requestOpts, (proxyRes) => {
      if (stream) {
        if (proxyRes.statusCode !== 200) {
          const chunks = [];
          proxyRes.on('data', c => chunks.push(c));
          proxyRes.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8');
            try { resolve({ status: proxyRes.statusCode, data: JSON.parse(raw), streamed: false }); }
            catch { resolve({ status: proxyRes.statusCode, data: { error: raw }, streamed: false }); }
          });
          proxyRes.on('error', reject);
          return;
        }

        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        proxyRes.on('data', c => res.write(c));
        proxyRes.on('end', () => { res.end(); resolve({ streamed: true, status: 200 }); });
        proxyRes.on('error', e => { res.end(); reject(e); });
        res.on('close', () => proxyReq.destroy());
      } else {
        const chunks = [];
        proxyRes.on('data', c => chunks.push(c));
        proxyRes.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          try { resolve({ status: proxyRes.statusCode, data: JSON.parse(raw) }); }
          catch { resolve({ status: proxyRes.statusCode, data: raw }); }
        });
        proxyRes.on('error', reject);
      }
    });

    proxyReq.on('error', reject);
    proxyReq.setTimeout(120_000, () => {
      proxyReq.destroy(new Error('LLM API 请求超时 (120s)'));
    });
    proxyReq.write(payload);
    proxyReq.end();
  });
}

module.exports = { detectProvider, getProviderConfig, listProviders, sendLLMRequest, PROVIDERS };
