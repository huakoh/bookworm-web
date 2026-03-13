'use strict';

// 极简测试运行器 — 零依赖，支持异步测试
const assert = require('assert');
let passed = 0;
let failed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    failures.push({ name, error: e.message });
    console.log(`  ✗ ${name}: ${e.message}`);
  }
}

async function main() {

// ═══════════════════════════════════════
// 1. crypto-utils 测试
// ═══════════════════════════════════════
console.log('\n[crypto-utils]');

// 设置测试用的 MASTER_KEY
process.env.MASTER_KEY = 'a'.repeat(64);

const { encrypt, decrypt, hashPassword, verifyPassword } = require('../src/crypto-utils');

await test('encrypt → decrypt 往返', async () => {
  const key = 'sk-ant-api03-test-key-1234567890';
  const encrypted = encrypt(key);
  assert.notStrictEqual(encrypted, key, '密文不应等于明文');
  const decrypted = decrypt(encrypted);
  assert.strictEqual(decrypted, key, '解密后应等于原始值');
});

await test('每次加密产生不同密文 (随机 IV)', async () => {
  const key = 'sk-ant-test-key';
  const enc1 = encrypt(key);
  const enc2 = encrypt(key);
  assert.notStrictEqual(enc1, enc2, '两次加密结果应不同');
  assert.strictEqual(decrypt(enc1), decrypt(enc2), '但解密结果相同');
});

await test('篡改密文应抛出错误', async () => {
  const enc = encrypt('sk-ant-test');
  const buf = Buffer.from(enc, 'base64');
  buf[20] ^= 0xff; // 翻转一个字节
  assert.throws(() => decrypt(buf.toString('base64')), '篡改密文应解密失败');
});

// ❾ 新增: 密文格式校验测试
await test('decrypt 空值应抛出错误', async () => {
  assert.throws(() => decrypt(''), /密文不能为空/);
  assert.throws(() => decrypt(null), /密文不能为空/);
});

await test('decrypt 过短密文应抛出错误', async () => {
  const shortBase64 = Buffer.alloc(20).toString('base64');
  assert.throws(() => decrypt(shortBase64), /长度不足/);
});

// ❹ 异步 scrypt 测试
await test('hashPassword + verifyPassword 往返 (async)', async () => {
  const pw = 'my-secure-password-123';
  const hashed = await hashPassword(pw);
  assert.ok(hashed.includes(':'), 'hash 格式应为 salt:hash');
  assert.ok(await verifyPassword(pw, hashed), '正确密码应验证通过');
  assert.ok(!(await verifyPassword('wrong-password', hashed)), '错误密码应验证失败');
});

await test('verifyPassword 损坏格式应抛出错误', async () => {
  try {
    await verifyPassword('test', 'invalid-no-colon');
    assert.fail('应抛出错误');
  } catch (e) {
    assert.ok(e.message.includes('格式损坏'), `期望格式损坏错误，实际: ${e.message}`);
  }
});

// ═══════════════════════════════════════
// 2. rate-limiter 测试
// ═══════════════════════════════════════
console.log('\n[rate-limiter]');

const { RateLimiter } = require('../src/rate-limiter');

await test('在限额内允许请求', async () => {
  const rl = new RateLimiter(5, 60000);
  for (let i = 0; i < 5; i++) {
    const r = rl.check('user-1');
    assert.ok(r.allowed, `第 ${i + 1} 次请求应被允许`);
  }
  rl.destroy();
});

await test('超过限额拒绝请求', async () => {
  const rl = new RateLimiter(3, 60000);
  rl.check('user-2');
  rl.check('user-2');
  rl.check('user-2');
  const r = rl.check('user-2');
  assert.ok(!r.allowed, '第 4 次请求应被拒绝');
  assert.strictEqual(r.remaining, 0);
  rl.destroy();
});

await test('不同用户独立计数', async () => {
  const rl = new RateLimiter(2, 60000);
  rl.check('a');
  rl.check('a');
  const ra = rl.check('a');
  const rb = rl.check('b');
  assert.ok(!ra.allowed, '用户 a 应被限流');
  assert.ok(rb.allowed, '用户 b 不应被限流');
  rl.destroy();
});

await test('remaining 正确递减', async () => {
  const rl = new RateLimiter(5, 60000);
  assert.strictEqual(rl.check('u').remaining, 4);
  assert.strictEqual(rl.check('u').remaining, 3);
  assert.strictEqual(rl.check('u').remaining, 2);
  rl.destroy();
});

// ═══════════════════════════════════════
// 3. router-engine 测试
// ═══════════════════════════════════════
console.log('\n[router-engine]');

const { tokenize, route: routeFn } = require('../src/router-engine');

await test('tokenize 英文', async () => {
  const tokens = tokenize('React bug fix');
  assert.ok(tokens.has('react'), '应包含 react');
  assert.ok(tokens.has('bug'), '应包含 bug');
  assert.ok(tokens.has('fix'), '应包含 fix');
});

await test('tokenize 中文滑动窗口', async () => {
  const tokens = tokenize('数据库优化');
  assert.ok(tokens.has('数据'), '应包含 数据');
  assert.ok(tokens.has('据库'), '应包含 据库');
  assert.ok(tokens.has('数据库'), '应包含 数据库');
  assert.ok(tokens.has('优化'), '应包含 优化');
});

await test('tokenize 混合中英文', async () => {
  const tokens = tokenize('React 组件性能优化');
  assert.ok(tokens.has('react'), '应包含 react');
  assert.ok(tokens.has('性能'), '应包含 性能');
  assert.ok(tokens.has('优化'), '应包含 优化');
});

// 路由测试 (需要 skills-index.json 可读)
const fs = require('fs');
const indexPath = process.env.BOOKWORM_SKILLS_INDEX
  || require('path').join(process.env.USERPROFILE || '', '.claude', 'skills-index.json');

if (fs.existsSync(indexPath)) {
  await test('route() 返回结构正确', async () => {
    const result = routeFn('帮我写一个 React 组件');
    assert.ok(result.primary, '应有 primary');
    assert.ok(typeof result.confidence === 'number', 'confidence 应为数字');
    assert.ok(Array.isArray(result.candidates), 'candidates 应为数组');
    assert.ok(typeof result.latencyMs === 'number', 'latencyMs 应为数字');
    assert.ok(result.latencyMs < 100, `延迟应 <100ms，实际: ${result.latencyMs}ms`);
  });

  await test('route() 中文路由正确', async () => {
    const result = routeFn('数据库性能优化，查询太慢了');
    assert.ok(result.candidates.length > 0, '应有候选技能');
    console.log(`    → primary: ${result.primary}, confidence: ${result.confidence}, ${result.latencyMs}ms`);
  });

  await test('route() 英文路由正确', async () => {
    const result = routeFn('Docker CI/CD pipeline setup');
    assert.ok(result.candidates.length > 0, '应有候选技能');
    console.log(`    → primary: ${result.primary}, confidence: ${result.confidence}, ${result.latencyMs}ms`);
  });

  await test('route() 低置信度回退', async () => {
    const result = routeFn('xyz abc 123');
    // 无意义输入应低置信度或使用默认路由
    assert.ok(result.primary, '应有 primary (默认回退)');
    console.log(`    → primary: ${result.primary}, confidence: ${result.confidence}`);
  });

  // ❿ 消歧规则 mode: 'all' 测试
  await test('消歧规则: react+bug 需同时出现才触发', async () => {
    const r1 = routeFn('React 组件有个 bug 需要修复');
    const r2 = routeFn('React 组件开发');
    // r1 包含 react+bug，应触发 debugger boost
    // r2 只有 react，不应触发 react+bug 规则
    console.log(`    → react+bug: ${r1.primary} | react only: ${r2.primary}`);
    assert.ok(r1.firedRules.length >= r2.firedRules.length, 'react+bug 应触发更多规则');
  });

  await test('route() 性能: 100 次路由 <500ms', async () => {
    const start = Date.now();
    for (let i = 0; i < 100; i++) {
      routeFn('帮我优化 React 组件的性能问题');
    }
    const elapsed = Date.now() - start;
    console.log(`    → 100 次路由耗时: ${elapsed}ms (${(elapsed / 100).toFixed(1)}ms/次)`);
    assert.ok(elapsed < 500, `100 次路由应 <500ms，实际: ${elapsed}ms`);
  });
} else {
  console.log('  ⚠ skills-index.json 未找到，跳过路由测试');
}

// ═══════════════════════════════════════
// 4. SSRF 防护测试
// ═══════════════════════════════════════
console.log('\n[proxy - SSRF 防护]');

const { validateBaseUrl } = require('../src/proxy');

await test('❶ 允许 api.anthropic.com', async () => {
  validateBaseUrl('https://api.anthropic.com');
  // 不抛出 = 通过
});

await test('❶ 允许空值 (使用默认)', async () => {
  validateBaseUrl(null);
  validateBaseUrl(undefined);
});

// validateBaseUrl 抛出 { status, message } 业务对象，需用 try-catch 断言
function assertThrowsMsg(fn, pattern, desc) {
  try {
    fn();
    assert.fail(desc || '应抛出错误');
  } catch (e) {
    if (e.code === 'ERR_ASSERTION') throw e;
    assert.ok(pattern.test(e.message), `期望匹配 ${pattern}，实际: ${e.message}`);
  }
}

await test('❶ 阻止 localhost', async () => {
  assertThrowsMsg(() => validateBaseUrl('http://localhost:6379'), /内网/);
});

await test('❶ 阻止 127.0.0.1', async () => {
  assertThrowsMsg(() => validateBaseUrl('http://127.0.0.1:8080'), /内网/);
});

await test('❶ 阻止 10.x 内网', async () => {
  assertThrowsMsg(() => validateBaseUrl('http://10.0.0.1:80'), /内网/);
});

await test('❶ 阻止 192.168.x 内网', async () => {
  assertThrowsMsg(() => validateBaseUrl('http://192.168.1.1'), /内网/);
});

await test('❶ 阻止 169.254 链路本地', async () => {
  assertThrowsMsg(() => validateBaseUrl('http://169.254.169.254/latest/meta-data/'), /内网/);
});

await test('❶ 允许公网地址 (自定义中转)', async () => {
  validateBaseUrl('https://my-claude-proxy.example.com');
});

await test('❶ 拒绝无效 URL', async () => {
  assertThrowsMsg(() => validateBaseUrl('not-a-url'), /格式无效/);
});

// ═══════════════════════════════════════
// 结果汇总
// ═══════════════════════════════════════
console.log(`\n${'═'.repeat(40)}`);
console.log(`结果: ${passed} 通过, ${failed} 失败`);
if (failures.length > 0) {
  console.log('\n失败用例:');
  for (const f of failures) {
    console.log(`  ✗ ${f.name}: ${f.error}`);
  }
}
console.log();

process.exit(failed > 0 ? 1 : 0);

} // end main

main();
