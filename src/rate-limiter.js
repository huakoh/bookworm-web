'use strict';

// 滑动窗口限流器 — 内存实现，无外部依赖
// 适用于 < 100 并发用户的单进程场景

class RateLimiter {
  /**
   * @param {number} maxRequests - 窗口内最大请求数
   * @param {number} windowMs - 窗口大小 (毫秒)
   */
  constructor(maxRequests = 30, windowMs = 60_000) {
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
    /** @type {Map<string, number[]>} userId → 时间戳数组 */
    this.windows = new Map();

    // 每 5 分钟清理过期条目，防止内存泄漏
    this.cleanupTimer = setInterval(() => this._cleanup(), 5 * 60_000);
    this.cleanupTimer.unref();
  }

  /**
   * 检查并记录请求
   * @param {string} key - 用户标识 (userId 或 IP)
   * @returns {{ allowed: boolean, remaining: number, resetMs: number }}
   */
  check(key) {
    const now = Date.now();
    const cutoff = now - this.windowMs;

    let timestamps = this.windows.get(key);
    if (!timestamps) {
      timestamps = [];
      this.windows.set(key, timestamps);
    }

    // 移除窗口外的时间戳
    while (timestamps.length > 0 && timestamps[0] <= cutoff) {
      timestamps.shift();
    }

    const remaining = Math.max(0, this.maxRequests - timestamps.length);
    const resetMs = timestamps.length > 0
      ? timestamps[0] + this.windowMs - now
      : this.windowMs;

    if (timestamps.length >= this.maxRequests) {
      return { allowed: false, remaining: 0, resetMs };
    }

    timestamps.push(now);
    return { allowed: true, remaining: remaining - 1, resetMs };
  }

  _cleanup() {
    const cutoff = Date.now() - this.windowMs;
    for (const [key, timestamps] of this.windows) {
      while (timestamps.length > 0 && timestamps[0] <= cutoff) {
        timestamps.shift();
      }
      if (timestamps.length === 0) {
        this.windows.delete(key);
      }
    }
  }

  destroy() {
    clearInterval(this.cleanupTimer);
    this.windows.clear();
  }
}

module.exports = { RateLimiter };
