'use strict';

// ─── 阿里云 OSS 存储适配器 ───
// Phase 2: 将本地文件存储迁移到 OSS
// 当 OSS_ENABLED=true 时使用 OSS，否则 fallback 到本地文件系统
// 零外部依赖: 使用 OSS REST API + HMAC-SHA1 签名

const https = require('https');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// ─── 配置 ───
const OSS_CONFIG = {
  enabled: process.env.OSS_ENABLED === 'true',
  accessKeyId: process.env.OSS_ACCESS_KEY_ID || '',
  accessKeySecret: process.env.OSS_ACCESS_KEY_SECRET || '',
  bucket: process.env.OSS_BUCKET || 'bookworm-files',
  region: process.env.OSS_REGION || 'oss-cn-beijing',
  endpoint: process.env.OSS_ENDPOINT || '', // 自动拼接: {bucket}.{region}.aliyuncs.com
  prefix: process.env.OSS_PREFIX || 'uploads/', // 对象键前缀
};

function getEndpoint() {
  if (OSS_CONFIG.endpoint) return OSS_CONFIG.endpoint;
  return `${OSS_CONFIG.bucket}.${OSS_CONFIG.region}.aliyuncs.com`;
}

// ─── OSS V1 签名 (兼容性最好) ───

function signRequest(method, objectKey, headers = {}) {
  const contentType = headers['Content-Type'] || '';
  const date = new Date().toUTCString();
  const canonicalizedResource = `/${OSS_CONFIG.bucket}/${objectKey}`;

  const stringToSign = [
    method,
    headers['Content-MD5'] || '',
    contentType,
    date,
    canonicalizedResource,
  ].join('\n');

  const signature = crypto
    .createHmac('sha1', OSS_CONFIG.accessKeySecret)
    .update(stringToSign)
    .digest('base64');

  return {
    Authorization: `OSS ${OSS_CONFIG.accessKeyId}:${signature}`,
    Date: date,
  };
}

// ─── OSS 操作 ───

/**
 * 上传文件到 OSS
 * @param {string} objectKey - OSS 对象键 (如 uploads/6/f_abc123.jpg)
 * @param {Buffer} data - 文件数据
 * @param {string} contentType - MIME 类型
 * @returns {Promise<{ok: boolean, url: string}>}
 */
function putObject(objectKey, data, contentType) {
  const endpoint = getEndpoint();
  const headers = {
    'Content-Type': contentType,
    'Content-Length': data.length,
    'Content-MD5': crypto.createHash('md5').update(data).digest('base64'),
  };
  const authHeaders = signRequest('PUT', objectKey, headers);

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: endpoint,
      port: 443,
      path: '/' + objectKey,
      method: 'PUT',
      headers: { ...headers, ...authHeaders },
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        if (res.statusCode === 200) {
          resolve({
            ok: true,
            url: `https://${endpoint}/${objectKey}`,
            etag: res.headers.etag,
          });
        } else {
          const body = Buffer.concat(chunks).toString('utf8');
          resolve({ ok: false, status: res.statusCode, error: body });
        }
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

/**
 * 从 OSS 下载文件
 * @param {string} objectKey
 * @returns {Promise<{ok: boolean, data: Buffer, contentType: string}>}
 */
function getObject(objectKey) {
  const endpoint = getEndpoint();
  const headers = {};
  const authHeaders = signRequest('GET', objectKey, headers);

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: endpoint,
      port: 443,
      path: '/' + objectKey,
      method: 'GET',
      headers: { ...headers, ...authHeaders },
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        if (res.statusCode === 200) {
          resolve({
            ok: true,
            data: Buffer.concat(chunks),
            contentType: res.headers['content-type'],
            size: parseInt(res.headers['content-length'] || '0'),
          });
        } else {
          resolve({ ok: false, status: res.statusCode });
        }
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

/**
 * 删除 OSS 对象
 */
function deleteObject(objectKey) {
  const endpoint = getEndpoint();
  const authHeaders = signRequest('DELETE', objectKey, {});

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: endpoint,
      port: 443,
      path: '/' + objectKey,
      method: 'DELETE',
      headers: { ...authHeaders },
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ ok: res.statusCode === 204 || res.statusCode === 200 }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

/**
 * 生成预签名下载 URL (有效期 1 小时)
 */
function getSignedUrl(objectKey, expireSeconds = 3600) {
  const endpoint = getEndpoint();
  const expires = Math.floor(Date.now() / 1000) + expireSeconds;
  const canonicalizedResource = `/${OSS_CONFIG.bucket}/${objectKey}`;
  const stringToSign = `GET\n\n\n${expires}\n${canonicalizedResource}`;
  const signature = crypto
    .createHmac('sha1', OSS_CONFIG.accessKeySecret)
    .update(stringToSign)
    .digest('base64');

  return `https://${endpoint}/${objectKey}?OSSAccessKeyId=${encodeURIComponent(OSS_CONFIG.accessKeyId)}&Expires=${expires}&Signature=${encodeURIComponent(signature)}`;
}

// ─── 统一存储接口 ───
// 对外暴露与 file-manager 相同语义的操作
// 当 OSS 未启用时透明 fallback 到本地

/**
 * 存储文件 (OSS 或本地)
 * @param {string} userId
 * @param {string} storedName - 文件名 (如 f_abc123.jpg)
 * @param {Buffer} buffer - 文件数据
 * @param {string} mimeType
 * @returns {Promise<{backend: string, ossKey?: string}>}
 */
async function storeFile(userId, storedName, buffer, mimeType) {
  if (OSS_CONFIG.enabled && OSS_CONFIG.accessKeyId) {
    const objectKey = `${OSS_CONFIG.prefix}${userId}/${storedName}`;
    const result = await putObject(objectKey, buffer, mimeType);
    if (result.ok) {
      return { backend: 'oss', ossKey: objectKey, url: result.url };
    }
    // OSS 失败, 回退本地
    console.error(`OSS 上传失败, 回退本地: ${result.error}`);
  }
  // 本地存储 (保持兼容)
  return { backend: 'local' };
}

/**
 * 读取文件
 */
async function readFile(userId, storedName, ossKey) {
  if (ossKey && OSS_CONFIG.enabled) {
    const result = await getObject(ossKey);
    if (result.ok) return { backend: 'oss', data: result.data, contentType: result.contentType };
  }
  return { backend: 'local' };
}

/**
 * 删除文件
 */
async function removeFile(userId, storedName, ossKey) {
  if (ossKey && OSS_CONFIG.enabled) {
    await deleteObject(ossKey);
  }
  return { ok: true };
}

/**
 * 获取下载链接 (OSS 预签名 或 本地路径)
 */
function getDownloadUrl(userId, storedName, ossKey) {
  if (ossKey && OSS_CONFIG.enabled) {
    return { backend: 'oss', url: getSignedUrl(ossKey) };
  }
  return { backend: 'local' };
}

module.exports = {
  OSS_CONFIG,
  putObject,
  getObject,
  deleteObject,
  getSignedUrl,
  storeFile,
  readFile,
  removeFile,
  getDownloadUrl,
};
