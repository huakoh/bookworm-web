'use strict';

const jwt = require('jsonwebtoken');
const { hashPassword, verifyPassword } = require('./crypto-utils');
const { createUser, findUserByEmail, findUserById } = require('./db');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PASSWORD_MAX_LEN = 128;

function getSecret() {
  const s = process.env.JWT_SECRET;
  if (!s || s === 'change-me-to-random-64-char-string') {
    throw new Error('JWT_SECRET 未配置，请在 .env 中设置');
  }
  return s;
}

/**
 * 注册新用户 (async — scrypt 不阻塞事件循环)
 * @returns {Promise<{ id: number, email: string, token: string }>}
 */
async function register(email, password) {
  if (!email || !password) throw { status: 400, message: '邮箱和密码必填' };
  if (!EMAIL_RE.test(email)) throw { status: 400, message: '邮箱格式不正确' };
  if (password.length < 8) throw { status: 400, message: '密码至少 8 位' };
  if (password.length > PASSWORD_MAX_LEN) throw { status: 400, message: `密码不能超过 ${PASSWORD_MAX_LEN} 位` };

  const existing = findUserByEmail(email);
  if (existing) throw { status: 409, message: '邮箱已注册' };

  const hashed = await hashPassword(password);
  const result = await createUser(email, hashed);
  const token = signToken(result.lastInsertRowid);
  const refresh = signRefreshToken(result.lastInsertRowid);

  return { id: result.lastInsertRowid, email, token, refreshToken: refresh };
}

/**
 * 登录 (async — scrypt 不阻塞事件循环)
 * @returns {Promise<{ id: number, email: string, token: string }>}
 */
async function login(email, password) {
  if (!email || !password) throw { status: 400, message: '邮箱和密码必填' };

  const user = findUserByEmail(email);
  if (!user) throw { status: 401, message: '邮箱或密码错误' };

  if (!(await verifyPassword(password, user.password))) {
    throw { status: 401, message: '邮箱或密码错误' };
  }

  const token = signToken(user.id);
  const refresh = signRefreshToken(user.id);
  return { id: user.id, email: user.email, token, refreshToken: refresh };
}

// ─── #9 双 Token 机制 ───
// accessToken: 24h 短期令牌 | refreshToken: 30d 长期令牌

function signToken(userId) {
  return jwt.sign({ sub: userId, type: 'access' }, getSecret(), { algorithm: 'HS256', expiresIn: '24h' });
}

function signRefreshToken(userId) {
  return jwt.sign({ sub: userId, type: 'refresh' }, getSecret(), { algorithm: 'HS256', expiresIn: '30d' });
}

/**
 * 用 refreshToken 换取新的 accessToken
 * @param {string} refreshTokenStr
 * @returns {{ token: string }} 新的 accessToken
 */
function refreshAccessToken(refreshTokenStr) {
  if (!refreshTokenStr) throw { status: 400, message: '缺少 refreshToken' };
  try {
    const payload = jwt.verify(refreshTokenStr, getSecret());
    if (payload.type !== 'refresh') throw { status: 401, message: 'Token 类型错误' };
    const user = findUserById(payload.sub);
    if (!user) throw { status: 401, message: '用户不存在' };
    return { token: signToken(payload.sub) };
  } catch (err) {
    if (err.status) throw err;
    throw { status: 401, message: 'Refresh Token 无效或已过期' };
  }
}

/**
 * 从 Authorization header 验证 JWT
 * @param {string} authHeader - "Bearer xxx"
 * @returns {{ userId: number }} 解码后的用户信息
 */
function verifyToken(authHeader) {
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    throw { status: 401, message: '缺少 Authorization header' };
  }
  const token = authHeader.slice(7);
  try {
    const payload = jwt.verify(token, getSecret());
    return { userId: payload.sub };
  } catch (err) {
    throw { status: 401, message: 'Token 无效或已过期' };
  }
}

/**
 * 中间件：校验认证并注入 req.userId
 * @param {object} req
 * @returns {number} userId
 */
function requireAuth(req) {
  const { userId } = verifyToken(req.headers.authorization);
  const user = findUserById(userId);
  if (!user) throw { status: 401, message: '用户不存在' };
  return userId;
}

module.exports = { register, login, verifyToken, requireAuth, refreshAccessToken };
