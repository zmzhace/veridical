FROM node:24-bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ ca-certificates && rm -rf /var/lib/apt/lists/*
RUN npm install --global pnpm@9.0.0
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile && pnpm -F @veridical/server build
RUN node packages/server/scripts/package-runtime.mjs /out

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production VERIDICAL_MODE=production
WORKDIR /app
COPY --from=build --chown=node:node /out /app
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD node -e "fetch('http://127.0.0.1:8787/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node","dist/server.cjs"]
