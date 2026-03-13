'use strict';

// ─── 支付系统 (Phase 3) ───
// 支持支付宝/微信支付
// 当前为框架模式: 校验签名 + 记录订单 + 回调处理
// 实际接入需配置商户号和证书

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, '..', 'data');
const ORDERS_FILE = path.join(DATA_DIR, 'orders.json');

// ─── 配置 ───
const PAY_CONFIG = {
  alipay: {
    enabled: process.env.ALIPAY_ENABLED === 'true',
    appId: process.env.ALIPAY_APP_ID || '',
    privateKey: process.env.ALIPAY_PRIVATE_KEY || '',
    alipayPublicKey: process.env.ALIPAY_PUBLIC_KEY || '',
    notifyUrl: process.env.ALIPAY_NOTIFY_URL || '',
    returnUrl: process.env.ALIPAY_RETURN_URL || '',
  },
  wechat: {
    enabled: process.env.WECHAT_PAY_ENABLED === 'true',
    appId: process.env.WECHAT_APP_ID || '',
    mchId: process.env.WECHAT_MCH_ID || '',
    apiKey: process.env.WECHAT_API_KEY || '',
    notifyUrl: process.env.WECHAT_NOTIFY_URL || '',
  },
};

// ─── 订单管理 ───

function loadOrders() {
  if (!fs.existsSync(ORDERS_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(ORDERS_FILE, 'utf8')); } catch { return []; }
}

function saveOrders(orders) {
  const tmp = ORDERS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(orders, null, 2), 'utf8');
  fs.renameSync(tmp, ORDERS_FILE);
}

/**
 * 创建订单
 */
function createOrder(userId, tier, payMethod) {
  const { TIERS } = require('./quota');
  const tierInfo = TIERS[tier];
  if (!tierInfo || tierInfo.price === 0) {
    throw { status: 400, message: '免费套餐无需支付' };
  }

  const orderId = 'ord_' + Date.now().toString(36) + crypto.randomBytes(4).toString('hex');
  const order = {
    orderId,
    userId,
    tier,
    amount: tierInfo.price * 100, // 分
    amountYuan: tierInfo.price,
    payMethod, // 'alipay' | 'wechat'
    status: 'pending', // pending → paid → activated | expired | refunded
    createdAt: new Date().toISOString(),
    paidAt: null,
    expiresAt: null, // 订单过期时间 (30分钟)
    tradeNo: null, // 第三方交易号
  };

  // 订单 30 分钟过期
  order.expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();

  const orders = loadOrders();
  orders.push(order);
  saveOrders(orders);

  return order;
}

/**
 * 查询订单
 */
function getOrder(orderId) {
  const orders = loadOrders();
  return orders.find(o => o.orderId === orderId) || null;
}

/**
 * 查询用户订单列表
 */
function getUserOrders(userId) {
  return loadOrders()
    .filter(o => o.userId === userId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/**
 * 标记订单已支付 + 激活套餐
 * @returns {{ success: boolean, order: object }}
 */
async function completeOrder(orderId, tradeNo) {
  const orders = loadOrders();
  const order = orders.find(o => o.orderId === orderId);
  if (!order) return { success: false, error: '订单不存在' };
  if (order.status !== 'pending') return { success: false, error: `订单状态异常: ${order.status}` };

  // 检查过期
  if (new Date(order.expiresAt) < new Date()) {
    order.status = 'expired';
    saveOrders(orders);
    return { success: false, error: '订单已过期' };
  }

  order.status = 'paid';
  order.paidAt = new Date().toISOString();
  order.tradeNo = tradeNo || null;
  saveOrders(orders);

  // 激活套餐
  const { updateUserTier } = require('./db');
  const tierExpiresAt = new Date(Date.now() + 30 * 86400000).toISOString();
  await updateUserTier(order.userId, order.tier, tierExpiresAt);

  order.status = 'activated';
  saveOrders(orders);

  return { success: true, order };
}

// ─── 支付接口 (框架) ───
// 实际接入时替换为真实的签名/请求逻辑

/**
 * 发起支付 — 返回支付链接或二维码数据
 */
function initiatePayment(order) {
  if (order.payMethod === 'alipay') {
    if (!PAY_CONFIG.alipay.enabled) {
      // 模拟模式: 返回确认链接
      return {
        type: 'redirect',
        url: `/v1/payment/mock-confirm?orderId=${order.orderId}`,
        message: '支付宝暂未接入，使用模拟支付',
      };
    }
    // TODO: 实际支付宝 API 调用
    return { type: 'redirect', url: '#alipay-not-configured' };
  }

  if (order.payMethod === 'wechat') {
    if (!PAY_CONFIG.wechat.enabled) {
      return {
        type: 'redirect',
        url: `/v1/payment/mock-confirm?orderId=${order.orderId}`,
        message: '微信支付暂未接入，使用模拟支付',
      };
    }
    // TODO: 实际微信支付 API 调用
    return { type: 'qrcode', data: '#wechat-not-configured' };
  }

  throw { status: 400, message: '不支持的支付方式' };
}

/**
 * 验证支付回调签名
 * @returns {boolean}
 */
function verifyCallback(payMethod, params) {
  // TODO: 实际签名验证
  // 当前框架模式, 信任所有回调
  return true;
}

module.exports = {
  PAY_CONFIG,
  createOrder,
  getOrder,
  getUserOrders,
  completeOrder,
  initiatePayment,
  verifyCallback,
};
