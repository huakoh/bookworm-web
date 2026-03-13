'use strict';

const fs = require('fs');
const path = require('path');

// ─── 独立 BM25 路由引擎 ───
// 只读引用 skills-index.json，不修改任何 .claude 文件
// 完整复刻 route-analyzer.js 的核心算法

const BM25_K1 = 1.2;
const BM25_B = 0.75;
const IDF_FLOOR = Math.log(2);

let _index = null;
let _bm25Params = null;
let _lastLoadTime = 0;
const INDEX_RELOAD_INTERVAL = 5 * 60_000; // 5 分钟热重载

// ─── 中文分词 + 英文 tokenize ───

/** 中文 2-4 字滑动窗口 + 英文单词提取 */
function tokenize(text) {
  const tokens = new Set();
  const lower = text.toLowerCase().trim();

  // 英文单词
  const enWords = lower.match(/[a-z][a-z0-9._-]*/g) || [];
  for (const w of enWords) tokens.add(w);

  // 中文字符提取
  const cnChars = lower.match(/[\u4e00-\u9fff]+/g) || [];
  for (const seg of cnChars) {
    // 2-4 字滑动窗口
    for (let len = 2; len <= Math.min(4, seg.length); len++) {
      for (let i = 0; i <= seg.length - len; i++) {
        tokens.add(seg.substring(i, i + len));
      }
    }
    // 单字也加入
    for (const ch of seg) tokens.add(ch);
  }

  return tokens;
}

// ─── 索引加载 ───

function getIndexPath() {
  const envPath = process.env.BOOKWORM_SKILLS_INDEX;
  if (envPath) return path.normalize(envPath);
  // 默认: 用户主目录下的 .claude/skills-index.json
  const home = process.env.USERPROFILE || process.env.HOME || '';
  return path.join(home, '.claude', 'skills-index.json');
}

function loadIndex() {
  const now = Date.now();
  if (_index && now - _lastLoadTime < INDEX_RELOAD_INTERVAL) {
    return _index;
  }

  const indexPath = getIndexPath();
  if (!fs.existsSync(indexPath)) {
    throw new Error(`技能索引不存在: ${indexPath}`);
  }

  const raw = fs.readFileSync(indexPath, 'utf8');
  _index = JSON.parse(raw);
  _bm25Params = buildBM25Params(_index.skills);
  _lastLoadTime = now;
  return _index;
}

// ─── BM25 参数构建 ───

function buildBM25Params(skills) {
  const N = skills.length;
  // 每个 skill 的"文档长度" = 关键词数量
  const docLengths = skills.map(s => (s.keywords || []).length);
  const avgdl = docLengths.reduce((a, b) => a + b, 0) / N;

  // 计算每个 keyword 在多少 skill 中出现 (document frequency)
  const df = {};
  for (const skill of skills) {
    const seen = new Set();
    for (const kw of (skill.keywords || [])) {
      if (!seen.has(kw.keyword)) {
        df[kw.keyword] = (df[kw.keyword] || 0) + 1;
        seen.add(kw.keyword);
      }
    }
  }

  // IDF
  const idf = {};
  for (const [term, freq] of Object.entries(df)) {
    idf[term] = Math.max(IDF_FLOOR, Math.log((N - freq + 0.5) / (freq + 0.5) + 1));
  }

  return { N, avgdl, idf, df, docLengths };
}

// ─── BM25 评分 ───

function computeBM25(tf, idf, dl, avgdl) {
  const numerator = tf * (BM25_K1 + 1);
  const denominator = tf + BM25_K1 * (1 - BM25_B + BM25_B * (dl / avgdl));
  return idf * (numerator / denominator);
}

function scoreSkill(skill, queryTokens, params, skillIdx) {
  const keywords = skill.keywords || [];
  const dl = params.docLengths[skillIdx];
  let totalScore = 0;
  const matchedKeywords = [];

  for (const kw of keywords) {
    if (queryTokens.has(kw.keyword)) {
      const idf = params.idf[kw.keyword] || IDF_FLOOR;
      // tf = tfidfWeight 作为加权 (核心权重越高匹配分越高)
      const tf = kw.tfidfWeight || 1.0;
      const bm25 = computeBM25(tf, idf, dl, params.avgdl);
      totalScore += bm25;
      matchedKeywords.push(kw.keyword);
    }
  }

  return { totalScore, matchedKeywords };
}

// ─── 消歧规则 (内置精简版) ───

// ❿ 消歧规则 — mode: 'all' 需全部命中, 'any' 任一命中
const DISAMBIGUATION_RULES = [
  { trigger: ['react', 'bug'],         boost: 'debugger-expert',       penalty: 'frontend-expert',      weight: 0.3,  mode: 'all' },
  { trigger: ['api', '安全'],           boost: 'security-expert',       penalty: 'api-designer',         weight: 0.3,  mode: 'all' },
  { trigger: ['数据库', '架构'],         boost: 'architect-expert',      penalty: 'database-tuning-expert', weight: 0.3, mode: 'all' },
  { trigger: ['代码', '评审'],           boost: 'reviewer-expert',       penalty: 'developer-expert',     weight: 0.3,  mode: 'all' },
  { trigger: ['报错', 'bug', '错误'],    boost: 'debugger-expert',       penalty: 'developer-expert',     weight: 0.25, mode: 'any' },
  { trigger: ['性能', '优化', '慢'],     boost: 'performance-expert',    penalty: 'developer-expert',     weight: 0.25, mode: 'any' },
  { trigger: ['k8s', '部署'],           boost: 'cloud-native-expert',   penalty: 'devops-expert',        weight: 0.2,  mode: 'all' },
  { trigger: ['docker', 'ci'],          boost: 'devops-expert',         penalty: 'cloud-native-expert',  weight: 0.2,  mode: 'all' },
  { trigger: ['从零', '搭建'],          boost: 'genesis-engine',        penalty: null,                   weight: 0.3,  mode: 'any' },
  { trigger: ['测试', '漏洞'],          boost: 'security-expert',       penalty: 'tester-expert',        weight: 0.2,  mode: 'all' },
  { trigger: ['api', '文档'],           boost: 'tech-writer-expert',    penalty: 'api-designer',         weight: 0.2,  mode: 'all' },
  { trigger: ['webhook', '工作流'],     boost: 'workflow-automation-expert', penalty: 'api-integration-specialist', weight: 0.2, mode: 'all' },
  { trigger: ['小程序'],                boost: 'miniprogram-expert',    penalty: 'frontend-expert',      weight: 0.3,  mode: 'any' },
  { trigger: ['flutter'],              boost: 'flutter-expert',        penalty: 'mobile-expert',        weight: 0.3,  mode: 'any' },
];

function applyDisambiguation(results, queryTokens) {
  const firedRules = [];

  for (const rule of DISAMBIGUATION_RULES) {
    const matchFn = rule.mode === 'all' ? 'every' : 'some';
    const triggerMatch = rule.trigger[matchFn](t => queryTokens.has(t));
    if (!triggerMatch) continue;

    firedRules.push(rule.trigger.join('+'));

    for (const r of results) {
      if (r.name === rule.boost) {
        r.score += rule.weight;
      } else if (r.name === rule.penalty) {
        r.score -= rule.weight * 0.5;
      }
    }
  }

  // 重新排序
  results.sort((a, b) => b.score - a.score);
  return { results, firedRules };
}

// ─── 归一化 ───

function normalizeScores(results) {
  if (results.length === 0) return [];
  const maxScore = results[0].score;
  if (maxScore <= 0) return results.map(r => ({ ...r, confidence: 0 }));
  return results.map(r => ({
    ...r,
    confidence: Math.round(Math.max(0, r.score / maxScore) * 100) / 100,
  }));
}

// ─── 主入口 ───

/**
 * 路由分析：输入文本，返回最匹配的技能
 * @param {string} text - 用户输入
 * @returns {{ primary: string, confidence: number, candidates: Array, firedRules: string[], latencyMs: number }}
 */
function route(text) {
  const startTime = Date.now();
  const index = loadIndex();
  const skills = index.skills || [];
  const queryTokens = tokenize(text);

  // BM25 评分
  let results = skills.map((skill, idx) => {
    const { totalScore, matchedKeywords } = scoreSkill(skill, queryTokens, _bm25Params, idx);
    return {
      name: skill.name,
      score: totalScore,
      matchedKeywords,
      description: skill.description || '',
    };
  });

  // 过滤零分
  results = results.filter(r => r.score > 0);

  // 消歧
  const { firedRules } = applyDisambiguation(results, queryTokens);

  // 归一化
  results = normalizeScores(results);

  // 取 Top 5
  const top5 = results.slice(0, 5);

  // 置信度判断
  const primary = top5[0] || { name: 'developer-expert', confidence: 0.5 };
  const gap = top5.length >= 2 ? primary.confidence - top5[1].confidence : 1;

  // 复杂度判断
  let complexity = 'simple';
  if (queryTokens.size > 20 || text.length > 200) complexity = 'complex';
  else if (queryTokens.size > 8 || text.length > 50) complexity = 'medium';

  const latencyMs = Date.now() - startTime;

  return {
    primary: primary.name,
    confidence: primary.confidence,
    gap,
    complexity,
    candidates: top5.map(r => ({
      name: r.name,
      confidence: r.confidence,
      matchedKeywords: r.matchedKeywords,
    })),
    firedRules,
    latencyMs,
    indexVersion: index.version || 'unknown',
    skillCount: skills.length,
  };
}

/**
 * 获取所有技能列表 (不含关键词详情)
 */
function listSkills() {
  const index = loadIndex();
  return (index.skills || []).map(s => ({
    name: s.name,
    description: s.description || '',
    maturity: s.maturity || 'stable',
    isComposable: s.isComposable || false,
    keywordCount: (s.keywords || []).length,
  }));
}

/**
 * 获取索引元信息
 */
function getIndexMeta() {
  const index = loadIndex();
  return {
    version: index.version,
    generated: index.generated,
    skillCount: index.skillCount || (index.skills || []).length,
  };
}

module.exports = { route, listSkills, getIndexMeta, tokenize };
