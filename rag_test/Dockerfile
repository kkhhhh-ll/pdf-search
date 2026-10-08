FROM node:22-alpine

WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

COPY package.json package-lock.json ./
COPY web/package.json web/package.json
COPY server/package.json server/package.json
RUN npm ci && \
    case "$(apk --print-arch)" in \
      aarch64) \
        ROLldown_BINDING="@rolldown/binding-linux-arm64-musl@1.2.13" \
        LIGHTNINGCSS_BINDING="lightningcss-linux-arm64-musl@1.33.0" \
        ;; \
      x86_64) \
        ROLldown_BINDING="@rolldown/binding-linux-x64-musl@1.2.13" \
        LIGHTNINGCSS_BINDING="lightningcss-linux-x64-musl@1.33.0" \
        ;; \
      *) echo "Unsupported build architecture: $(apk --print-arch)" >&2; exit 1 ;; \
    esac && \
    npm install --no-save --force --workspace web "$ROLldown_BINDING" "$LIGHTNINGCSS_BINDING"

COPY . .
RUN npm run build && npm prune --omit=dev

ENV NODE_ENV=production
EXPOSE 8787
CMD ["npm", "start"]
