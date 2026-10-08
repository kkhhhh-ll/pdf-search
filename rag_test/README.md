# 知索 · 中文 PDF 知识库

当前版本使用我们自己的 BFF 对接开源 RAGFlow，不再依赖同事的 `pdf-search` FastAPI。

## 架构

```text
浏览器（React + Vite）
        │
        ▼
rag_test/server（我们的 BFF）
  ├─ 登录、用户、权限
  ├─ 会话与消息持久化
  ├─ PDF 上传与异步索引队列
  ├─ 精确检索 / 语义检索适配
  ├─ PDF 分片证据图片
  └─ 聊天内 Word 一致性审核
        │
        ▼
RAGFlow
  ├─ PaddleOCR / PP-StructureV3
  ├─ BGE-M3 / TEI
  ├─ Elasticsearch
  ├─ MySQL
  ├─ Redis
  └─ MinIO
```

## 环境变量

```env
PORT=8787
DATABASE_URL=postgres://zhisuo:zhisuo@127.0.0.1:5432/zhisuo

CONSOLE_USER=admin
CONSOLE_PASSWORD=admin

RAGFLOW_BASE_URL=http://127.0.0.1:9380
RAGFLOW_API_KEY=ragflow-xxxx
RAGFLOW_DATASET_ID=
ES_URL=http://127.0.0.1:1200
ES_USER=elastic
ES_PASSWORD=infini_rag_flow
RAGFLOW_PARSE_TIMEOUT_MS=600000

LLM_BASE_URL=https://api.deepseek.com/v1
LLM_API_KEY=sk-xxxx
LLM_MODEL=deepseek-flash
LLM_TIMEOUT_MS=120000

UPLOAD_MAX_BYTES=524288000
```

`RAGFLOW_DATASET_ID` 留空时，BFF 会选择 RAGFlow 中的第一个知识库。

## 启动 RAGFlow

RAGFlow 使用开源栈独立运行，至少需要：

```text
RAGFlow API:    http://127.0.0.1:9380
RAGFlow Web:    http://127.0.0.1:8081
Elasticsearch: http://127.0.0.1:1200
BGE-M3 / TEI:  http://127.0.0.1:6380
```

我们的 `rag-provider` 使用以下能力：

```text
POST   /api/v1/datasets/{dataset_id}/documents
POST   /api/v1/datasets/{dataset_id}/documents/parse
GET    /api/v1/datasets/{dataset_id}/documents
GET    /api/v1/datasets/{dataset_id}/documents/{document_id}/chunks
GET    /api/v1/documents/images/{image_id}
POST   /api/v1/retrieval
DELETE /api/v1/datasets/{dataset_id}/documents
```

精确检索同时读取 RAGFlow 的 Elasticsearch 索引：

```text
ragflow_{tenant_id}
filter: kb_id = dataset_id
```

## 启动 BFF 和前端

```bash
cd rag_test

# PostgreSQL：会话、消息、Word 审核持久化
docker compose -f docker-compose.postgres.yml up -d

# 开发模式
npm install
npm run dev
```

浏览器访问：

```text
http://127.0.0.1:8787
```

## Web 功能

```text
PostgreSQL 登录、用户和会话存储
多会话、停止生成、重新生成
流式聊天 SSE
Markdown 标题、列表、表格、代码块渲染
PDF 上传和异步索引
RAGFlow 精确检索
RAGFlow BGE-M3 语义检索
RAGFlow 分片证据图片
聊天内 Word 一致性审核
管理员用户管理
```

## Word 审核

Word 审核现在直接发生在 Chat 中：

1. 在聊天输入区点击“审核 Word”
2. 选择 `.docx`
3. assistant 消息显示审核进度
4. 完成后在 Chat 内展示问题列表
5. 点击问题打开对应 RAGFlow 分片证据图片

Word 审核使用：

```text
mammoth 解析 Word 段落
RAGFlow retrieval 获取相似 PDF 证据
规则引擎检查数值、单位、日期、术语和逻辑
LLM 复核语义问题
```

## 生产部署

```bash
cd rag_test/deploy
cp .env.prod.example .env
docker compose --env-file .env -f docker-compose.prod.yml up -d --build
```

生产配置需要准备：

```text
DOMAIN
POSTGRES_PASSWORD
CONSOLE_PASSWORD
RAGFLOW_BASE_URL
RAGFLOW_API_KEY
RAGFLOW_DATASET_ID
ES_URL
ES_USER
ES_PASSWORD
LLM_BASE_URL
LLM_API_KEY
LLM_MODEL
```

如果 RAGFlow 不在宿主机，把 `.env` 中的 `host.docker.internal` 改成实际地址。
