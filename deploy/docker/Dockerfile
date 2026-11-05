# Builds the instance and console images:
#   docker build -f deploy/docker/Dockerfile --build-arg APP=instance -t hexa-instance .
#   docker build -f deploy/docker/Dockerfile --build-arg APP=console  -t hexa-console  .

# ---- web build (React app served by the instance) ----
FROM node:22-bookworm-slim AS web
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages ./packages
COPY apps/web ./apps/web
RUN npm ci --workspace @hexa/web --workspace @hexa/shared --include-workspace-root \
 && npm run build -w @hexa/web

# ---- runtime ----
FROM node:22-bookworm-slim
ARG APP=instance
ENV NODE_ENV=production APP=${APP}
WORKDIR /app

COPY package.json package-lock.json ./
COPY packages ./packages
COPY apps/console ./apps/console
COPY apps/instance ./apps/instance
COPY apps/updater/package.json ./apps/updater/package.json
COPY apps/web/package.json ./apps/web/package.json
COPY modules ./modules
COPY deploy/client-bundle ./deploy/client-bundle
RUN npm ci --omit=dev --workspace @hexa/instance --workspace @hexa/console --workspace @hexa/shared --workspace @hexa/module-example-hello --include-workspace-root \
 && chown -R node:node /app
COPY --from=web --chown=node:node /app/apps/web/dist ./apps/web/dist

USER node
EXPOSE 3000 8080
HEALTHCHECK --interval=15s --timeout=5s --start-period=40s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||(process.env.APP==='console'?8080:3000))+(process.env.APP==='console'?'/api/ping':'/api/health')).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["sh", "-c", "exec node --import tsx apps/$APP/src/index.ts"]
