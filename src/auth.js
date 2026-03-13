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

  return { id: result.lastInsertRowid, email, token };
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
  return { id: user.id, email: user.email, token };
}

function signToken(userId) {
  return jwt.sign({ sub: userId }, getSecret(), { algorithm: 'HS256', expiresIn: '30d' });
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

module.exports = { register, login, verifyToken, requireAuth };
