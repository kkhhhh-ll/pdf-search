# 生产部署

## 准备

```bash
cd rag_test/deploy
cp .env.prod.example .env
```

修改 `.env`：

```text
DOMAIN
POSTGRES_PASSWORD
CONSOLE_PASSWORD
USER_MANAGEMENT_ENABLED
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

## 服务器前置条件

```text
Linux 服务器
Docker + Docker Compose
域名已解析到服务器公网 IP
开放 80/443
RAGFlow 服务可从宿主机访问
```

RAGFlow 至少需要暴露：

```text
9380  RAGFlow API
1200  Elasticsearch
```

如果 RAGFlow 与 BFF 不在同一台服务器，把 `.env` 中的 `host.docker.internal` 改成 RAGFlow 的实际内网地址。

## 完整启动顺序

1. 启动 RAGFlow、TEI、Elasticsearch。
2. 应用 `rag_test/deploy/ragflow/embedding-timeout.patch`。
3. 在 RAGFlow 中创建 API Key 和知识库。
4. 填写 `rag_test/deploy/.env`。
5. 启动 BFF：

```bash
docker compose --env-file .env -f docker-compose.prod.yml up -d --build
```

6. 浏览器访问 `https://你的 DOMAIN`。

## 启动

```bash
docker compose --env-file .env -f docker-compose.prod.yml up -d --build
```

访问：

```text
https://你的 DOMAIN
```

## 说明

- PostgreSQL 由 Compose 管理。
- 上传文件保存在 `app-data` 持久化卷中。
- `RAGFLOW_*` 指向我们自己的 RAGFlow 服务和知识库。
- `USER_MANAGEMENT_ENABLED=false` 时隐藏控制台中的用户管理。
- `ES_*` 用于 RAGFlow 精确检索。
- LLM 通过 `LLM_BASE_URL` 调用。
- Caddy 自动申请和续期 HTTPS 证书。
- 如果 RAGFlow 或 LLM 不在宿主机，请把 `host.docker.internal` 改成实际地址。

## RAGFlow 大文件嵌入优化

如果使用 RAGFlow v0.27.2 并在 CPU 上解析大 PDF，请先应用：

```text
rag_test/deploy/ragflow/embedding-timeout.patch
```

具体步骤见：

```text
rag_test/deploy/ragflow/README.md
```

默认配置为：

```env
RAGFLOW_EMBED_BATCH_SIZE=4
RAGFLOW_EMBED_TIMEOUT=180
```
