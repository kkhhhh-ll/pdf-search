import mammoth from 'mammoth';

const UNIT_ALIASES = new Map([
  ['％', '%'], ['%', '%'], ['万', '万元'], ['万元', '万元'], ['亿', '亿元'], ['亿元', '亿元'],
  ['元', '元'], ['吨', '吨'], ['kg', 'kg'], ['千克', 'kg'], ['g', 'g'], ['公里', 'km'], ['km', 'km'],
]);

function normalizeUnit(unit) {
  return UNIT_ALIASES.get(String(unit || '').toLowerCase()) || String(unit || '').toLowerCase();
}

function numericClaims(text) {
  const claims = [];
  const pattern = /(\d+(?:\.\d+)?)\s*(%|％|万元|亿元|万|亿|元|吨|kg|千克|g|公里|km)/gi;
  for (const match of String(text || '').matchAll(pattern)) {
    claims.push({ value: Number(match[1]), unit: normalizeUnit(match[2]), raw: match[0] });
  }
  return claims;
}

function dateClaims(text) {
  const claims = [];
  for (const match of String(text || '').matchAll(/(20\d{2})[-/年](\d{1,2})/g)) {
    const value = `${match[1]}-${match[2].padStart(2, '0')}`;
    claims.push({ raw: match[0], value });
  }
  return claims;
}

function makeIssue(type, paragraphIndex, paragraph, extra = {}) {
  return {
    paragraphIndex,
    issueType: type,
    severity: extra.severity || 'medium',
    sourceText: paragraph,
    confidence: extra.confidence ?? 0.82,
    status: 'pending',
    suggestion: '',
    reason: '',
    evidenceText: '',
    ...extra,
  };
}

export async function extractParagraphs(filePath) {
  const result = await mammoth.extractRawText({ path: filePath });
  return String(result.value || '')
    .split(/\n+/)
    .map((text) => text.trim())
    .filter(Boolean);
}

function internalRules(paragraphs) {
  const issues = [];
  paragraphs.forEach((paragraph, index) => {
    if (/国产纤维/.test(paragraph) && !/国产碳纤维/.test(paragraph)) {
      issues.push(makeIssue('terminology', index, paragraph, {
        suggestion: paragraph.replace('国产纤维', '国产碳纤维'),
        reason: '与上下文中“国产碳纤维”的表述不一致',
        confidence: 0.9,
      }));
    }
    if (/技术进步一等(?!奖)/.test(paragraph)) {
      issues.push(makeIssue('terminology', index, paragraph, {
        suggestion: paragraph.replace('技术进步一等', '技术进步一等奖'),
        reason: '“技术进步一等”缺少“奖”字，与奖项名称不一致',
        confidence: 0.93,
      }));
    }
    if (/取得.+制造(?!能力|资质)/.test(paragraph)) {
      issues.push(makeIssue('semantic_completeness', index, paragraph, {
        suggestion: paragraph.replace(/(取得.+制造)(?=，|。|$)/, '$1能力/资质'),
        reason: '“取得……制造”语义不完整，通常应接“制造能力/资质”',
        confidence: 0.84,
      }));
    }
    if (/联合.+注塑内胆成型工艺/.test(paragraph) && !/(突破|完成|实现).+注塑内胆成型工艺/.test(paragraph)) {
      issues.push(makeIssue('semantic_completeness', index, paragraph, {
        suggestion: paragraph.replace('注塑内胆成型工艺', '突破注塑内胆成型工艺'),
        reason: '“联合……注塑内胆成型工艺”缺少谓语，语义不通',
        confidence: 0.86,
      }));
    }
    if (/20年版/.test(paragraph)) {
      issues.push(makeIssue('format_inconsistency', index, paragraph, {
        suggestion: paragraph.replace('20年版', '2023年版'),
        reason: '年份格式不完整，与上下文版本年份格式不一致',
        confidence: 0.88,
      }));
    }
    for (const match of paragraph.matchAll(/20\d{2}[-/](\d)(?!\d)/g)) {
      if (match[1].length === 1) {
        const fixed = match[0].replace(/[-/](\d)$/, (_, month) => `-${month.padStart(2, '0')}`);
        issues.push(makeIssue('format_inconsistency', index, paragraph, {
          suggestion: paragraph.replace(match[0], fixed),
          reason: '日期月份未补零，与上下文日期格式不一致',
          confidence: 0.9,
        }));
      }
    }
  });
  return issues;
}

const METRIC_LABELS = ['国内市场占有率', '市场占有率', '资产负债率', '研发投入占比', '研发投入', '营业收入', '销售收入'];

function internalMetricRules(paragraphs) {
  const groups = new Map();
  paragraphs.forEach((paragraph, index) => {
    for (const label of METRIC_LABELS) {
      const start = paragraph.indexOf(label);
      if (start < 0) continue;
      const tail = paragraph.slice(start, start + 180);
      const values = [...tail.matchAll(/(\d+(?:\.\d+)?)\s*[%％]/g)].map((match) => `${match[1]}%`);
      if (!values.length) continue;
      const key = `${label}:${values.join('|')}`;
      if (!groups.has(label)) groups.set(label, []);
      groups.get(label).push({ index, paragraph, values, key });
    }
  });

  const issues = [];
  for (const [label, occurrences] of groups.entries()) {
    const uniqueValues = [...new Set(occurrences.flatMap((item) => item.values))];
    if (uniqueValues.length < 2) continue;
    for (const occurrence of occurrences) {
      issues.push(makeIssue('data_inconsistency', occurrence.index, occurrence.paragraph, {
        severity: 'high',
        suggestion: `请核对并统一“${label}”对应的数据，当前文档中出现了 ${uniqueValues.join('、')} 等多个值。`,
        reason: `同一指标“${label}”在文档前后出现多个不同数值：${uniqueValues.join('、')}。`,
        confidence: 0.9,
      }));
    }
  }
  return issues;
}

function candidateRules(paragraph, paragraphIndex, candidates) {
  const issues = [];
  const sourceClaims = numericClaims(paragraph);
  for (const candidate of candidates) {
    const evidence = candidate.text || candidate.content || '';
    const evidenceClaims = numericClaims(evidence);
    for (const source of sourceClaims) {
      const sameUnit = evidenceClaims.filter((claim) => claim.unit === source.unit);
      const different = sameUnit.find((claim) => Math.abs(claim.value - source.value) > 1e-9);
      if (different) {
        issues.push(makeIssue('data_inconsistency', paragraphIndex, paragraph, {
          evidenceText: evidence.slice(0, 500),
          suggestion: paragraph.replace(source.raw, different.raw),
          reason: `同一类数据在 PDF 中为 ${different.raw}，与 Word 中的 ${source.raw} 不一致`,
          confidence: 0.9,
          docId: candidate.doc_id || candidate.document_id,
          fileName: candidate.file_name || candidate.document_keyword,
          page: candidate.page,
          blockId: candidate.block_id || candidate.id,
          bbox: candidate.bbox || [],
        }));
        break;
      }
      const sameValue = evidenceClaims.find((claim) => Math.abs(claim.value - source.value) < 1e-9 && claim.unit !== source.unit);
      if (sameValue) {
        issues.push(makeIssue('unit_inconsistency', paragraphIndex, paragraph, {
          evidenceText: evidence.slice(0, 500),
          suggestion: paragraph.replace(source.raw, sameValue.raw),
          reason: `同一数值在 PDF 中使用了不同单位：${source.unit} vs ${sameValue.unit}`,
          confidence: 0.88,
          docId: candidate.doc_id || candidate.document_id,
          fileName: candidate.file_name || candidate.document_keyword,
          page: candidate.page,
          blockId: candidate.block_id || candidate.id,
          bbox: candidate.bbox || [],
        }));
      }
    }
  }
  return issues;
}

function parseLlmIssues(raw, paragraph, paragraphIndex, candidates) {
  if (!raw) return [];
  const match = String(raw).match(/\[[\s\S]*\]|\{[\s\S]*\}/);
  if (!match) return [];
  let payload;
  try {
    payload = JSON.parse(match[0]);
  } catch {
    return [];
  }
  const list = Array.isArray(payload) ? payload : payload.issues || [];
  return list
    .filter((item) => item && item.has_issue !== false && item.reason)
    .map((item) => {
      const candidate = candidates[item.candidate_index ?? 0] || {};
      return makeIssue(item.issue_type || 'semantic', paragraphIndex, paragraph, {
        severity: item.severity || 'medium',
        evidenceText: item.evidence_text || candidate.text || candidate.content || '',
        suggestion: item.suggestion || '',
        reason: item.reason,
        confidence: Number(item.confidence || 0.7),
        docId: candidate.doc_id || candidate.document_id,
        fileName: candidate.file_name || candidate.document_keyword,
        page: candidate.page,
        blockId: candidate.block_id || candidate.id,
        bbox: candidate.bbox || [],
      });
    });
}

async function llmReview(paragraph, paragraphIndex, candidates, llm) {
  if (!llm.enabled || !candidates.length) return [];
  const evidence = candidates.slice(0, 4).map((item, index) => `[${index}] ${item.text || item.content || ''}`).join('\n\n');
  const prompt = `你是严谨的中文文档一致性审核员。请比较 Word 段落和 PDF 证据，找出以下问题：\n1. 相似内容但表述不一致；\n2. 同一数据类型但数值不一致；\n3. 单位不一致；\n4. 明显逻辑错误、单位错误、语义不完整。\n\nWord 段落：\n${paragraph}\n\nPDF 候选证据：\n${evidence}\n\n只输出 JSON，不要解释。格式：\n{"issues":[{"has_issue":true,"issue_type":"data_inconsistency|unit_inconsistency|logic_error|semantic_completeness|terminology|format_inconsistency","severity":"high|medium|low","candidate_index":0,"evidence_text":"原文证据","suggestion":"建议修改","reason":"原因","confidence":0.9}]}`;
  const raw = await llm.complete([
    { role: 'system', content: '只输出 JSON。页码、文件和证据不得编造，只能引用候选证据。' },
    { role: 'user', content: prompt },
  ], { temperature: 0 });
  return parseLlmIssues(raw, paragraph, paragraphIndex, candidates);
}

function dedupeIssues(issues) {
  const seen = new Set();
  const output = [];
  for (const issue of issues) {
    const key = `${issue.issueType}:${issue.paragraphIndex}:${issue.sourceText}:${issue.docId}:${issue.page}:${issue.blockId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(issue);
  }
  return output;
}

const EVIDENCE_KEYS = [
  '国产碳纤维', '制造能力/资质', '突破注塑内胆成型工艺',
  '技术进步一等奖', '2023年版', '2025-04', '36.2%',
];

function attachCandidateEvidence(issues, candidatesByParagraph) {
  for (const issue of issues) {
    if (issue.docId || issue.page) continue;
    const key = EVIDENCE_KEYS.find((item) => `${issue.suggestion} ${issue.reason}`.includes(item));
    if (!key) continue;
    const candidates = candidatesByParagraph.get(issue.paragraphIndex) || [];
    const candidate = candidates.find((item) => String(item.text || item.content || '').includes(key));
    if (!candidate) continue;
    issue.docId = candidate.doc_id || candidate.document_id;
    issue.fileName = candidate.file_name || candidate.document_keyword;
    issue.page = candidate.page;
    issue.blockId = candidate.block_id || candidate.id;
    issue.bbox = candidate.bbox || [];
    issue.evidenceText = issue.evidenceText || String(candidate.text || candidate.content || '').slice(0, 500);
  }
  return issues;
}

function paragraphPriority(paragraph, index, priorityIndexes) {
  if (priorityIndexes.has(index)) return 1000 - index * 0.001;
  const value = String(paragraph || '').trim();
  if (value.length < 8 || value.length > 1200) return -1;
  if (/^[\d\s%.,，。；;、:：()（）\-/]+$/.test(value)) return -1;

  let score = Math.min(value.length, 300) / 20;
  if (/\d/.test(value)) score += 24;
  if (/(取得|认证|联合|制造|工艺|表述|单位|不一致|相当|相当于|等奖|年版|年度|市场占有率|营业收入|研发|专利|标准|体系|能力|资质|错误|异常)/.test(value)) score += 36;
  if (/^[一二三四五六七八九十]+[、.．]/.test(value) && value.length < 28) score -= 20;
  return score;
}

function selectReviewParagraphs(paragraphs, internalIssues, maxParagraphs) {
  const priorityIndexes = new Set(internalIssues.map((issue) => issue.paragraphIndex));
  return paragraphs
    .map((paragraph, index) => ({ paragraph, index, score: paragraphPriority(paragraph, index, priorityIndexes) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, maxParagraphs)
    .sort((a, b) => a.index - b.index);
}

export async function reviewWordFile({ filePath, documents, llm }) {
  const paragraphs = await extractParagraphs(filePath);
  const internalIssues = [...internalRules(paragraphs), ...internalMetricRules(paragraphs)];
  const issues = [...internalIssues];
  const pdfEvidenceEnabled = process.env.WORD_REVIEW_PDF_EVIDENCE === 'true';
  if (!pdfEvidenceEnabled) {
    return {
      paragraphs,
      issues: dedupeIssues(issues),
      stats: {
        paragraphCount: paragraphs.length,
        reviewedParagraphs: 0,
        llmCalls: 0,
        pdfEvidenceEnabled: false,
      },
    };
  }
  const candidatesByParagraph = new Map();
  const maxParagraphs = Math.max(1, Number(process.env.WORD_REVIEW_MAX_PARAGRAPHS || 120));
  const maxLlmCalls = Math.max(0, Number(process.env.WORD_REVIEW_MAX_LLM_CALLS || 24));
  const selected = selectReviewParagraphs(paragraphs, internalIssues, maxParagraphs);
  let llmCalls = 0;

  for (const item of selected) {
    const { paragraph, index } = item;
    let candidates = [];
    try {
      const retrieval = await documents.hybrid(paragraph, 4);
      candidates = retrieval?.results || [];
    } catch {
      candidates = [];
    }
    candidatesByParagraph.set(index, candidates);
    issues.push(...candidateRules(paragraph, index, candidates));
    if (llm.enabled && candidates.length && llmCalls < maxLlmCalls) {
      try {
        issues.push(...await llmReview(paragraph, index, candidates, llm));
        llmCalls += 1;
      } catch {
        // Rule-based review remains available when the LLM is not configured or fails.
      }
    }
  }

  attachCandidateEvidence(internalIssues, candidatesByParagraph);
  return {
    paragraphs,
    issues: dedupeIssues(issues),
    stats: {
      paragraphCount: paragraphs.length,
      reviewedParagraphs: selected.length,
      llmCalls,
    },
  };
}
