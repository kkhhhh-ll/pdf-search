import { readFile } from 'node:fs/promises';

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

function resultFromChunk(chunk = {}) {
  const position = firstPosition(chunk.positions || chunk.position_int || []);
  const text = chunk.content || chunk.content_with_weight || chunk.highlight || '';
  return {
    doc_id: chunk.document_id || chunk.doc_id || '',
    file_name: chunk.document_keyword || chunk.docnm_kwd || '',
    page: position?.page || 0,
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
      return {
        doc_id: source.doc_id || source.document_id || '',
        file_name: source.docnm_kwd || source.document_keyword || '',
        page: firstPosition(source.position_int || source.positions || [])?.page || 0,
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
    return { results: await filterDeleted(results) };
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
    return { results: await filterDeleted(results) };
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
    const page = firstPosition(chunk.positions || chunk.position_int || [])?.page || 0;
    return imageResponse(chunk.img_id || chunk.image_id, documentId, page);
  }

  async function block(documentId, blockId) {
    const id = await resolveDatasetId();
    const payload = await request(
      `/api/v1/datasets/${encodeURIComponent(id)}/documents/${encodeURIComponent(documentId)}/chunks/${encodeURIComponent(blockId)}`,
    );
    const chunk = payload?.data;
    if (!chunk || chunk === false) throw new Error('RAGFlow 分片不存在');
    return {
      doc_id: documentId,
      file_name: chunk.docnm_kwd || chunk.document_keyword || '',
      block_id: chunk.id || blockId,
      section: chunk.section || '',
      page: firstPosition(chunk.positions || chunk.position_int || [])?.page || 0,
      bbox: [],
      text: chunk.content || chunk.content_with_weight || '',
    };
  }

  async function deleteDocument(documentId) {
    const id = await resolveDatasetId();
    await request(`/api/v1/datasets/${encodeURIComponent(id)}/documents`, {
      method: 'DELETE',
      body: JSON.stringify({ ids: [documentId], delete_all: false }),
    });
    return { doc_id: documentId, deleted: true };
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

  async function indexDocument(filePath, fileName) {
    const id = await resolveDatasetId();
    const buffer = await readFile(filePath);
    const form = new FormData();
    form.append('file', new Blob([buffer], { type: 'application/pdf' }), fileName);
    const uploaded = await request(`/api/v1/datasets/${encodeURIComponent(id)}/documents`, {
      method: 'POST',
      body: form,
    });
    const doc = Array.isArray(uploaded?.data) ? uploaded.data[0] : uploaded?.data;
    if (!doc?.id) throw new Error('RAGFlow 上传文档失败');
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

  async function health() {
    const response = await fetch(joinUrl(baseUrl, '/api/v1/system/healthz'));
    if (!response.ok) throw new Error(`RAGFlow HTTP ${response.status}`);
    return response.json();
  }

  return { exact, hybrid, health, pageImage, block, blockImage, deleteDocument, indexDocument };
}
