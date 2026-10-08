# RAGFlow 大文件嵌入优化

RAGFlow v0.27.2 的 TEI/HuggingFace embedding 客户端默认：

```text
单次批次：16 条
HTTP 超时：30 秒
```

28 页以上的 PDF 在 CPU 上可能因为一次嵌入请求超过 30 秒而解析失败。

本目录的补丁将其改为可配置：

```text
RAGFLOW_EMBED_BATCH_SIZE=4
RAGFLOW_EMBED_TIMEOUT=180
```

## 应用补丁

假设 RAGFlow 源码目录为当前目录父级：

```bash
cd /path/to/ragflow
patch -p1 < /path/to/pdf-search/rag_test/deploy/ragflow/embedding-timeout.patch
```

在 RAGFlow 的 `.env` 中增加：

```env
RAGFLOW_EMBED_BATCH_SIZE=4
RAGFLOW_EMBED_TIMEOUT=180
```

如果 RAGFlow 容器不重新构建镜像，需要把修改后的文件挂载进容器：

```yaml
services:
  ragflow-cpu:
    volumes:
      - ./rag/llm/embedding_model.py:/ragflow/rag/llm/embedding_model.py:ro
```

然后重启 RAGFlow：

```bash
docker compose up -d --force-recreate ragflow-cpu
```

检查配置是否进入容器：

```bash
docker exec ragflow-ragflow-cpu-1 sh -lc \
  'echo $RAGFLOW_EMBED_BATCH_SIZE $RAGFLOW_EMBED_TIMEOUT'
```

预期输出：

```text
4 180
```
