import express from 'express';
import path from 'node:path';
import multer from 'multer';
import { readFile, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync } from 'node:fs';
import { createPdfSearchProvider } from './pdfsearch-provider.js';
import { createLlmProvider } from './llm-provider.js';
import { startIndexWorker } from './index-worker.js';
import { reviewWordFile } from './word-review.js';
import { addReviewIssues, createReviewTask, getReviewTask, listReviewTasks, updateReviewTask } from './review-store.js';
import { initDb, checkDb } from './db.js';
import {
  createAuthSession,
  createUser,
  deleteAuthSession,
  deleteUser,
  ensureBootstrapAdmin,
  findUserByUsername,
  getAuthSession,
  listUsers,
  touchLastLogin,
  updateUser,
  validatePassword,
  verifyPassword,
} from './auth-store.js';
import {
  createDocument,
  deleteDocument,
  documentStats,
  getDocument,
  listDocuments,
  requeueDocuments,
  toFrontendDocument,
  updateDocument,
} from './document-store.js';
import {
  addCitations,
  addMessage,
  createConversation,
  deleteConversation,
  deleteMessage,
  getConversation,
  getMessage,
  listConversationsWithMessages,
  loadConversationMessages,
  updateConversation,
} from './conversation-store.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 8787);
const PDFSEARCH_BASE_URL = process.env.PDFSEARCH_BASE_URL || 'http://127.0.0.1:8000';
const PDFSEARCH_API_KEY = process.env.PDFSEARCH_API_KEY || '';
const CONSOLE_USER = process.env.CONSOLE_USER || 'admin';
const CONSOLE_PASSWORD = process.env.CONSOLE_PASSWORD || 'admin';
const SESSION_COOKIE = 'zhisuo_session';
const CSRF_COOKIE = 'zhisuo_csrf';
const VIRTUAL_DATASET_ID = 'pdfsearch';
const UPLOAD_DIR = path.resolve(__dirname, '../../data/uploads');
const UPLOAD_MAX_BYTES = Number(process.env.UPLOAD_MAX_BYTES || 500 * 1024 * 1024);

mkdirSync(UPLOAD_DIR, { recursive: true });

const app = express();
const upload = multer({
  dest: UPLOAD_DIR,
  limits: { fileSize: UPLOAD_MAX_BYTES },
});
const pdfsearch = createPdfSearchProvider({
  baseUrl: PDFSEARCH_BASE_URL,
  apiKey: PDFSEARCH_API_KEY,
});
const llm = createLlmProvider({
  baseUrl: process.env.LLM_BASE_URL || '',
  apiKey: process.env.LLM_API_KEY || '',
  model: process.env.LLM_MODEL || '',
});

try {
  await initDb();
  await ensureBootstrapAdmin(CONSOLE_USER, CONSOLE_PASSWORD);
  if (process.env.WORKER_ENABLED !== 'false') startIndexWorker();
} catch (error) {
  console.error('[zhisuo] PostgreSQL initialization failed:', error);
  process.exit(1);
}

app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));

function createCsrfToken() {
  return randomUUID().replace(/-/g, '');
}

function setCsrfCookie(res, token = createCsrfToken()) {
  res.setHeader(
    'Set-Cookie',
    `${CSRF_COOKIE}=${token}; SameSite=Lax; Path=/; Max-Age=604800`,
  );
  return token;
}

app.use((req, res, next) => {
  const method = String(req.method || 'GET').toUpperCase();
  if (['GET', 'HEAD', 'OPTIONS'].includes(method)) return next();
  if (req.path === '/api/auth/login') return next();
  const cookies = parseCookies(req.headers.cookie);
  const expected = cookies[CSRF_COOKIE];
  const actual = req.headers['x-csrf-token'];
  if (!expected || actual !== expected) {
    return res.status(403).json({ code: 403, message: 'CSRF token invalid' });
  }
  return next();
});


function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').map((part) => {
    const [key, ...rest] = part.trim().split('=');
    return [key, decodeURIComponent(rest.join('=') || '')];
  }).filter(([key]) => key));
}

function sessionToken(req) {
  return parseCookies(req.headers.cookie)[SESSION_COOKIE] || '';
}

async function requireSession(req, res, next) {
  try {
    const auth = await getAuthSession(sessionToken(req));
    if (!auth) return res.status(401).json({ code: 401, message: '请先登录' });
    req.zhisuoUser = auth.user.id;
    req.zhisuoUserRecord = auth.user;
    return next();
  } catch (error) {
    return res.status(500).json({ code: 500, message: String(error?.message || error) });
  }
}

async function requireAdmin(req, res, next) {
  const auth = await getAuthSession(sessionToken(req));
  if (!auth) return res.status(401).json({ code: 401, message: '请先登录' });
  if (auth.user.role !== 'admin') return res.status(403).json({ code: 403, message: '需要管理员权限' });
  req.zhisuoUser = auth.user.id;
  req.zhisuoUserRecord = auth.user;
  return next();
}

const rateBuckets = new Map();

function rateLimit({ windowMs, max, keyFn, message }) {
  return (req, res, next) => {
    const now = Date.now();
    const key = keyFn(req);
    const bucket = rateBuckets.get(key);
    const entry = bucket && bucket.resetAt > now ? bucket : { count: 0, resetAt: now + windowMs };
    entry.count += 1;
    rateBuckets.set(key, entry);
    if (entry.count > max) {
      const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
      res.setHeader('Retry-After', String(retryAfter));
      return res.status(429).json({ code: 429, message: message || '请求过于频繁，请稍后重试' });
    }
    if (rateBuckets.size > 10000) {
      for (const [bucketKey, value] of rateBuckets) {
        if (value.resetAt <= now) rateBuckets.delete(bucketKey);
      }
    }
    return next();
  };
}

const loginRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  keyFn: (req) => `login:${req.ip}`,
  message: '登录尝试过多，请 15 分钟后再试',
});

const chatRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  keyFn: (req) => `chat:${req.zhisuoUser}`,
  message: '聊天请求过于频繁，请稍后重试',
});

const uploadRateLimit = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 30,
  keyFn: (req) => `upload:${req.zhisuoUser}`,
  message: '上传请求过于频繁，请稍后重试',
});

function datasetPayload(stats = {}) {
  return {
    id: VIRTUAL_DATASET_ID,
    name: 'pdf-search 知识库',
    description: '由 pdf-search FastAPI 提供检索能力',
    document_count: stats.document_count || 0,
    chunk_count: stats.chunk_count || 0,
    done_count: stats.done_count || 0,
    embedding_model: 'BGE-M3',
  };
}

function toFrontendChunk(result, datasetId = VIRTUAL_DATASET_ID) {
  const score = Number(result.score || 0);
  return {
    id: result.block_id || `${result.doc_id || 'doc'}:${result.page || 0}`,
    content: result.text || '',
    highlight: result.text || '',
    document_id: result.doc_id || '',
    document_keyword: result.file_name || result.doc_id || '',
    dataset_id: datasetId,
    similarity: score,
    term_similarity: score,
    vector_similarity: score,
    page: Number(result.page || 0),
    positions: result.page ? [result.page] : [],
    bbox: result.bbox || null,
  };
}


function extractSearchTerm(question) {
  const value = String(question || '').trim();
  const stripped = value
    .replace(/^(请|麻烦|帮我|帮忙)?\s*(搜索|查找|检索|查询|查一下|找一下|搜一下)\s*[：:]?\s*/u, '')
    .replace(/[？?。！!]+$/u, '')
    .trim();
  return stripped || value;
}

function uniqueResults(exact = [], similar = []) {
  const out = [];
  const seen = new Set();
  for (const item of [...exact, ...similar]) {
    const chunk = toFrontendChunk(item);
    const key = `${chunk.document_id}:${chunk.id}:${chunk.content.slice(0, 100)}`;
    if (!chunk.content || seen.has(key)) continue;
    seen.add(key);
    out.push(chunk);
  }
  return out;
}

async function generateAnswer(question, exact, similar) {
  const chunks = uniqueResults(exact, similar);
  if (llm.enabled && chunks.length) {
    const evidence = chunks
      .slice(0, 6)
      .map((chunk, index) => `[${index + 1}] ${chunk.content}`)
      .join('\n\n');
    return llm.complete([
      {
        role: 'system',
        content: '你是知索，一个严谨的中文知识库助手。只能依据检索资料回答；资料不足时明确说明，不要编造。回答简洁，并保留来源信息。',
      },
      { role: 'user', content: `问题：${question}\n\n检索资料：\n${evidence}` },
    ]);
  }
  if (!chunks.length) return '当前 pdf-search 知识库中没有找到相关内容。';
  const primary = chunks[0].content.slice(0, 1200);
  const extra = chunks
    .slice(1, 3)
    .map((chunk) => `- ${chunk.content.slice(0, 260)}`)
    .join('\n');
  return `我在 pdf-search 中找到了以下相关内容：\n\n${primary}${extra ? `\n\n补充信息：\n${extra}` : ''}`;
}

app.post('/api/auth/login', loginRateLimit, express.json({ limit: '16kb' }), async (req, res) => {
  try {
    const { username, password } = req.body || {};
    const user = await findUserByUsername(username);
    if (!user || user.status !== 'active' || !verifyPassword(password || '', user.passwordHash)) {
      return res.status(401).json({ code: 401, message: '账号或密码不正确' });
    }
    const { token } = await createAuthSession(user.id);
    await touchLastLogin(user.id);
    const csrfToken = setCsrfCookie(res);
    res.append('Set-Cookie', `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800`);
    return res.json({ code: 0, data: { username: user.username, role: user.role } });
  } catch (error) {
    return res.status(500).json({ code: 500, message: String(error?.message || error) });
  }
});

app.get('/api/auth/session', async (req, res) => {
  try {
    const auth = await getAuthSession(sessionToken(req));
    if (!auth) return res.status(401).json({ code: 401, authenticated: false });
    if (!parseCookies(req.headers.cookie)[CSRF_COOKIE]) setCsrfCookie(res);
    return res.json({ code: 0, authenticated: true, data: { username: auth.user.username, role: auth.user.role } });
  } catch (error) {
    return res.status(500).json({ code: 500, message: String(error?.message || error) });
  }
});

app.post('/api/auth/logout', async (req, res) => {
  await deleteAuthSession(sessionToken(req)).catch(() => null);
  res.append('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
  res.append('Set-Cookie', `${CSRF_COOKIE}=; SameSite=Lax; Path=/; Max-Age=0`);
  return res.json({ code: 0 });
});

app.get('/api/users', requireAdmin, async (_req, res) => {
  try {
    const users = await listUsers();
    return res.json({
      code: 0,
      data: users.map((user) => ({
        id: user.id,
        username: user.username,
        role: user.role,
        status: user.status,
        createdAt: user.createdAt,
        lastLoginAt: user.lastLoginAt,
      })),
    });
  } catch (error) {
    return res.status(500).json({ code: 500, message: String(error?.message || error) });
  }
});

app.post('/api/users', requireAdmin, express.json({ limit: '16kb' }), async (req, res) => {
  try {
    const { username, password, role } = req.body || {};
    if (!String(username || '').trim() || !String(password || '')) {
      return res.status(400).json({ code: 400, message: 'username and password are required' });
    }
    const passwordError = validatePassword(password);
    if (passwordError) return res.status(400).json({ code: 400, message: passwordError });
    const user = await createUser(username, password, role);
    return res.json({
      code: 0,
      data: { id: user.id, username: user.username, role: user.role, status: user.status },
    });
  } catch (error) {
    const message = String(error?.message || error);
    return res.status(message.includes('duplicate') ? 409 : 500).json({ code: 409, message });
  }
});

app.patch('/api/users/:userId', requireAdmin, express.json({ limit: '16kb' }), async (req, res) => {
  try {
    const targetId = req.params.userId;
    const patch = req.body || {};
    if (patch.password) {
      const passwordError = validatePassword(patch.password);
      if (passwordError) return res.status(400).json({ code: 400, message: passwordError });
    }
    if (targetId === req.zhisuoUser && (patch.role === 'member' || patch.status === 'disabled')) {
      return res.status(400).json({ code: 400, message: '不能禁用或降级当前登录用户' });
    }
    const user = await updateUser(targetId, patch);
    if (!user) return res.status(404).json({ code: 404, message: '用户不存在' });
    return res.json({
      code: 0,
      data: { id: user.id, username: user.username, role: user.role, status: user.status },
    });
  } catch (error) {
    return res.status(500).json({ code: 500, message: String(error?.message || error) });
  }
});

app.delete('/api/users/:userId', requireAdmin, async (req, res) => {
  try {
    if (req.params.userId === req.zhisuoUser) {
      return res.status(400).json({ code: 400, message: '不能删除当前登录用户' });
    }
    const deleted = await deleteUser(req.params.userId);
    if (!deleted) return res.status(404).json({ code: 404, message: '用户不存在' });
    return res.json({ code: 0 });
  } catch (error) {
    return res.status(500).json({ code: 500, message: String(error?.message || error) });
  }
});

app.get('/api/health', async (_req, res) => {
  const started = Date.now();
  try {
    await Promise.all([pdfsearch.health(), checkDb()]);
    return res.json({
      ok: true,
      apiKeyConfigured: true,
      checks: [
        {
          id: 'pdf-search',
          label: 'pdf-search FastAPI',
          reachable: true,
          httpStatus: 200,
          latencyMs: Date.now() - started,
          url: PDFSEARCH_BASE_URL,
          detail: '服务可达',
        },
      ],
    });
  } catch (error) {
    return res.json({
      ok: false,
      apiKeyConfigured: true,
      checks: [
        {
          id: 'pdf-search',
          label: 'pdf-search FastAPI',
          reachable: false,
          httpStatus: null,
          latencyMs: Date.now() - started,
          url: PDFSEARCH_BASE_URL,
          detail: String(error?.message || error),
        },
      ],
    });
  }
});

app.get('/api/config', (_req, res) => {
  res.json({ apiKeyConfigured: true, mode: 'pdfsearch' });
});

app.get('/api/setup', (_req, res) => {
  res.json({
    links: { pdfsearchApi: PDFSEARCH_BASE_URL },
    model: { embedding: 'BGE-M3', parser: 'pdf-search backend' },
  });
});

app.get('/api/ragflow/datasets', requireSession, async (req, res) => {
  const stats = await documentStats(req.zhisuoUser);
  res.json({ code: 0, data: [datasetPayload(stats)] });
});

app.post('/api/ragflow/datasets', requireSession, async (req, res) => {
  const stats = await documentStats(req.zhisuoUser);
  res.json({ code: 0, data: datasetPayload(stats) });
});

app.get('/api/ragflow/datasets/:datasetId/documents', requireSession, async (req, res) => {
  if (req.params.datasetId !== VIRTUAL_DATASET_ID) {
    return res.status(404).json({ code: 404, message: 'dataset not found' });
  }
  const documents = await listDocuments(req.zhisuoUser);
  return res.json({ code: 0, data: { docs: documents.map(toFrontendDocument), total: documents.length } });
});

app.post(
  '/api/ragflow/datasets/:datasetId/documents',
  requireSession,
  uploadRateLimit,
  upload.array('file'),
  async (req, res) => {
    if (req.params.datasetId !== VIRTUAL_DATASET_ID) {
      return res.status(404).json({ code: 404, message: 'dataset not found' });
    }
    const files = Array.isArray(req.files) ? req.files : [];
    if (!files.length) return res.status(400).json({ code: 400, message: 'file is required' });
    const output = [];
    for (const file of files) {
      const buffer = await readFile(file.path);
      const fileHash = createHash('sha256').update(buffer).digest('hex');
      const existing = (await listDocuments(req.zhisuoUser)).find((doc) => doc.fileHash === fileHash);
      if (existing) {
        output.push(toFrontendDocument(existing));
        continue;
      }
      const document = await createDocument(req.zhisuoUser, {
        fileName: file.originalname,
        fileSize: file.size,
        fileHash,
        storagePath: file.path,
        status: 'queued',
      });
      output.push(toFrontendDocument(document));
    }
    return res.json({ code: 0, data: output });
  },
);

app.get('/api/documents/:documentId/download', requireSession, async (req, res) => {
  const document = await getDocument(req.zhisuoUser, req.params.documentId);
  if (!document) return res.status(404).json({ code: 404, message: 'document not found' });
  return res.download(document.storagePath, document.fileName);
});

app.post('/api/documents/:documentId/reindex', requireSession, async (req, res) => {
  const document = await getDocument(req.zhisuoUser, req.params.documentId);
  if (!document) return res.status(404).json({ code: 404, message: 'document not found' });
  const queued = await updateDocument(req.zhisuoUser, document.id, {
    status: 'queued',
    errorMessage: null,
  });
  return res.json({ code: 0, data: toFrontendDocument(queued) });
});

app.delete('/api/documents/:documentId', requireSession, async (req, res) => {
  const document = await getDocument(req.zhisuoUser, req.params.documentId);
  if (!document) return res.status(404).json({ code: 404, message: 'document not found' });
  if (document.backendDocId) {
    await pdfsearch.deleteDocument(document.backendDocId).catch(() => null);
  }
  await unlink(document.storagePath).catch(() => null);
  await deleteDocument(req.zhisuoUser, document.id);
  return res.json({ code: 0 });
});

app.post('/api/ragflow/datasets/:datasetId/chunks', requireSession, async (req, res) => {
  const ids = Array.isArray(req.body?.document_ids) ? req.body.document_ids : [];
  await requeueDocuments(req.zhisuoUser, ids);
  const documents = await listDocuments(req.zhisuoUser);
  return res.json({ code: 0, data: documents.map(toFrontendDocument) });
});

app.get('/api/pdfsearch/documents/:docId/pages/:page/image', requireSession, async (req, res) => {
  try {
    const payload = await pdfsearch.pageImage(req.params.docId, req.params.page);
    return res.json({ code: 0, data: payload });
  } catch (error) {
    return res.status(error?.status || 502).json({ code: error?.status || 502, message: String(error?.message || error) });
  }
});

app.get('/api/pdfsearch/documents/:docId/blocks/:blockId', requireSession, async (req, res) => {
  try {
    const payload = await pdfsearch.block(req.params.docId, req.params.blockId);
    return res.json({ code: 0, data: payload });
  } catch (error) {
    return res.status(error?.status || 502).json({ code: error?.status || 502, message: String(error?.message || error) });
  }
});

app.get('/api/conversations', requireSession, async (req, res) => {
  try {
    const conversations = await listConversationsWithMessages(req.zhisuoUser);
    return res.json({ code: 0, data: conversations });
  } catch (error) {
    return res.status(500).json({ code: 500, message: String(error?.message || error) });
  }
});

app.post('/api/conversations', requireSession, async (req, res) => {
  try {
    const conversation = await createConversation(
      req.zhisuoUser,
      req.body?.title || '新会话',
    );
    return res.json({ code: 0, data: { ...conversation, messages: [] } });
  } catch (error) {
    return res.status(500).json({ code: 500, message: String(error?.message || error) });
  }
});

app.get('/api/conversations/:conversationId', requireSession, async (req, res) => {
  try {
    const conversation = await getConversation(req.zhisuoUser, req.params.conversationId);
    if (!conversation) return res.status(404).json({ code: 404, message: 'conversation not found' });
    const messages = await loadConversationMessages(req.zhisuoUser, conversation.id);
    return res.json({ code: 0, data: { ...conversation, messages } });
  } catch (error) {
    return res.status(500).json({ code: 500, message: String(error?.message || error) });
  }
});

app.patch('/api/conversations/:conversationId', requireSession, async (req, res) => {
  try {
    const conversation = await updateConversation(
      req.zhisuoUser,
      req.params.conversationId,
      req.body || {},
    );
    if (!conversation) return res.status(404).json({ code: 404, message: 'conversation not found' });
    return res.json({ code: 0, data: conversation });
  } catch (error) {
    return res.status(500).json({ code: 500, message: String(error?.message || error) });
  }
});

app.delete('/api/conversations/:conversationId', requireSession, async (req, res) => {
  try {
    const deleted = await deleteConversation(req.zhisuoUser, req.params.conversationId);
    if (!deleted) return res.status(404).json({ code: 404, message: 'conversation not found' });
    return res.json({ code: 0 });
  } catch (error) {
    return res.status(500).json({ code: 500, message: String(error?.message || error) });
  }
});

app.post('/api/chat', requireSession, chatRateLimit, async (req, res) => {
  const { question, conversationId } = req.body || {};
  const cleanQuestion = String(question || '').trim();
  if (!cleanQuestion) return res.status(400).json({ code: 400, message: 'question is required' });

  let conversation = null;
  try {
    conversation = conversationId
      ? await getConversation(req.zhisuoUser, conversationId)
      : null;
    if (!conversation) {
      conversation = await createConversation(
        req.zhisuoUser,
        cleanQuestion.slice(0, 40),
        conversationId || randomUUID(),
      );
    }

    const userMessage = await addMessage(req.zhisuoUser, conversation.id, {
      role: 'user',
      content: cleanQuestion,
      status: 'complete',
    });

    const exactTerm = extractSearchTerm(cleanQuestion);
    const startedAt = Date.now();
    const [exactResult, hybridResult] = await Promise.allSettled([
      pdfsearch.exact(exactTerm, 8),
      pdfsearch.hybrid(cleanQuestion, 8),
    ]);
    const exactRaw = exactResult.status === 'fulfilled' ? exactResult.value?.results || [] : [];
    const similarRaw = hybridResult.status === 'fulfilled' ? hybridResult.value?.results || [] : [];
    const exact = exactRaw.map((item) => toFrontendChunk(item));
    const similar = similarRaw.map((item) => toFrontendChunk(item));

    let answer;
    let assistantStatus = 'complete';
    let errorMessage = null;
    if (!exact.length && !similar.length) {
      const reason = exactResult.status === 'rejected'
        ? exactResult.reason?.message
        : hybridResult.status === 'rejected'
          ? hybridResult.reason?.message
          : '没有检索到相关内容';
      answer = `没有在 pdf-search 中找到相关内容。${reason ? `（${reason}）` : ''}`;
    } else {
      try {
        answer = await generateAnswer(cleanQuestion, exactRaw, similarRaw);
      } catch (error) {
        assistantStatus = 'error';
        errorMessage = String(error?.message || error);
        answer = '检索已命中，但回答模型暂时不可用。请查看下方引用依据。';
      }
    }

    const latencyMs = Date.now() - startedAt;
    const assistantMessage = await addMessage(req.zhisuoUser, conversation.id, {
      role: 'assistant',
      content: answer,
      status: assistantStatus,
      model: llm.enabled ? process.env.LLM_MODEL || null : null,
      latencyMs,
      errorMessage,
    });
    await addCitations(assistantMessage.id, 'exact', exact);
    await addCitations(assistantMessage.id, 'similar', similar);

    return res.json({
      code: 0,
      data: {
        conversationId: conversation.id,
        userMessage,
        assistantMessage: { ...assistantMessage, exact, similar },
        answer,
        exact,
        similar,
      },
    });
  } catch (error) {
    return res.status(500).json({ code: 500, message: String(error?.message || error) });
  }
});

function sendSse(res, event, payload) {
  res.write(`event: ${event}
`);
  res.write(`data: ${JSON.stringify(payload)}

`);
}

app.post('/api/chat/stream', requireSession, chatRateLimit, async (req, res) => {
  const { question, conversationId, regenerate = false, assistantMessageId } = req.body || {};
  const cleanQuestion = String(question || '').trim();
  if (!cleanQuestion) return res.status(400).json({ code: 400, message: 'question is required' });

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const abortController = new AbortController();
  let closed = false;
  res.on('close', () => {
    closed = true;
    if (!abortController.signal.aborted) abortController.abort();
  });

  const send = (event, payload) => {
    if (closed || res.writableEnded) return;
    sendSse(res, event, payload);
  };

  let conversation = null;
  let userMessage = null;
  let assistantMessage = null;
  let answer = '';
  let streamedAnswer = '';
  let exact = [];
  let similar = [];

  try {
    conversation = conversationId
      ? await getConversation(req.zhisuoUser, conversationId)
      : null;
    if (!conversation) {
      conversation = await createConversation(
        req.zhisuoUser,
        cleanQuestion.slice(0, 40),
        conversationId || randomUUID(),
      );
    }

    if (regenerate) {
      if (!assistantMessageId) {
        throw new Error('assistantMessageId is required for regenerate');
      }
      const oldMessage = await getMessage(req.zhisuoUser, conversation.id, assistantMessageId);
      if (!oldMessage) throw new Error('要重新生成的消息不存在');
      await deleteMessage(req.zhisuoUser, conversation.id, assistantMessageId);
    } else {
      userMessage = await addMessage(req.zhisuoUser, conversation.id, {
        role: 'user',
        content: cleanQuestion,
        status: 'complete',
      });
    }
    send('meta', {
      conversationId: conversation.id,
      userMessageId: userMessage?.id || null,
      regenerate: Boolean(regenerate),
    });

    const exactTerm = extractSearchTerm(cleanQuestion);
    const [exactResult, hybridResult] = await Promise.allSettled([
      pdfsearch.exact(exactTerm, 8),
      pdfsearch.hybrid(cleanQuestion, 8),
    ]);
    const exactRaw = exactResult.status === 'fulfilled' ? exactResult.value?.results || [] : [];
    const similarRaw = hybridResult.status === 'fulfilled' ? hybridResult.value?.results || [] : [];
    exact = exactRaw.map((item) => toFrontendChunk(item));
    similar = similarRaw.map((item) => toFrontendChunk(item));
    send('citations', { exact, similar });

    const chunks = uniqueResults(exactRaw, similarRaw);
    if (llm.enabled && chunks.length) {
      const evidence = chunks
        .slice(0, 6)
        .map((chunk, index) => `[${index + 1}] ${chunk.content}`)
        .join('\n\n');
      answer = await llm.stream([
        {
          role: 'system',
          content: '你是知索，一个严谨的中文知识库助手。只能依据检索资料回答；资料不足时明确说明，不要编造。回答简洁，并保留来源信息。',
        },
        { role: 'user', content: `问题：${cleanQuestion}

检索资料：
${evidence}` },
      ], (token) => {
        streamedAnswer += token;
        send('token', { token });
      }, { signal: abortController.signal });
    } else {
      answer = chunks.length
        ? `我在 pdf-search 中找到了以下相关内容：

${chunks[0].content.slice(0, 1200)}`
        : '没有在 pdf-search 中找到相关内容。';
      streamedAnswer = answer;
      send('token', { token: answer });
    }

    assistantMessage = await addMessage(req.zhisuoUser, conversation.id, {
      role: 'assistant',
      content: answer,
      status: 'complete',
      model: llm.enabled ? process.env.LLM_MODEL || null : null,
    });
    await addCitations(assistantMessage.id, 'exact', exact);
    await addCitations(assistantMessage.id, 'similar', similar);
    send('done', {
      conversationId: conversation.id,
      userMessageId: userMessage?.id || null,
      assistantMessageId: assistantMessage.id,
      answer,
    });
    if (!closed) res.end();
  } catch (error) {
    const message = String(error?.message || error);
    const aborted = abortController.signal.aborted || error?.name === 'AbortError';
    if (conversation) {
      try {
        assistantMessage = await addMessage(req.zhisuoUser, conversation.id, {
          role: 'assistant',
          content: streamedAnswer || (aborted ? '已停止生成。' : '回答生成失败，请稍后重试。'),
          status: aborted ? 'stopped' : 'error',
          errorMessage: aborted ? null : message,
        });
        await addCitations(assistantMessage.id, 'exact', exact);
        await addCitations(assistantMessage.id, 'similar', similar);
      } catch {
        // Ignore persistence errors while reporting the original failure.
      }
    }
    if (!aborted) {
      send('error', {
        message,
        conversationId: conversation?.id,
        userMessageId: userMessage?.id || null,
        assistantMessageId: assistantMessage?.id || null,
      });
    }
    if (!closed) res.end();
  }
});

function wordReviewContent(task) {
  const count = Number(task?.issueCount || 0);
  if (!count) {
    return `## Word 审核完成

已审核《${task.fileName}》，未发现明显的数据、单位、格式或语义问题。`;
  }
  return `## Word 审核完成

已审核《${task.fileName}》，发现 **${count}** 个疑似问题。请在下方逐条查看原文、证据和修改建议。`;
}

app.post('/api/chat/word-review', requireSession, uploadRateLimit, upload.single('file'), async (req, res) => {
  const file = req.file;
  if (!file) return res.status(400).json({ code: 400, message: '请上传 Word 文件' });
  if (!/\.docx$/i.test(file.originalname)) {
    await unlink(file.path).catch(() => null);
    return res.status(400).json({ code: 400, message: '当前仅支持 .docx 文件' });
  }

  let conversation = null;
  let task = null;
  try {
    conversation = req.body?.conversationId
      ? await getConversation(req.zhisuoUser, req.body.conversationId)
      : null;
    if (!conversation) {
      conversation = await createConversation(
        req.zhisuoUser,
        `审核 ${file.originalname}`.slice(0, 80),
        req.body?.conversationId || undefined,
      );
    }

    const userMessage = await addMessage(req.zhisuoUser, conversation.id, {
      role: 'user',
      content: `请审核 Word 文件《${file.originalname}》。`,
      status: 'complete',
    });

    task = await createReviewTask(req.zhisuoUser, file.originalname);
    const result = await reviewWordFile({ filePath: file.path, pdfsearch, llm });
    await addReviewIssues(task.id, result.issues);
    task = await updateReviewTask(req.zhisuoUser, task.id, {
      status: 'done',
      issueCount: result.issues.length,
    });
    const complete = await getReviewTask(req.zhisuoUser, task.id);
    const assistantMessage = await addMessage(req.zhisuoUser, conversation.id, {
      role: 'assistant',
      content: wordReviewContent(complete),
      status: 'complete',
      model: 'word-review',
      metadata: { kind: 'word_review', reviewTask: complete },
    });

    return res.json({
      code: 0,
      data: {
        conversationId: conversation.id,
        userMessage,
        assistantMessage: { ...assistantMessage, reviewTask: complete },
        reviewTask: complete,
      },
    });
  } catch (error) {
    const message = String(error?.message || error);
    if (task) {
      await updateReviewTask(req.zhisuoUser, task.id, {
        status: 'failed',
        errorMessage: message,
      }).catch(() => null);
    }
    if (conversation) {
      await addMessage(req.zhisuoUser, conversation.id, {
        role: 'assistant',
        content: `Word 审核失败：${message}`,
        status: 'error',
        model: 'word-review',
        errorMessage: message,
        metadata: { kind: 'word_review_error' },
      }).catch(() => null);
    }
    return res.status(500).json({ code: 500, message });
  } finally {
    await unlink(file.path).catch(() => null);
  }
});

app.post('/api/review/word', requireSession, uploadRateLimit, upload.single('file'), async (req, res) => {
  const file = req.file;
  if (!file) return res.status(400).json({ code: 400, message: '请上传 Word 文件' });
  if (!/\.docx$/i.test(file.originalname)) {
    await unlink(file.path).catch(() => null);
    return res.status(400).json({ code: 400, message: '当前仅支持 .docx 文件' });
  }
  let task = await createReviewTask(req.zhisuoUser, file.originalname);
  try {
    const result = await reviewWordFile({ filePath: file.path, pdfsearch, llm });
    await addReviewIssues(task.id, result.issues);
    task = await updateReviewTask(req.zhisuoUser, task.id, {
      status: 'done',
      issueCount: result.issues.length,
    });
    const complete = await getReviewTask(req.zhisuoUser, task.id);
    return res.json({ code: 0, data: complete });
  } catch (error) {
    await updateReviewTask(req.zhisuoUser, task.id, {
      status: 'failed',
      errorMessage: String(error?.message || error),
    });
    return res.status(500).json({ code: 500, message: String(error?.message || error) });
  } finally {
    await unlink(file.path).catch(() => null);
  }
});

app.get('/api/review/tasks', requireSession, async (req, res) => {
  const tasks = await listReviewTasks(req.zhisuoUser);
  return res.json({ code: 0, data: tasks });
});

app.get('/api/review/tasks/:taskId', requireSession, async (req, res) => {
  const task = await getReviewTask(req.zhisuoUser, req.params.taskId);
  if (!task) return res.status(404).json({ code: 404, message: '审核任务不存在' });
  return res.json({ code: 0, data: task });
});

const webDist = path.resolve(__dirname, '../../web/dist');
if (existsSync(webDist)) {
  app.use(express.static(webDist, {
    setHeaders(res, filePath) {
      if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-store');
    },
  }));
  app.get('*', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(path.join(webDist, 'index.html'));
  });
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[zhisuo] gateway listening on http://127.0.0.1:${PORT}`);
  console.log(`[zhisuo] pdf-search: ${PDFSEARCH_BASE_URL}`);
});
