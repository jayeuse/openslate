FROM node:24-alpine AS dependencies
WORKDIR /app
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci

FROM node:24-alpine AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
ARG NEXT_PUBLIC_LIFECYCLE_PURGE_ENABLED
ENV NEXT_PUBLIC_LIFECYCLE_PURGE_ENABLED=$NEXT_PUBLIC_LIFECYCLE_PURGE_ENABLED
COPY --from=dependencies /app/node_modules ./node_modules
COPY frontend/ ./
COPY contracts/ /contracts/
RUN test -n "$NEXT_PUBLIC_LIFECYCLE_PURGE_ENABLED" \
    && npm run build -- --from-process

FROM node:24-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1

RUN addgroup --system --gid 10001 nodejs && adduser --system --uid 10001 nextjs
COPY --from=builder --chown=nextjs:nodejs /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/tooling/start-standalone.mjs ./tooling/start-standalone.mjs
COPY --from=builder --chown=nextjs:nodejs /app/src/lib/environment.ts ./src/lib/environment.ts
USER nextjs

CMD ["node", "tooling/start-standalone.mjs", "--from-process"]
