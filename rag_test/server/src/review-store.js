import { randomUUID } from 'node:crypto';
import { pool } from './db.js';

function taskFromRow(row) {
  return {
    id: row.id,
    fileName: row.file_name,
    status: row.status,
    issueCount: row.issue_count,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    issues: [],
  };
}

function issueFromRow(row) {
  return {
    id: row.id,
    paragraphIndex: row.paragraph_index,
    issueType: row.issue_type,
    severity: row.severity,
    docId: row.doc_id,
    fileName: row.file_name,
    page: row.page,
    partPage: row.part_page,
    blockId: row.block_id,
    bbox: row.bbox || [],
    sourceText: row.source_text,
    evidenceText: row.evidence_text,
    suggestion: row.suggestion,
    reason: row.reason,
    confidence: Number(row.confidence || 0),
    status: row.status,
    createdAt: row.created_at,
  };
}

export async function createReviewTask(userId, fileName) {
  const { rows } = await pool.query(
    `INSERT INTO review_tasks (id, user_id, file_name, status)
     VALUES ($1,$2,$3,'processing') RETURNING *`,
    [randomUUID(), userId, fileName],
  );
  return taskFromRow(rows[0]);
}

export async function updateReviewTask(userId, taskId, patch) {
  const { rows } = await pool.query(
    `UPDATE review_tasks
        SET status = COALESCE($3,status),
            issue_count = COALESCE($4,issue_count),
            error_message = $5,
            updated_at = NOW()
      WHERE id=$1 AND user_id=$2 RETURNING *`,
    [taskId, userId, patch.status || null, patch.issueCount ?? null, patch.errorMessage || null],
  );
  return rows[0] ? taskFromRow(rows[0]) : null;
}

export async function addReviewIssues(taskId, issues = []) {
  if (!issues.length) return [];
  const values = [];
  const params = [];
  const keys = [
    'id', 'task_id', 'paragraph_index', 'issue_type', 'severity', 'doc_id',
    'file_name', 'page', 'part_page', 'block_id', 'bbox', 'source_text', 'evidence_text',
    'suggestion', 'reason', 'confidence', 'status',
  ];
  issues.forEach((issue, index) => {
    const base = index * keys.length;
    values.push(`(${keys.map((_, offset) => `$${base + offset + 1}`).join(',')})`);
    params.push(
      randomUUID(),
      taskId,
      issue.paragraphIndex || 0,
      issue.issueType || 'semantic',
      issue.severity || 'medium',
      issue.docId || null,
      issue.fileName || null,
      issue.page || null,
      issue.partPage || null,
      issue.blockId || null,
      JSON.stringify(issue.bbox || []),
      issue.sourceText || '',
      issue.evidenceText || '',
      issue.suggestion || '',
      issue.reason || '',
      Number(issue.confidence || 0),
      issue.status || 'pending',
    );
  });
  const { rows } = await pool.query(
    `INSERT INTO review_issues (${keys.join(',')}) VALUES ${values.join(',')} RETURNING *`,
    params,
  );
  return rows.map(issueFromRow);
}

export async function listReviewTasks(userId, limit = 20) {
  const { rows } = await pool.query(
    `SELECT * FROM review_tasks WHERE user_id=$1 ORDER BY created_at DESC LIMIT $2`,
    [userId, Math.min(Math.max(Number(limit) || 20, 1), 100)],
  );
  return rows.map(taskFromRow);
}

export async function getReviewTask(userId, taskId) {
  const { rows } = await pool.query(
    `SELECT * FROM review_tasks WHERE id=$1 AND user_id=$2`,
    [taskId, userId],
  );
  if (!rows[0]) return null;
  const task = taskFromRow(rows[0]);
  const issues = await pool.query(
    `SELECT * FROM review_issues WHERE task_id=$1 ORDER BY confidence DESC, created_at ASC`,
    [taskId],
  );
  task.issues = issues.rows.map(issueFromRow);
  return task;
}
