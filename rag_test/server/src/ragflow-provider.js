import { readFile } from 'node:fs/promises';
import { PDFDocument } from 'pdf-lib';

function joinUrl(baseUrl, path) {
  return `${String(baseUrl || '').replace(/\/+$/, '')}/${String(path || '').replace(/^\/+/, '')}`;
}

function exactTokens(query) {
  const splitIdentifier = String(query || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
  const normalized = splitIdentifier.toLowerCase().replace(/[，。！？、；：,.!?;:()[\]{}"'“”‘’]/g, ' ');
  const tokens = normalized.match(/[a-z0-9][a-z0-9._/-]{1,}/g) || [];
  const cjkRuns = normalized.match(/[\u3400-\u9fff]+/g) || [];
  for (const run of cjkRuns) {
    if (run.length === 1) tokens.push(run);
    for (let index = 0; index < run.length - 1; index += 1) tokens.push(run.slice(index, index + 2));
  }
  return [...new Set(tokens)].slice(0, 24);
}

function identifierPrefixes(query) {
  const compactTokens = String(query || '').toLowerCase().match(/[a-z0-9][a-z0-9]{4,}/g) || [];
  const prefixes = [];
  for (const token of compactTokens) {
    for (let size = 4; size <= Math.min(8, token.length - 1); size += 1) {
      prefixes.push(token.slice(0, size));
    }
  }
  return [...new Set(prefixes)].slice(0, 32);
}

const QUERY_STOPWORDS = [
  '帮我', '帮忙', '请', '麻烦', '搜索', '查找', '检索', '查询', '查一下', '找一下',
  '相关的信息', '相关信息', '相关', '信息', '有哪些', '哪些', '什么', '怎么', '如何',
  '不存在的', '不存在', '关键词', '一下', '当前', '主要', '内容', '的', '了', '是', '在', '有', '吗', '呢',
];

function normalizeMatchText(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '');
}

function significantTerms(query) {
  let value = String(query || '').normalize('NFKC').toLowerCase();
  for (const stopword of QUERY_STOPWORDS) value = value.split(stopword).join(' ');
  const terms = new Set();
  for (const token of value.match(/[a-z0-9]{2,}|[\u3400-\u9fff]{2,}/g) || []) {
    if (/^[a-z0-9]+$/i.test(token)) {
      terms.add(token);
      continue;
    }
    if (token.length <= 2) terms.add(token);
    else {
      for (let index = 0; index < token.length - 1; index += 1) {
        terms.add(token.slice(index, index + 2));
      }
    }
  }
  return [...terms];
}

function filterRelevantResults(query, results) {
  const text = String(query || '').trim();
  if (!text) return [];
  if (/总结|概括|概述|主要内容|介绍一下/u.test(text)) return results;
  const terms = significantTerms(text);
  if (!terms.length) return [];
  const required = Math.min(2, terms.length);
  return results.filter((result) => {
    const content = normalizeMatchText(result.text || result.highlight || '');
    const matched = terms.reduce((count, term) => count + (content.includes(term) ? 1 : 0), 0);
    return matched >= required;
  });
}

function firstPosition(positions = []) {
  const value = Array.isArray(positions[0]) ? positions[0] : positions;
  if (!Array.isArray(value) || !value.length) return null;
  const page = Number(value[0]) || 0;
  const values = value.slice(1).map(Number).filter((item) => Number.isFinite(item));
  if (values.length >= 4) {
    return { page, bbox: [values[0], values[2], values[1], values[3]] };
  }
  return { page, bbox: [] };
}

function parsePartName(value) {
  const match = String(value || '').match(/^(.*?)__zhisuo_part_(\d+)__p(\d+)-(\d+)\.pdf$/i);
  if (!match) return null;
  return {
    originalName: `${match[1]}.pdf`,
    part: Number(match[2]),
    pageStart: Number(match[3]),
    pageEnd: Number(match[4]),
  };
}

function partName(fileName, part, pageStart, pageEnd) {
  const base = String(fileName || 'document.pdf').replace(/\.pdf$/i, '');
  return `${base}__zhisuo_part_${String(part).padStart(3, '0')}__p${pageStart}-${pageEnd}.pdf`;
}

function mapPartPage(fileName, page) {
  const part = parsePartName(fileName);
  return {
    fileName: part?.originalName || fileName || '',
    page: part && page ? page + part.pageStart - 1 : page,
    part,
  };
}

function resultFromChunk(chunk = {}) {
  const position = firstPosition(chunk.positions || chunk.position_int || []);
  const text = chunk.content || chunk.content_with_weight || chunk.highlight || '';
  const mapped = mapPartPage(chunk.document_keyword || chunk.docnm_kwd || '', position?.page || 0);
  return {
    doc_id: chunk.document_id || chunk.doc_id || '',
    file_name: mapped.fileName,
    page: mapped.page,
    block_id: chunk.id || chunk.chunk_id || chunk._id || '',
    section: chunk.section || '',
    text,
    highlight: chunk.highlight || text,
    bbox: [],
    image_id: chunk.image_id || chunk.img_id || '',
    positions: chunk.positions || chunk.position_int || [],
    score: Number(chunk.similarity ?? chunk.term_similarity ?? chunk.score ?? 0),
    term_similarity: Number(chunk.term_similarity || 0),
    vector_similarity: Number(chunk.vector_similarity || 0),
  };
}

export function createRagFlowProvider({
  baseUrl,
  apiKey,
  datasetId = '',
  esUrl = '',
  esUser = '',
  esPassword = '',
  parseTimeoutMs = 600000,
}) {
  let resolvedDatasetId = datasetId;

  async function request(path, options = {}) {
    const response = await fetch(joinUrl(baseUrl, path), {
      ...options,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        ...(options.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
        ...(options.headers || {}),
      },
    });
    const text = await response.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = { message: text };
    }
    if (!response.ok || (payload && payload.code !== undefined && payload.code !== 0)) {
      const error = new Error(payload?.message || payload?.detail || `RAGFlow HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return payload;
  }

  async function resolveDatasetId() {
    if (resolvedDatasetId) return resolvedDatasetId;
    const payload = await request('/api/v1/datasets?page=1&page_size=1');
    const first = payload?.data?.[0];
    if (!first?.id) throw new Error('RAGFlow 没有可用知识库');
    resolvedDatasetId = first.id;
    return resolvedDatasetId;
  }

  async function datasetInfo() {
    const id = await resolveDatasetId();
    const payload = await request(`/api/v1/datasets?id=${encodeURIComponent(id)}&page=1&page_size=1`);
    const dataset = payload?.data?.[0];
    if (!dataset) throw new Error('RAGFlow 知识库不存在');
    return dataset;
  }

  async function listDocumentIds() {
    const id = await resolveDatasetId();
    const ids = new Set();
    let page = 1;
    while (page <= 20) {
      const payload = await request(`/api/v1/datasets/${encodeURIComponent(id)}/documents?page=${page}&page_size=100`);
      const docs = payload?.data?.docs || [];
      docs.forEach((doc) => doc.id && ids.add(doc.id));
      if (docs.length < 100) break;
      page += 1;
    }
    return ids;
  }

  async function filterDeleted(chunks = []) {
    try {
      const existing = await listDocumentIds();
      if (!existing.size) return [];
      return chunks.filter((chunk) => !chunk.doc_id || existing.has(chunk.doc_id));
    } catch {
      return chunks;
    }
  }

  async function exact(query, topK = 8) {
    const id = await resolveDatasetId();
    const dataset = await datasetInfo();
    const tenantId = dataset.tenant_id;
    if (!esUrl || !tenantId) throw new Error('RAGFlow 精确检索缺少 ES 配置');

    const tokens = exactTokens(query);
    const prefixes = identifierPrefixes(query);
    const compactQuery = String(query || '').replace(/\s+/g, '');
    const grams = new Set();
    for (const run of compactQuery.match(/[\u3400-\u9fff]+/g) || []) {
      for (let size = 2; size <= Math.min(4, run.length); size += 1) {
        for (let index = 0; index <= run.length - size; index += 1) grams.add(run.slice(index, index + size));
      }
    }

    const should = [
      { match_phrase: { content_ltks: { query: tokens.join(' '), slop: 3, boost: 4 } } },
      { match: { content_ltks: { query: tokens.join(' '), operator: 'and', boost: 3 } } },
      { match: { content_sm_ltks: { query: tokens.join(' '), operator: 'and', boost: 2 } } },
    ];
    const rawIdentifier = String(query || '').match(/[a-zA-Z0-9][a-zA-Z0-9._/-]{2,}/)?.[0];
    if (rawIdentifier) should.push({ wildcard: { content_ltks: { value: `*${rawIdentifier.toLowerCase()}*`, boost: 8 } } });
    if (compactQuery) should.push({ wildcard: { content_ltks: { value: `*${compactQuery.toLowerCase()}*`, boost: 6 } } });
    for (const gram of [...grams].slice(0, 40)) should.push({ wildcard: { content_ltks: { value: `*${gram}*`, boost: 1.5 } } });
    for (const prefix of prefixes) should.push({ wildcard: { content_ltks: { value: `*${prefix}*`, boost: 1.8 } } });

    const headers = { 'Content-Type': 'application/json' };
    if (esUser) headers.Authorization = `Basic ${Buffer.from(`${esUser}:${esPassword}`).toString('base64')}`;
    const response = await fetch(joinUrl(esUrl, `/ragflow_${tenantId}/_search`), {
      method: 'POST',
      headers,
      body: JSON.stringify({
        size: Math.min(Number(topK) || 8, 30),
        query: { bool: { filter: [{ term: { kb_id: id } }], should, minimum_should_match: 1 } },
        highlight: { pre_tags: ['<em>'], post_tags: ['</em>'], fields: { content_ltks: {} } },
      }),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) throw new Error(payload?.error?.reason || 'RAGFlow 精确检索失败');
    const hits = payload?.hits?.hits || [];
    const maxScore = Math.max(...hits.map((hit) => Number(hit._score) || 0), 1);
    const results = hits.map((hit) => {
      const source = hit._source || {};
      const sourceName = source.docnm_kwd || source.document_keyword || '';
      const sourcePosition = firstPosition(source.position_int || source.positions || [])?.page || 0;
      const mapped = mapPartPage(sourceName, sourcePosition);
      return {
        doc_id: source.doc_id || source.document_id || '',
        file_name: mapped.fileName,
        page: mapped.page,
        block_id: source.id || hit._id || '',
        section: source.section || '',
        text: source.content_with_weight || source.content || '',
        highlight: hit.highlight?.content_ltks?.join(' ... ') || source.content_with_weight || source.content || '',
        bbox: [],
        image_id: source.img_id || source.image_id || '',
        score: (Number(hit._score) || 0) / maxScore,
        term_similarity: (Number(hit._score) || 0) / maxScore,
        vector_similarity: 0,
      };
    });
    return { results: await filterDeleted(filterRelevantResults(query, results)) };
  }

  async function hybrid(query, topK = 8) {
    const id = await resolveDatasetId();
    const payload = await request('/api/v1/retrieval', {
      method: 'POST',
      body: JSON.stringify({
        question: query,
        dataset_ids: [id],
        page: 1,
        page_size: Math.min(Number(topK) || 8, 30),
        similarity_threshold: 0.2,
        vector_similarity_weight: 1,
        keyword: false,
        highlight: true,
      }),
    });
    const results = (payload?.data?.chunks || []).map(resultFromChunk);
    return { results: await filterDeleted(filterRelevantResults(query, results)) };
  }

  async function listDocumentChunks(documentId, pageSize = 100) {
    const id = await resolveDatasetId();
    const payload = await request(
      `/api/v1/datasets/${encodeURIComponent(id)}/documents/${encodeURIComponent(documentId)}/chunks?page=1&page_size=${Math.min(Number(pageSize) || 100, 100)}`,
    );
    return payload?.data?.chunks || [];
  }

  async function imageResponse(imageId, documentId, page) {
    if (!imageId) throw new Error('RAGFlow 未生成该分片的证据图片');
    const response = await fetch(joinUrl(baseUrl, `/api/v1/documents/images/${encodeURIComponent(imageId)}`), {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!response.ok) throw new Error(`RAGFlow 图片读取失败: HTTP ${response.status}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    const contentType = response.headers.get('content-type') || 'image/jpeg';
    return {
      doc_id: documentId,
      page: Number(page) || 0,
      image: `data:${contentType};base64,${buffer.toString('base64')}`,
      width: Number(response.headers.get('x-image-width') || 0),
      height: Number(response.headers.get('x-image-height') || 0),
      page_width: Number(response.headers.get('x-image-width') || 0),
      page_height: Number(response.headers.get('x-image-height') || 0),
    };
  }

  async function pageImage(documentId, page) {
    const chunks = await listDocumentChunks(documentId, 100);
    const requestedPage = Number(page) || 1;
    const chunk = chunks.find((item) => firstPosition(item.positions || item.position_int || [])?.page === requestedPage)
      || chunks.find((item) => firstPosition(item.positions || item.position_int || [])?.page >= requestedPage)
      || chunks[0];
    return imageResponse(chunk?.image_id || chunk?.img_id, documentId, requestedPage);
  }

  async function blockImage(documentId, blockId) {
    const id = await resolveDatasetId();
    const payload = await request(
      `/api/v1/datasets/${encodeURIComponent(id)}/documents/${encodeURIComponent(documentId)}/chunks/${encodeURIComponent(blockId)}`,
    );
    const chunk = payload?.data;
    if (!chunk || chunk === false) throw new Error('RAGFlow 分片不存在');
    const mapped = mapPartPage(chunk.docnm_kwd || chunk.document_keyword || '', firstPosition(chunk.positions || chunk.position_int || [])?.page || 0);
    return imageResponse(chunk.img_id || chunk.image_id, documentId, mapped.page);
  }

  async function block(documentId, blockId) {
    const id = await resolveDatasetId();
    const payload = await request(
      `/api/v1/datasets/${encodeURIComponent(id)}/documents/${encodeURIComponent(documentId)}/chunks/${encodeURIComponent(blockId)}`,
    );
    const chunk = payload?.data;
    if (!chunk || chunk === false) throw new Error('RAGFlow 分片不存在');
    const chunkName = chunk.docnm_kwd || chunk.document_keyword || '';
    const mapped = mapPartPage(chunkName, firstPosition(chunk.positions || chunk.position_int || [])?.page || 0);
    return {
      doc_id: documentId,
      file_name: mapped.fileName,
      block_id: chunk.id || blockId,
      section: chunk.section || '',
      page: mapped.page,
      bbox: [],
      text: chunk.content || chunk.content_with_weight || '',
    };
  }

  function documentIds(value) {
    try {
      const parsed = JSON.parse(String(value || ''));
      if (Array.isArray(parsed)) return parsed.filter(Boolean);
    } catch {
      // Backward-compatible single document id.
    }
    return value ? [value] : [];
  }

  async function deleteDocument(documentId) {
    const id = await resolveDatasetId();
    const ids = documentIds(documentId);
    if (ids.length) {
      await request(`/api/v1/datasets/${encodeURIComponent(id)}/documents`, {
        method: 'DELETE',
        body: JSON.stringify({ ids, delete_all: false }),
      });
    }
    return { doc_id: documentId, deleted: true, count: ids.length };
  }

  async function waitForDocument(documentId) {
    const id = await resolveDatasetId();
    const deadline = Date.now() + Math.max(Number(parseTimeoutMs) || 0, 1000);
    while (Date.now() < deadline) {
      const payload = await request(`/api/v1/datasets/${encodeURIComponent(id)}/documents?id=${encodeURIComponent(documentId)}&page=1&page_size=1`);
      const doc = payload?.data?.docs?.[0];
      if (!doc) throw new Error('RAGFlow 文档上传后不可见');
      const run = String(doc.run || '').toUpperCase();
      if (run === 'DONE') return doc;
      if (run === 'FAIL' || run === 'CANCEL') throw new Error(doc.progress_msg || `RAGFlow 文档解析${run}`);
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    throw new Error('RAGFlow 文档解析超时');
  }

  async function uploadPdf(buffer, fileName) {
    const id = await resolveDatasetId();
    const form = new FormData();
    form.append('file', new Blob([buffer], { type: 'application/pdf' }), fileName);
    const uploaded = await request(`/api/v1/datasets/${encodeURIComponent(id)}/documents`, {
      method: 'POST',
      body: form,
    });
    const doc = Array.isArray(uploaded?.data) ? uploaded.data[0] : uploaded?.data;
    if (!doc?.id) throw new Error(`RAGFlow 上传文档失败: ${fileName}`);
    await request(`/api/v1/datasets/${encodeURIComponent(id)}/documents/parse`, {
      method: 'POST',
      body: JSON.stringify({ document_ids: [doc.id] }),
    });
    const parsed = await waitForDocument(doc.id);
    return {
      doc_id: doc.id,
      file_name: parsed.name || fileName,
      chunk_count: Number(parsed.chunk_count || 0),
      run: parsed.run,
    };
  }

  async function indexDocument(filePath, fileName) {
    const buffer = await readFile(filePath);
    const partPages = Math.max(1, Number(process.env.RAGFLOW_PDF_PART_PAGES || 30));
    const source = await PDFDocument.load(buffer, { ignoreEncryption: true });
    const totalPages = source.getPageCount();
    const prepared = [];

    for (let start = 0; start < totalPages; start += partPages) {
      const end = Math.min(totalPages, start + partPages);
      const part = await PDFDocument.create();
      const pages = await part.copyPages(source, Array.from({ length: end - start }, (_, i) => start + i));
      pages.forEach((page) => part.addPage(page));
      const bytes = Buffer.from(await part.save());
      prepared.push({
        buffer: bytes,
        name: partName(fileName, prepared.length + 1, start + 1, end),
      });
    }

    const indexed = [];
    try {
      for (const item of prepared) {
        const result = await uploadPdf(item.buffer, item.name);
        indexed.push(result);
      }
      return {
        doc_id: JSON.stringify(indexed.map((item) => item.doc_id)),
        file_name: fileName,
        chunk_count: indexed.reduce((sum, item) => sum + item.chunk_count, 0),
        run: 'DONE',
        parts: indexed,
      };
    } catch (error) {
      if (indexed.length) {
        await deleteDocument(JSON.stringify(indexed.map((item) => item.doc_id))).catch(() => null);
      }
      throw error;
    }
  }

  async function health() {
    const response = await fetch(joinUrl(baseUrl, '/api/v1/system/healthz'));
    if (!response.ok) throw new Error(`RAGFlow HTTP ${response.status}`);
    return response.json();
  }

  return { exact, hybrid, health, pageImage, block, blockImage, deleteDocument, indexDocument };
}
