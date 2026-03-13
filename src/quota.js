'use strict';

// ─── 用户配额 & 套餐系统 ───
// 基于阿里云 2026 实际成本 * 1.3 加成

const fs = require('fs');
const path = require('path');

// ─── 云成本基准 (2026.03 阿里云实际价格) ───
const CLOUD_COSTS = {
  oss_storage_per_gb_month: 0.09,    // ¥/GB/月 标准存储
  oss_egress_per_gb: 0.36,           // ¥/GB 公网流出 (忙/闲均值)
  oss_put_per_10k: 0.01,             // ¥/万次 PUT
  oss_get_per_10k: 0.01,             // ¥/万次 GET
  ecs_2c4g_monthly: 100,             // ¥/月 2核4G ECS
  // LLM Token (仅参考, BYOK 用户自付)
  qwen_max_input_per_m: 2.50,        // ¥/百万 tokens
  qwen_plus_input_per_m: 0.50,       // ¥/百万 tokens
  claude_sonnet_input_per_m: 21.90,   // ¥/百万 ($3 * 7.3 汇率)
  gpt4o_input_per_m: 18.25,          // ¥/百万 ($2.5 * 7.3)
  deepseek_v3_input_per_m: 2.04,     // ¥/百万 ($0.28 * 7.3)
};

const MARKUP = 1.30; // 30% 加成

// ─── 套餐定义 ───
// 成本计算依据:
//   Free:  1GB OSS(¥0.09) + 1GB流出(¥0.36) + 计算分摊(¥1) = ¥1.45 * 1.3 = ¥1.89 → 免费
//   Pro:   5GB OSS(¥0.45) + 10GB流出(¥3.60) + 计算(¥3) + 记忆(¥2) = ¥9.05 * 1.3 = ¥11.77 + 平台价值¥17.23 = ¥29
//   Team: 20GB OSS(¥1.80) + 30GB流出(¥10.80) + 计算(¥8) + 记忆(¥5) + 优先(¥3) = ¥28.60 * 1.3 = ¥37.18 + 平台价值¥41.82 = ¥79
const TIERS = {
  free: {
    id: 'free',
    name: '探索版',
    price: 0,           // ¥/月
    storage_mb: 1024,    // 1GB
    egress_mb: 2048,     // 2GB/月 流出
    memory_days: 7,      // 对话记忆保留天数
    projects: 1,         // 项目空间数
    files_per_msg: 3,    // 每条消息附件数
    max_file_mb: 5,      // 单文件大小限制
    daily_chats: 50,     // 每日对话次数
    features: ['basic_chat', 'skill_routing', 'file_upload'],
    cloud_cost: 1.45,    // 月云成本
    selling_price: 0,
  },
  pro: {
    id: 'pro',
    name: '专业版',
    price: 29,
    storage_mb: 5120,    // 5GB
    egress_mb: 10240,    // 10GB/月
    memory_days: 30,
    projects: 5,
    files_per_msg: 5,
    max_file_mb: 10,
    daily_chats: 200,
    features: ['basic_chat', 'skill_routing', 'file_upload', 'advanced_analysis', 'context_memory', 'priority_routing'],
    cloud_cost: 9.05,
    selling_price: 29,
  },
  team: {
    id: 'team',
    name: '团队版',
    price: 79,
    storage_mb: 20480,   // 20GB
    egress_mb: 51200,    // 50GB/月
    memory_days: -1,     // 无限
    projects: -1,        // 无限
    files_per_msg: 10,
    max_file_mb: 20,
    daily_chats: -1,     // 无限
    features: ['basic_chat', 'skill_routing', 'file_upload', 'advanced_analysis', 'context_memory', 'priority_routing', 'dedicated_support', 'api_access'],
    cloud_cost: 28.60,
    selling_price: 79,
  },
};

// ─── 配额检查 ───

function getTier(tierName) {
  return TIERS[tierName] || TIERS.free;
}

function getUserTier(user) {
  return getTier(user.tier || 'free');
}

/**
 * 检查存储配额
 * @returns {{ allowed: boolean, used_mb: number, limit_mb: number, message?: string }}
 */
function checkStorageQuota(user, additionalBytes = 0) {
  const tier = getUserTier(user);
  const usedMb = (user.storage_used_bytes || 0) / (1024 * 1024);
  const addMb = additionalBytes / (1024 * 1024);
  const allowed = (usedMb + addMb) <= tier.storage_mb;
  return {
    allowed,
    used_mb: Math.round(usedMb * 100) / 100,
    limit_mb: tier.storage_mb,
    remaining_mb: Math.round((tier.storage_mb - usedMb) * 100) / 100,
    message: allowed ? null : `存储空间不足 (已用 ${usedMb.toFixed(1)}MB / ${tier.storage_mb}MB)，请升级套餐`,
  };
}

/**
 * 检查每日对话配额
 */
function checkDailyChatQuota(user, todayChatCount) {
  const tier = getUserTier(user);
  if (tier.daily_chats === -1) return { allowed: true, used: todayChatCount, limit: -1 };
  const allowed = todayChatCount < tier.daily_chats;
  return {
    allowed,
    used: todayChatCount,
    limit: tier.daily_chats,
    message: allowed ? null : `今日对话已达上限 (${tier.daily_chats} 次)，请升级套餐`,
  };
}

/**
 * 检查单条消息附件数
 */
function checkFileCountQuota(user, fileCount) {
  const tier = getUserTier(user);
  const allowed = fileCount <= tier.files_per_msg;
  return {
    allowed,
    limit: tier.files_per_msg,
    message: allowed ? null : `附件数超限 (最多 ${tier.files_per_msg} 个)，请升级套餐`,
  };
}

/**
 * 检查单文件大小
 */
function checkFileSizeQuota(user, fileBytes) {
  const tier = getUserTier(user);
  const maxBytes = tier.max_file_mb * 1024 * 1024;
  const allowed = fileBytes <= maxBytes;
  return {
    allowed,
    limit_mb: tier.max_file_mb,
    message: allowed ? null : `文件超过 ${tier.max_file_mb}MB 限制，请升级套餐`,
  };
}

/**
 * 获取套餐列表 (用于前端展示)
 */
function listTiers() {
  return Object.values(TIERS).map(t => ({
    id: t.id,
    name: t.name,
    price: t.price,
    storage_gb: t.storage_mb / 1024,
    memory_days: t.memory_days,
    projects: t.projects,
    files_per_msg: t.files_per_msg,
    max_file_mb: t.max_file_mb,
    daily_chats: t.daily_chats,
    features: t.features,
    // 成本透明: 展示云成本让用户知道定价合理
    cloud_cost_monthly: Math.round(t.cloud_cost * MARKUP * 100) / 100,
  }));
}

/**
 * 升级/降级用户套餐
 */
function validateTierChange(currentTier, newTier) {
  if (!TIERS[newTier]) return { valid: false, error: '无效套餐' };
  if (currentTier === newTier) return { valid: false, error: '已在该套餐' };
  return { valid: true, tier: TIERS[newTier] };
}

module.exports = {
  TIERS,
  CLOUD_COSTS,
  MARKUP,
  getTier,
  getUserTier,
  checkStorageQuota,
  checkDailyChatQuota,
  checkFileCountQuota,
  checkFileSizeQuota,
  listTiers,
  validateTierChange,
};
