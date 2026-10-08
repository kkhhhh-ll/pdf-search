import { randomUUID } from 'node:crypto';
import { pool } from './db.js';

function conversationFromRow(row) {
  return {
    id: row.id,
    title: row.title,
    pinned: row.pinned,
    archived: row.archived,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastMessageAt: row.last_message_at,
  };
}

function messageFromRow(row) {
  return {
    id: row.id,
    role: row.role,
    content: row.content,
    status: row.status,
    model: row.model,
    promptTokens: row.prompt_tokens,
    completionTokens: row.completion_tokens,
    latencyMs: row.latency_ms,
    errorMessage: row.error_message,
    metadata: row.metadata || {},
    createdAt: row.created_at,
    exact: [],
    similar: [],
  };
}

export async function listConversations(userId, limit = 50) {
  const { rows } = await pool.query(
    `SELECT id, title, pinned, archived, created_at, updated_at, last_message_at
       FROM conversations
      WHERE user_id = $1 AND archived = FALSE
      ORDER BY pinned DESC, updated_at DESC
      LIMIT $2`,
    [userId, Math.min(Math.max(Number(limit) || 50, 1), 100)],
  );
  return rows.map(conversationFromRow);
}

export async function getConversation(userId, conversationId) {
  const { rows } = await pool.query(
    `SELECT id, title, pinned, archived, created_at, updated_at, last_message_at
       FROM conversations
      WHERE id = $1 AND user_id = $2`,
    [conversationId, userId],
  );
  return rows[0] ? conversationFromRow(rows[0]) : null;
}

export async function createConversation(userId, title, id = randomUUID()) {
  const { rows } = await pool.query(
    `INSERT INTO conversations (id, user_id, title)
     VALUES ($1, $2, $3)
     ON CONFLICT (id) DO UPDATE
       SET title = CASE WHEN conversations.title = '新会话' THEN EXCLUDED.title ELSE conversations.title END,
           updated_at = NOW()
     RETURNING id, title, pinned, archived, created_at, updated_at, last_message_at`,
    [id, userId, String(title || '新会话').slice(0, 80)],
  );
  return conversationFromRow(rows[0]);
}

export async function updateConversation(userId, conversationId, patch) {
  const title = patch.title === undefined ? null : String(patch.title).slice(0, 80);
  const pinned = patch.pinned === undefined ? null : Boolean(patch.pinned);
  const archived = patch.archived === undefined ? null : Boolean(patch.archived);
  const { rows } = await pool.query(
    `UPDATE conversations
        SET title = COALESCE($3, title),
            pinned = COALESCE($4, pinned),
            archived = COALESCE($5, archived),
            updated_at = NOW()
      WHERE id = $1 AND user_id = $2
      RETURNING id, title, pinned, archived, created_at, updated_at, last_message_at`,
    [conversationId, userId, title, pinned, archived],
  );
  return rows[0] ? conversationFromRow(rows[0]) : null;
}

export async function deleteConversation(userId, conversationId) {
  const { rowCount } = await pool.query(
    'DELETE FROM conversations WHERE id = $1 AND user_id = $2',
    [conversationId, userId],
  );
  return rowCount > 0;
}

export async function addMessage(userId, conversationId, message) {
  const { rows } = await pool.query(
    `INSERT INTO messages (
       id, conversation_id, user_id, role, content, status, model,
       prompt_tokens, completion_tokens, latency_ms, error_message, metadata
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)
     RETURNING *`,
    [
      message.id || randomUUID(),
      conversationId,
      userId,
      message.role,
      message.content || '',
      message.status || 'complete',
      message.model || null,
      message.promptTokens || 0,
      message.completionTokens || 0,
      message.latencyMs || 0,
      message.errorMessage || null,
      JSON.stringify(message.metadata || {}),
    ],
  );
  await pool.query(
    `UPDATE conversations SET updated_at = NOW(), last_message_at = NOW() WHERE id = $1`,
    [conversationId],
  );
  return messageFromRow(rows[0]);
}

export async function addCitations(messageId, kind, citations = []) {
  if (!citations.length) return [];
  const values = [];
  const params = [];
  citations.forEach((citation, index) => {
    const base = index * 4;
    values.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}::jsonb)`);
    params.push(randomUUID(), messageId, kind, JSON.stringify(citation));
  });
  const { rows } = await pool.query(
    `INSERT INTO message_citations (id, message_id, kind, payload)
     VALUES ${values.join(',')}
     RETURNING payload`,
    params,
  );
  return rows.map((row) => row.payload);
}

export async function getMessage(userId, conversationId, messageId) {
  const { rows } = await pool.query(
    `SELECT * FROM messages WHERE id = $1 AND conversation_id = $2 AND user_id = $3 LIMIT 1`,
    [messageId, conversationId, userId],
  );
  return rows[0] ? messageFromRow(rows[0]) : null;
}

export async function deleteMessage(userId, conversationId, messageId) {
  const { rowCount } = await pool.query(
    `DELETE FROM messages WHERE id = $1 AND conversation_id = $2 AND user_id = $3`,
    [messageId, conversationId, userId],
  );
  return rowCount > 0;
}

export async function loadConversationMessages(userId, conversationId) {
  const { rows } = await pool.query(
    `SELECT *
       FROM messages
      WHERE conversation_id = $1 AND user_id = $2
      ORDER BY created_at ASC`,
    [conversationId, userId],
  );
  const messages = rows.map(messageFromRow);
  if (!messages.length) return messages;

  const ids = messages.map((message) => message.id);
  const citationResult = await pool.query(
    `SELECT message_id, kind, payload
       FROM message_citations
      WHERE message_id = ANY($1::text[])
      ORDER BY created_at ASC`,
    [ids],
  );
  const byMessage = new Map(messages.map((message) => [message.id, message]));
  for (const row of citationResult.rows) {
    const message = byMessage.get(row.message_id);
    if (!message) continue;
    if (row.kind === 'exact') message.exact.push(row.payload);
    if (row.kind === 'similar') message.similar.push(row.payload);
  }
  return messages;
}

export async function listConversationsWithMessages(userId, limit = 50) {
  const conversations = await listConversations(userId, limit);
  for (const conversation of conversations) {
    conversation.messages = await loadConversationMessages(userId, conversation.id);
  }
  return conversations;
}
