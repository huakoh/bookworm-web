'use strict';

// ─── #6 登录暴力破解防护 ───
// 连续失败 N 次后锁定 M 分钟

class LoginGuard {
  /**
   * @param {number} maxAttempts - 最大连续失败次数
   * @param {number} lockDurationMs - 锁定时长 (毫秒)
   */
  constructor(maxAttempts = 5, lockDurationMs = 15 * 60_000) {
    this.maxAttempts = maxAttempts;
    this.lockDurationMs = lockDurationMs;
    /** @type {Map<string, { count: number, lockUntil: number }>} */
    this.attempts = new Map();

    // 定期清理过期条目
    this.cleanupTimer = setInterval(() => this._cleanup(), 10 * 60_000);
    this.cleanupTimer.unref();
  }

  /**
   * 检查是否被锁定
   * @param {string} email
   * @returns {{ locked: boolean, retryAfterMs: number }}
   */
  check(email) {
    const key = email.toLowerCase();
    const record = this.attempts.get(key);
    if (!record) return { locked: false, retryAfterMs: 0 };

    const now = Date.now();
    if (record.lockUntil > now) {
      return { locked: true, retryAfterMs: record.lockUntil - now };
    }

    // 锁定已过期，重置
    if (record.lockUntil > 0) {
      this.attempts.delete(key);
    }

    return { locked: false, retryAfterMs: 0 };
  }

  /**
   * 记录失败登录
   * @param {string} email
   */
  recordFailure(email) {
    const key = email.toLowerCase();
    const record = this.attempts.get(key) || { count: 0, lockUntil: 0 };
    record.count++;

    if (record.count >= this.maxAttempts) {
      record.lockUntil = Date.now() + this.lockDurationMs;
    }

    this.attempts.set(key, record);
  }

  /**
   * 登录成功后重置计数
   * @param {string} email
   */
  recordSuccess(email) {
    this.attempts.delete(email.toLowerCase());
  }

  _cleanup() {
    const now = Date.now();
    for (const [key, record] of this.attempts) {
      if (record.lockUntil > 0 && record.lockUntil < now) {
        this.attempts.delete(key);
      }
    }
  }

  destroy() {
    clearInterval(this.cleanupTimer);
    this.attempts.clear();
  }
}

module.exports = { LoginGuard };
