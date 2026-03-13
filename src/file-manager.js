'use strict';

// ─── 文件管理器 ───
// 文件上传/下载/LLM多模态转换
// 零外部依赖，使用 filesystem + JSON 元数据

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');

const ossStorage = require('./oss-storage');

const UPLOADS_DIR = path.join(__dirname, '..', 'data', 'uploads');
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const MAX_FILES_PER_MSG = 5;

// 允许的 MIME 类型
const ALLOWED_MIME = {
  // 图片
  'image/jpeg': { category: 'image', ext: '.jpg' },
  'image/png': { category: 'image', ext: '.png' },
  'image/gif': { category: 'image', ext: '.gif' },
  'image/webp': { category: 'image', ext: '.webp' },
  'image/svg+xml': { category: 'image', ext: '.svg' },
  // 文档
  'application/pdf': { category: 'pdf', ext: '.pdf' },
  // 文本
  'text/plain': { category: 'text', ext: '.txt' },
  'text/markdown': { category: 'text', ext: '.md' },
  'text/csv': { category: 'text', ext: '.csv' },
  'text/html': { category: 'code', ext: '.html' },
  'text/css': { category: 'code', ext: '.css' },
  'text/xml': { category: 'text', ext: '.xml' },
  // 代码
  'application/javascript': { category: 'code', ext: '.js' },
  'text/javascript': { category: 'code', ext: '.js' },
  'application/json': { category: 'code', ext: '.json' },
  'application/typescript': { category: 'code', ext: '.ts' },
  'text/x-python': { category: 'code', ext: '.py' },
  'text/x-java': { category: 'code', ext: '.java' },
  'text/x-c': { category: 'code', ext: '.c' },
  'text/x-go': { category: 'code', ext: '.go' },
  'text/x-rust': { category: 'code', ext: '.rs' },
  'application/x-yaml': { category: 'code', ext: '.yaml' },
  'text/yaml': { category: 'code', ext: '.yaml' },
};

// MIME 不在表中时根据扩展名推断
const EXT_FALLBACK = {
  '.js': { category: 'code', mime: 'application/javascript' },
  '.ts': { category: 'code', mime: 'application/typescript' },
  '.tsx': { category: 'code', mime: 'application/typescript' },
  '.jsx': { category: 'code', mime: 'application/javascript' },
  '.py': { category: 'code', mime: 'text/x-python' },
  '.go': { category: 'code', mime: 'text/x-go' },
  '.rs': { category: 'code', mime: 'text/x-rust' },
  '.java': { category: 'code', mime: 'text/x-java' },
  '.c': { category: 'code', mime: 'text/x-c' },
  '.cpp': { category: 'code', mime: 'text/x-c' },
  '.h': { category: 'code', mime: 'text/x-c' },
  '.sh': { category: 'code', mime: 'text/plain' },
  '.sql': { category: 'code', mime: 'text/plain' },
  '.yaml': { category: 'code', mime: 'application/x-yaml' },
  '.yml': { category: 'code', mime: 'application/x-yaml' },
  '.toml': { category: 'code', mime: 'text/plain' },
  '.md': { category: 'text', mime: 'text/markdown' },
  '.txt': { category: 'text', mime: 'text/plain' },
  '.csv': { category: 'text', mime: 'text/csv' },
  '.json': { category: 'code', mime: 'application/json' },
  '.html': { category: 'code', mime: 'text/html' },
  '.css': { category: 'code', mime: 'text/css' },
  '.xml': { category: 'text', mime: 'text/xml' },
  '.pdf': { category: 'pdf', mime: 'application/pdf' },
  '.jpg': { category: 'image', mime: 'image/jpeg' },
  '.jpeg': { category: 'image', mime: 'image/jpeg' },
  '.png': { category: 'image', mime: 'image/png' },
  '.gif': { category: 'image', mime: 'image/gif' },
  '.webp': { category: 'image', mime: 'image/webp' },
  '.svg': { category: 'image', mime: 'image/svg+xml' },
};

// ─── 辅助 ───

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function getUserDir(userId) {
  const dir = path.join(UPLOADS_DIR, String(userId));
  ensureDir(dir);
  return dir;
}

function getMetaPath(userId) {
  return path.join(getUserDir(userId), 'metadata.json');
}

function loadMeta(userId) {
  const p = getMetaPath(userId);
  if (!fs.existsSync(p)) return [];
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return []; }
}

function saveMeta(userId, meta) {
  const p = getMetaPath(userId);
  // 原子写: 先写 tmp 再 rename
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(meta, null, 2), 'utf8');
  fs.renameSync(tmp, p);
}

function resolveCategory(mimeType, fileName) {
  if (ALLOWED_MIME[mimeType]) return ALLOWED_MIME[mimeType];
  const ext = path.extname(fileName || '').toLowerCase();
  if (EXT_FALLBACK[ext]) return { category: EXT_FALLBACK[ext].category, ext };
  return null;
}

// ─── 验证 ───

function validateFile({ name, mimeType, data }) {
  if (!name || typeof name !== 'string') return { valid: false, error: '缺少文件名' };
  if (!data || typeof data !== 'string') return { valid: false, error: '缺少文件数据' };

  // 安全: 清理文件名
  const cleanName = path.basename(name).replace(/[^\w.\-\u4e00-\u9fff]/g, '_');
  if (!cleanName) return { valid: false, error: '无效文件名' };

  // 检测类型
  const typeInfo = resolveCategory(mimeType, name);
  if (!typeInfo) return { valid: false, error: `不支持的文件类型: ${mimeType || path.extname(name)}` };

  // 检查 base64 大小 (base64 编码后约为原文件 4/3 倍)
  const estimatedSize = Math.ceil(data.length * 3 / 4);
  if (estimatedSize > MAX_FILE_SIZE) {
    return { valid: false, error: `文件 ${cleanName} 超过 10MB 限制 (${(estimatedSize / 1024 / 1024).toFixed(1)}MB)` };
  }

  return { valid: true, cleanName, typeInfo };
}

// ─── 文件操作 ───

function saveFile(userId, { name, mimeType, data }) {
  const validation = validateFile({ name, mimeType, data });
  if (!validation.valid) throw { status: 400, message: validation.error };

  const fileId = 'f_' + crypto.randomUUID().replace(/-/g, '').slice(0, 12);
  const ext = validation.typeInfo.ext || path.extname(name).toLowerCase() || '.bin';
  const storedName = fileId + ext;
  const userDir = getUserDir(userId);
  const actualMime = mimeType || 'application/octet-stream';

  // 解码并写入
  const buffer = Buffer.from(data, 'base64');

  // 始终写本地 (作为缓存/fallback)
  fs.writeFileSync(path.join(userDir, storedName), buffer);

  // 异步上传 OSS (不阻塞响应)
  let ossKey = null;
  if (ossStorage.OSS_CONFIG.enabled) {
    ossKey = `${ossStorage.OSS_CONFIG.prefix}${userId}/${storedName}`;
    ossStorage.storeFile(userId, storedName, buffer, actualMime).catch(e => {
      process.stderr.write(`OSS 上传失败: ${e.message}\n`);
    });
  }

  const meta = {
    fileId,
    originalName: validation.cleanName,
    storedName,
    mimeType: actualMime,
    size: buffer.length,
    category: validation.typeInfo.category,
    backend: ossStorage.OSS_CONFIG.enabled ? 'oss' : 'local',
    ossKey,
    createdAt: new Date().toISOString(),
  };

  // 追加元数据
  const allMeta = loadMeta(userId);
  allMeta.push(meta);
  saveMeta(userId, allMeta);

  return meta;
}

function getFile(userId, fileId) {
  const allMeta = loadMeta(userId);
  const meta = allMeta.find(m => m.fileId === fileId);
  if (!meta) return null;
  const filePath = path.join(getUserDir(userId), meta.storedName);
  if (!fs.existsSync(filePath)) return null;
  return { metadata: meta, filePath };
}

function deleteFile(userId, fileId) {
  const allMeta = loadMeta(userId);
  const idx = allMeta.findIndex(m => m.fileId === fileId);
  if (idx === -1) return false;
  const meta = allMeta[idx];
  // 删除本地文件
  const filePath = path.join(getUserDir(userId), meta.storedName);
  try { fs.unlinkSync(filePath); } catch {}
  // 异步删除 OSS 对象
  if (meta.ossKey) {
    ossStorage.removeFile(userId, meta.storedName, meta.ossKey).catch(() => {});
  }
  allMeta.splice(idx, 1);
  saveMeta(userId, allMeta);
  return true;
}

function listFiles(userId) {
  return loadMeta(userId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

// ─── LLM 多模态转换 ───
// 将文件转换为各 LLM provider 支持的 content block

function getFileForLLM(userId, fileId, providerName) {
  const file = getFile(userId, fileId);
  if (!file) return { type: 'text', text: `[文件 ${fileId} 未找到]` };

  const { metadata, filePath } = file;
  const base64 = fs.readFileSync(filePath).toString('base64');

  // ── 图片 ──
  if (metadata.category === 'image') {
    // SVG 作为文本处理
    if (metadata.mimeType === 'image/svg+xml') {
      const svgText = fs.readFileSync(filePath, 'utf8');
      return { type: 'text', text: `[SVG 文件: ${metadata.originalName}]\n\`\`\`svg\n${svgText}\n\`\`\`` };
    }

    switch (providerName) {
      case 'anthropic':
        return {
          type: 'image',
          source: { type: 'base64', media_type: metadata.mimeType, data: base64 },
        };
      case 'openai':
      case 'qwen':
        return {
          type: 'image_url',
          image_url: { url: `data:${metadata.mimeType};base64,${base64}` },
        };
      case 'deepseek':
        // DeepSeek V3 不支持视觉，给出文字提示
        return {
          type: 'text',
          text: `[已附加图片: ${metadata.originalName} (${formatSize(metadata.size)}), DeepSeek 不支持图片分析，请切换到 Claude 或 GPT-4o]`,
        };
      default:
        return {
          type: 'image_url',
          image_url: { url: `data:${metadata.mimeType};base64,${base64}` },
        };
    }
  }

  // ── PDF ──
  if (metadata.category === 'pdf') {
    if (providerName === 'anthropic') {
      // Anthropic 原生支持 PDF
      return {
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: base64 },
      };
    }
    // 其他 provider: 尝试提取文本
    const text = extractPdfText(filePath);
    return {
      type: 'text',
      text: text
        ? `[PDF 文档: ${metadata.originalName}]\n${text}`
        : `[PDF 文档: ${metadata.originalName}, ${formatSize(metadata.size)}, 无法提取文本，请切换到 Claude]`,
    };
  }

  // ── 文本/代码 ──
  const textContent = fs.readFileSync(filePath, 'utf8');
  const langMap = { '.py': 'python', '.js': 'javascript', '.ts': 'typescript', '.go': 'go', '.rs': 'rust', '.java': 'java', '.c': 'c', '.cpp': 'cpp', '.html': 'html', '.css': 'css', '.json': 'json', '.yaml': 'yaml', '.yml': 'yaml', '.sql': 'sql', '.sh': 'bash', '.md': 'markdown', '.xml': 'xml' };
  const ext = path.extname(metadata.originalName).toLowerCase();
  const lang = langMap[ext] || '';
  return {
    type: 'text',
    text: `[文件: ${metadata.originalName}]\n\`\`\`${lang}\n${textContent}\n\`\`\``,
  };
}

// ─── 简易 PDF 文本提取 (纯 Node.js, 仅适用于简单 PDF) ───

function extractPdfText(filePath) {
  try {
    const buf = fs.readFileSync(filePath);
    const raw = buf.toString('latin1');
    const texts = [];

    // 查找所有 stream ... endstream 内容
    const streamRe = /stream\r?\n([\s\S]*?)endstream/g;
    let match;
    while ((match = streamRe.exec(raw)) !== null) {
      let content = match[1];
      // 尝试解压 FlateDecode
      try {
        const compressed = Buffer.from(content, 'latin1');
        content = zlib.inflateSync(compressed).toString('utf8');
      } catch { /* 非压缩流, 保持原始 */ }

      // 提取 BT...ET 之间的文本操作
      const btRe = /BT\s([\s\S]*?)ET/g;
      let btMatch;
      while ((btMatch = btRe.exec(content)) !== null) {
        const ops = btMatch[1];
        // 提取 Tj 和 TJ 操作中的文本
        const tjRe = /\(([^)]*)\)\s*Tj/g;
        let tj;
        while ((tj = tjRe.exec(ops)) !== null) {
          texts.push(tj[1]);
        }
        // TJ 数组
        const tjArrayRe = /\[(.*?)\]\s*TJ/g;
        let tja;
        while ((tja = tjArrayRe.exec(ops)) !== null) {
          const items = tja[1].match(/\(([^)]*)\)/g);
          if (items) texts.push(items.map(s => s.slice(1, -1)).join(''));
        }
      }
    }

    const result = texts.join(' ').trim();
    // 如果提取到的文本太短，可能是编码问题
    return result.length > 20 ? result.slice(0, 50000) : ''; // 限制 50K 字符
  } catch {
    return '';
  }
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + 'B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + 'KB';
  return (bytes / 1024 / 1024).toFixed(1) + 'MB';
}

// ─── 构建多模态消息内容 ───
// 将 chatHistory 中含附件的消息转换为 LLM 兼容格式

function buildMultimodalContent(userId, message, providerName) {
  if (!message.fileIds || message.fileIds.length === 0) {
    return message.content; // 纯文本, 保持字符串格式
  }

  const blocks = [];

  // 先加文件内容
  for (const fileId of message.fileIds) {
    blocks.push(getFileForLLM(userId, fileId, providerName));
  }

  // 再加用户文本
  if (message.content) {
    blocks.push({ type: 'text', text: message.content });
  }

  return blocks;
}

module.exports = {
  saveFile,
  getFile,
  deleteFile,
  listFiles,
  validateFile,
  getFileForLLM,
  buildMultimodalContent,
  formatSize,
  MAX_FILE_SIZE,
  MAX_FILES_PER_MSG,
  UPLOADS_DIR,
};
