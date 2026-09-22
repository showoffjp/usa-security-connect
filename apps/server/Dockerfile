# USA Security Connect API.
# Node 22+ is required: the database driver is node:sqlite, built into Node.
FROM node:22-slim

WORKDIR /app
ENV NODE_ENV=production

# Install against the lockfile first so a code change does not re-resolve deps.
COPY package.json package-lock.json ./
COPY apps/server/package.json ./apps/server/
COPY packages/shared/package.json ./packages/shared/
RUN npm ci --omit=dev --workspace @usc/server --include-workspace-root

COPY packages/shared ./packages/shared
COPY apps/server ./apps/server

# The SQLite file and incident photos live here. Mount a volume at this path,
# or every deploy starts from an empty database.
ENV USC_DATA_DIR=/data
RUN mkdir -p /data && chown -R node:node /data
VOLUME ["/data"]

USER node
EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||4000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "apps/server/src/index.js"]
