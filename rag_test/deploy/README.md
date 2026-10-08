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

## 启动

```bash
docker compose --env-file .env -f docker-compose.prod.yml up -d --build
```

访问：

```text
https://你的 DOMAIN
```

## 说明

- PostgreSQL 和 Qdrant 由 Compose 管理。
- `RAGFLOW_*` 指向我们自己的 RAGFlow 服务和知识库。
- `ES_*` 用于 RAGFlow 精确检索。
- LLM 通过 `LLM_BASE_URL` 调用。
- Caddy 自动申请和续期 HTTPS 证书。
- 如果 RAGFlow 或 LLM 不在宿主机，请把 `host.docker.internal` 改成实际地址。
