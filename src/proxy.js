'use strict';

const https = require('https');
const http = require('http');
const { URL } = require('url');

// ─── ❶ SSRF 防护：base_url 白名单 ───

const ALLOWED_API_HOSTS = new Set([
  'api.anthropic.com',
]);

// 从环境变量加载额外允许的主机 (逗号分隔)
if (process.env.ALLOWED_API_HOSTS) {
  for (const h of process.env.ALLOWED_API_HOSTS.split(',')) {
    if (h.trim()) ALLOWED_API_HOSTS.add(h.trim());
  }
}

function isPrivateHost(hostname) {
  const parts = hostname.split('.');
  if (parts.length === 4 && parts.every(p => /^\d+$/.test(p))) {
    const [a, b] = parts.map(Number);
    if (a === 10) return true;                        // 10.0.0.0/8
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true;          // 192.168.0.0/16
    if (a === 127) return true;                       // 127.0.0.0/8
    if (a === 169 && b === 254) return true;          // 169.254.0.0/16
    if (a === 0) return true;                         // 0.0.0.0/8
  }
  return hostname === 'localhost' || hostname === '[::1]';
}

function validateBaseUrl(baseUrl) {
  if (!baseUrl) return; // 使用默认值，安全
  let url;
  try {
    url = new URL(baseUrl);
  } catch {
    throw { status: 400, message: 'base_url 格式无效' };
  }
  if (ALLOWED_API_HOSTS.has(url.hostname)) return; // 白名单直接通过
  if (isPrivateHost(url.hostname)) {
    throw { status: 403, message: '不允许访问内网地址' };
  }
  // 允许其他公网地址（用户自定义中转）
}

// ─── BYOK 代理 ───

/**
 * BYOK 代理：用用户自己的 API Key 转发请求到 Claude API
 * 支持 SSE 流式输出
 *
 * @param {object} opts
 * @param {string} opts.apiKey - 用户的 Anthropic API Key
 * @param {string} opts.model - 模型名称
 * @param {Array}  opts.messages - 对话消息
 * @param {number} opts.maxTokens - 最大输出 token
 * @param {boolean} opts.stream - 是否流式
 * @param {string} [opts.baseUrl] - 自定义 API 地址
 * @param {string} [opts.systemPrompt] - 系统提示词
 * @param {object} res - HTTP response 对象 (用于 SSE 流式)
 */
async function proxyChat(opts, res) {
  const {
    apiKey,
    model = 'claude-sonnet-4-5-20250514',
    messages,
    maxTokens = 8192,
    stream = false,
    baseUrl,
    systemPrompt,
  } = opts;

  // ❶ SSRF 防护
  validateBaseUrl(baseUrl);

  const base = baseUrl || process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com';
  const url = new URL('/v1/messages', base);
  const isHttps = url.protocol === 'https:';

  const body = {
    model,
    messages,
    max_tokens: maxTokens,
    stream,
  };
  if (systemPrompt) body.system = systemPrompt;

  const payload = JSON.stringify(body);

  const requestOpts = {
    hostname: url.hostname,
    port: url.port || (isHttps ? 443 : 80),
    path: url.pathname,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'Content-Length': Buffer.byteLength(payload),
    },
  };

  return new Promise((resolve, reject) => {
    const transport = isHttps ? https : http;
    const proxyReq = transport.request(requestOpts, (proxyRes) => {
      if (stream) {
        // ❼ SSE 流式：先检查上游状态码
        if (proxyRes.statusCode !== 200) {
          // 上游返回错误，收集响应后以 JSON 返回（不走 SSE）
          const chunks = [];
          proxyRes.on('data', (chunk) => chunks.push(chunk));
          proxyRes.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8');
            try {
              resolve({ status: proxyRes.statusCode, data: JSON.parse(raw), streamed: false });
            } catch {
              resolve({ status: proxyRes.statusCode, data: { error: raw }, streamed: false });
            }
          });
          proxyRes.on('error', reject);
          return;
        }

        // 正常 SSE 透传
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'X-Accel-Buffering': 'no', // Nginx 禁止缓冲
        });

        proxyRes.on('data', (chunk) => {
          res.write(chunk);
        });
        proxyRes.on('end', () => {
          res.end();
          resolve({ streamed: true, status: 200 });
        });
        proxyRes.on('error', (err) => {
          res.end();
          reject(err);
        });

        // 客户端断开时关闭上游
        res.on('close', () => {
          proxyReq.destroy();
        });
      } else {
        // 非流式：收集完整响应
        const chunks = [];
        proxyRes.on('data', (chunk) => chunks.push(chunk));
        proxyRes.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          try {
            resolve({ status: proxyRes.statusCode, data: JSON.parse(raw) });
          } catch {
            resolve({ status: proxyRes.statusCode, data: raw });
          }
        });
        proxyRes.on('error', reject);
      }
    });

    proxyReq.on('error', (err) => {
      reject(err);
    });

    // 上游超时: 120s (agent 长任务)
    proxyReq.setTimeout(120_000, () => {
      proxyReq.destroy(new Error('Claude API 请求超时 (120s)'));
    });

    proxyReq.write(payload);
    proxyReq.end();
  });
}

module.exports = { proxyChat, validateBaseUrl };
