'use strict';

const crypto = require('crypto');
const { promisify } = require('util');

const scryptAsync = promisify(crypto.scrypt);

// AES-256-GCM 加密/解密 — 用于 BYOK API Key 安全存储
// 格式: base64( iv[16] + authTag[16] + ciphertext )

function getMasterKey() {
  const hex = process.env.MASTER_KEY;
  if (!hex || hex.length < 64 || hex === 'change-me-to-random-64-char-hex-string') {
    throw new Error('MASTER_KEY 未配置或使用了默认值，请在 .env 中设置 64 字符 hex');
  }
  return Buffer.from(hex, 'hex');
}

/**
 * 加密 API Key
 * @param {string} plaintext - 明文 API Key (如 sk-ant-xxx)
 * @returns {string} base64 编码的密文
 */
function encrypt(plaintext) {
  const key = getMasterKey();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  // iv(16) + tag(16) + ciphertext
  return Buffer.concat([iv, tag, encrypted]).toString('base64');
}

/**
 * ❾ 解密 API Key — 增加密文格式校验
 * @param {string} stored - base64 编码的密文
 * @returns {string} 明文 API Key
 */
function decrypt(stored) {
  if (!stored || typeof stored !== 'string') {
    throw new Error('密文不能为空');
  }
  const key = getMasterKey();
  const buf = Buffer.from(stored, 'base64');
  // iv(16) + tag(16) + 至少 1 字节密文 = 最小 33 字节
  if (buf.length < 33) {
    throw new Error('密文格式无效: 长度不足');
  }
  const iv = buf.subarray(0, 16);
  const tag = buf.subarray(16, 32);
  const ciphertext = buf.subarray(32);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(ciphertext, undefined, 'utf8') + decipher.final('utf8');
}

/**
 * ❹ 异步 scrypt 密码哈希 — 不阻塞事件循环
 * @param {string} password
 * @returns {Promise<string>} salt:hash (hex)
 */
async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = (await scryptAsync(password, salt, 64)).toString('hex');
  return `${salt}:${hash}`;
}

/**
 * ❹ 异步密码验证
 * @param {string} password
 * @param {string} stored - salt:hash 格式
 * @returns {Promise<boolean>}
 */
async function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) throw new Error('密码哈希格式损坏');
  const derived = (await scryptAsync(password, salt, 64)).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(derived, 'hex'));
}

module.exports = { encrypt, decrypt, hashPassword, verifyPassword };
