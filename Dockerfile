# syntax=docker/dockerfile:1
# DataMind — image autonome : un seul processus Node sert l'API (Fastify + DuckDB) et l'interface compilée.
#   docker build -t datamind .
#   docker run -p 3600:3600 -v datamind:/data -e OLLAMA_URL=http://host.docker.internal:11434 datamind

FROM node:22-bookworm-slim AS build
ENV CI=1
WORKDIR /app
COPY package.json package-lock.json ./
COPY backend/package.json backend/
COPY frontend/package.json frontend/
RUN npm ci --include=dev --no-audit --no-fund
COPY . .
RUN npm run build && npm prune --omit=dev --no-audit --no-fund

FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3600 \
    DATA_DIR=/data \
    STATIC_DIR=/app/frontend/dist \
    SAMPLES_DIR=/app/sample_data
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/backend/package.json ./backend/
COPY --from=build /app/backend/dist ./backend/dist
COPY --from=build /app/frontend/dist ./frontend/dist
COPY sample_data ./sample_data
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 3600
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "backend/dist/server.js"]
