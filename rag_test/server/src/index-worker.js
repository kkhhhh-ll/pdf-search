import { createRagFlowProvider } from './ragflow-provider.js';
import { claimNextQueuedDocument, updateDocument } from './document-store.js';

const RAGFLOW_BASE_URL = process.env.RAGFLOW_BASE_URL || 'http://127.0.0.1:9380';
const RAGFLOW_API_KEY = process.env.RAGFLOW_API_KEY || '';
const RAGFLOW_DATASET_ID = process.env.RAGFLOW_DATASET_ID || '';
const ES_URL = process.env.ES_URL || 'http://127.0.0.1:1200';
const ES_USER = process.env.ES_USER || 'elastic';
const ES_PASSWORD = process.env.ES_PASSWORD || '';
const worker = createRagFlowProvider({
  baseUrl: RAGFLOW_BASE_URL,
  apiKey: RAGFLOW_API_KEY,
  datasetId: RAGFLOW_DATASET_ID,
  esUrl: ES_URL,
  esUser: ES_USER,
  esPassword: ES_PASSWORD,
  parseTimeoutMs: Number(process.env.RAGFLOW_PARSE_TIMEOUT_MS || 600000),
});

export function startIndexWorker({ intervalMs = 2000 } = {}) {
  let running = false;

  async function tick() {
    if (running) return;
    running = true;
    try {
      const document = await claimNextQueuedDocument();
      if (document) {
        try {
          const result = await worker.indexDocument(document.storagePath, document.fileName);
          await updateDocument(document.userId, document.id, {
            backendDocId: result.doc_id || result.file_name || document.fileName,
            status: 'indexed',
          });
          console.log(`[index-worker] indexed ${document.fileName}`);
        } catch (error) {
          await updateDocument(document.userId, document.id, {
            status: 'failed',
            errorMessage: String(error?.message || error),
          });
          console.error(`[index-worker] failed ${document.fileName}:`, error);
        }
      }
    } finally {
      running = false;
    }
  }

  const timer = setInterval(() => void tick(), Math.max(500, Number(intervalMs) || 2000));
  void tick();
  return () => clearInterval(timer);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startIndexWorker();
}
