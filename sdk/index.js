'use strict';

// ─── #14 Bookworm SDK ───
// 零依赖 Node.js 客户端，封装 REST + SSE 接口

/**
 * Bookworm Web Service 客户端
 *
 * @example
 * const client = new BookwormClient('http://localhost:3211');
 * await client.register('user@example.com', 'password123');
 * const result = await client.route('帮我优化 React 组件性能');
 * console.log(result.primary); // 'frontend-expert'
 */
class BookwormClient {
  /**
   * @param {string} baseUrl - 服务地址，例如 'http://localhost:3211'
   * @param {object} [opts]
   * @param {string} [opts.token] - JWT 访问令牌
   * @param {number} [opts.timeout] - 请求超时毫秒数 (默认 30000)
   */
  constructor(baseUrl, opts = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.token = opts.token || '';
    this.refreshToken = '';
    this.timeout = opts.timeout || 30_000;
  }

  // ─── 认证 ───

  async register(email, password) {
    const data = await this._request('POST', '/v1/register', { email, password });
    this.token = data.token;
    if (data.refreshToken) this.refreshToken = data.refreshToken;
    return data;
  }

  async login(email, password) {
    const data = await this._request('POST', '/v1/login', { email, password });
    this.token = data.token;
    if (data.refreshToken) this.refreshToken = data.refreshToken;
    return data;
  }

  async refresh() {
    if (!this.refreshToken) throw new Error('无 refreshToken，请先登录');
    const data = await this._request('POST', '/v1/token/refresh', { refreshToken: this.refreshToken });
    this.token = data.token;
    return data;
  }

  // ─── 用户 ───

  async me() {
    return this._request('GET', '/v1/me');
  }

  async saveApiKey(apiKey) {
    return this._request('PUT', '/v1/me/key', { apiKey });
  }

  async usage(days = 30) {
    return this._request('GET', `/v1/me/usage?days=${days}`);
  }

  // ─── 核心路由 ───

  async route(text) {
    return this._request('POST', '/v1/route', { text });
  }

  async skills() {
    return this._request('GET', '/v1/skills');
  }

  // ─── Chat ───

  async chat(messages, opts = {}) {
    return this._request('POST', '/v1/chat', {
      messages,
      model: opts.model,
      max_tokens: opts.maxTokens,
      system: opts.systemPrompt,
      apiKey: opts.apiKey,
      base_url: opts.baseUrl,
    });
  }

  /**
   * 流式 Chat — 返回 async iterator
   * @param {Array} messages
   * @param {object} [opts]
   * @yields {string} 文本片段
   */
  async *chatStream(messages, opts = {}) {
    const body = JSON.stringify({
      messages,
      model: opts.model,
      max_tokens: opts.maxTokens,
      system: opts.systemPrompt,
      apiKey: opts.apiKey,
      base_url: opts.baseUrl,
    });

    const url = new URL(this.baseUrl + '/v1/chat/stream');
    const isHttps = url.protocol === 'https:';
    const transport = isHttps ? require('https') : require('http');

    const res = await new Promise((resolve, reject) => {
      const req = transport.request({
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + this.token,
          'Content-Length': Buffer.byteLength(body),
        },
      }, resolve);
      req.on('error', reject);
      req.setTimeout(this.timeout, () => req.destroy(new Error('请求超时')));
      req.write(body);
      req.end();
    });

    if (res.statusCode !== 200) {
      const chunks = [];
      for await (const c of res) chunks.push(c);
      const raw = Buffer.concat(chunks).toString('utf8');
      throw new Error(`HTTP ${res.statusCode}: ${raw}`);
    }

    let buffer = '';
    for await (const chunk of res) {
      buffer += chunk.toString('utf8');
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const payload = line.slice(6);
        if (payload === '[DONE]') return;
        try {
          const evt = JSON.parse(payload);
          if (evt.type === 'content_block_delta' && evt.delta?.text) {
            yield evt.delta.text;
          }
        } catch { /* 跳过非 JSON 行 */ }
      }
    }
  }

  // ─── 健康检查 ───

  async health() {
    return this._request('GET', '/health');
  }

  // ─── 管理 ───

  async adminUsers(adminToken) {
    return this._requestRaw('GET', '/v1/admin/users', null, { 'Authorization': 'Admin ' + adminToken });
  }

  async adminStats(adminToken) {
    return this._requestRaw('GET', '/v1/admin/stats', null, { 'Authorization': 'Admin ' + adminToken });
  }

  // ─── 内部方法 ───

  async _request(method, path, body) {
    const headers = { 'Content-Type': 'application/json' };
    if (this.token) headers['Authorization'] = 'Bearer ' + this.token;
    return this._requestRaw(method, path, body, headers);
  }

  async _requestRaw(method, path, body, headers) {
    const url = new URL(this.baseUrl + path);
    const isHttps = url.protocol === 'https:';
    const transport = isHttps ? require('https') : require('http');

    const payload = body ? JSON.stringify(body) : null;
    if (payload) headers['Content-Length'] = Buffer.byteLength(payload);

    return new Promise((resolve, reject) => {
      const req = transport.request({
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        method,
        headers,
      }, (res) => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          try {
            const data = JSON.parse(raw);
            if (res.statusCode >= 400) {
              const err = new Error(data.error || `HTTP ${res.statusCode}`);
              err.status = res.statusCode;
              err.data = data;
              reject(err);
            } else {
              resolve(data);
            }
          } catch {
            reject(new Error(`无法解析响应: ${raw.slice(0, 200)}`));
          }
        });
        res.on('error', reject);
      });

      req.on('error', reject);
      req.setTimeout(this.timeout, () => req.destroy(new Error('请求超时')));
      if (payload) req.write(payload);
      req.end();
    });
  }
}

module.exports = { BookwormClient };
