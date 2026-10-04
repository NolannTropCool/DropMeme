FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/server/package.json ./packages/server/
COPY packages/desktop/package.json ./packages/desktop/
RUN --mount=type=secret,id=npm_ca \
    if [ -r /run/secrets/npm_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/npm_ca; fi; \
    npm ci --fetch-retries=1 --fetch-timeout=30000 --workspace @dropmeme/server --workspace @dropmeme/shared --include-workspace-root
COPY packages/shared ./packages/shared
COPY packages/server ./packages/server
RUN npm run build:shared && npm run build --workspace @dropmeme/server

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production PORT=3000 DATABASE_PATH=/data/dropmeme.sqlite
WORKDIR /app
COPY --chown=node:node package.json package-lock.json ./
COPY --chown=node:node packages/shared/package.json ./packages/shared/
COPY --chown=node:node packages/server/package.json ./packages/server/
COPY --chown=node:node packages/desktop/package.json ./packages/desktop/
RUN --mount=type=secret,id=npm_ca \
    if [ -r /run/secrets/npm_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/npm_ca; fi; \
    npm ci --fetch-retries=1 --fetch-timeout=30000 --omit=dev --workspace @dropmeme/server --workspace @dropmeme/shared --include-workspace-root=false --ignore-scripts \
    && mkdir /data && chown node:node /data
COPY --from=build --chown=node:node /app/packages/shared/dist ./packages/shared/dist
COPY --from=build --chown=node:node /app/packages/server/dist ./packages/server/dist
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=45s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "packages/server/dist/index.js"]
