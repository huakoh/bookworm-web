'use strict';

// ─── 邀请码 & 优惠券系统 ───
// 支持: 注册邀请码、套餐折扣码、限时活动码

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, '..', 'data');
const CODES_FILE = path.join(DATA_DIR, 'invite-codes.json');

function loadCodes() {
  if (!fs.existsSync(CODES_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(CODES_FILE, 'utf8')); } catch { return []; }
}

function saveCodes(codes) {
  const tmp = CODES_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(codes, null, 2), 'utf8');
  fs.renameSync(tmp, CODES_FILE);
}

/**
 * 生成邀请码
 * @param {object} opts
 * @param {string} opts.type - 'invite' | 'discount' | 'promo'
 * @param {number} opts.maxUses - 最大使用次数 (-1=无限)
 * @param {string} opts.expiresAt - 过期时间 ISO
 * @param {number} opts.discountPct - 折扣百分比 (如 20 表示打8折)
 * @param {string} opts.grantTier - 赠送套餐 (如 'pro')
 * @param {number} opts.grantDays - 赠送天数
 * @param {string} opts.createdBy - 创建者 (admin email)
 * @param {string} opts.note - 备注
 */
function createCode(opts = {}) {
  const code = (opts.prefix || 'BW') + '-' + crypto.randomBytes(4).toString('hex').toUpperCase();
  const entry = {
    code,
    type: opts.type || 'invite',
    maxUses: opts.maxUses ?? 1,
    usedCount: 0,
    usedBy: [],
    discountPct: opts.discountPct || 0,
    grantTier: opts.grantTier || null,
    grantDays: opts.grantDays || 0,
    expiresAt: opts.expiresAt || null,
    createdBy: opts.createdBy || 'system',
    note: opts.note || '',
    active: true,
    createdAt: new Date().toISOString(),
  };

  const codes = loadCodes();
  codes.push(entry);
  saveCodes(codes);
  return entry;
}

/**
 * 验证并使用邀请码
 * @returns {{ valid: boolean, code?: object, error?: string }}
 */
function redeemCode(codeStr, userId) {
  const codes = loadCodes();
  const entry = codes.find(c => c.code === codeStr.toUpperCase().trim());

  if (!entry) return { valid: false, error: '邀请码不存在' };
  if (!entry.active) return { valid: false, error: '邀请码已停用' };
  if (entry.expiresAt && new Date(entry.expiresAt) < new Date()) return { valid: false, error: '邀请码已过期' };
  if (entry.maxUses !== -1 && entry.usedCount >= entry.maxUses) return { valid: false, error: '邀请码已用完' };
  if (entry.usedBy.includes(userId)) return { valid: false, error: '您已使用过此邀请码' };

  // 使用
  entry.usedCount++;
  entry.usedBy.push(userId);
  saveCodes(codes);

  return { valid: true, code: entry };
}

/**
 * 列出所有邀请码 (管理员)
 */
function listCodes() {
  return loadCodes().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/**
 * 停用邀请码
 */
function deactivateCode(codeStr) {
  const codes = loadCodes();
  const entry = codes.find(c => c.code === codeStr);
  if (!entry) return false;
  entry.active = false;
  saveCodes(codes);
  return true;
}

/**
 * 获取统计
 */
function getCodeStats() {
  const codes = loadCodes();
  return {
    total: codes.length,
    active: codes.filter(c => c.active).length,
    totalRedemptions: codes.reduce((s, c) => s + c.usedCount, 0),
  };
}

module.exports = { createCode, redeemCode, listCodes, deactivateCode, getCodeStats };
