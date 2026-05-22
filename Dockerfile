FROM oven/bun:1
WORKDIR /app
COPY package.json bun.lock ./
# --ignore-scripts: skip postinstall hooks (e.g. better-sqlite3's node-gyp rebuild)
# better-sqlite3 is a devDep used only by Vitest as a bun:sqlite shim — runtime uses bun:sqlite
RUN bun install --frozen-lockfile --ignore-scripts
COPY . .
RUN bun run build:web
ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD bun -e 'fetch("http://localhost:3000/healthz").then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))'
CMD ["bun", "run", "src/server/index.ts"]
