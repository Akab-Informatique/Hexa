# Builds the instance and console images:
#   docker build -f deploy/docker/Dockerfile --build-arg APP=instance -t nexo-instance .
#   docker build -f deploy/docker/Dockerfile --build-arg APP=console  -t nexo-console  .
FROM node:22-bookworm-slim
ARG APP=instance
ENV NODE_ENV=production APP=${APP}
WORKDIR /app

COPY package.json package-lock.json ./
COPY packages ./packages
COPY apps ./apps
COPY modules ./modules
COPY deploy/client-bundle ./deploy/client-bundle
RUN npm ci --omit=dev --workspaces --include-workspace-root && chown -R node:node /app

USER node
EXPOSE 3000 8080
HEALTHCHECK --interval=15s --timeout=5s --start-period=40s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||(process.env.APP==='console'?8080:3000))+(process.env.APP==='console'?'/api/ping':'/api/health')).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["sh", "-c", "exec node --import tsx apps/$APP/src/index.ts"]
