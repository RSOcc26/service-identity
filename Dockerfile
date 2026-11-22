# syntax=docker/dockerfile:1
# Production image: runtime dependencies only, non-root, read-only friendly.
# Migrations run at startup (src/data/migrate.js), so they are part of the image.

FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# Install scripts stay on: @confluentinc/kafka-javascript fetches its prebuilt librdkafka binary
RUN npm ci --omit=dev && npm cache clean --force

FROM node:24-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY migrations ./migrations
# Numeric user, so Kubernetes runAsNonRoot can verify it (the "node" user of the base image)
USER 1000:1000
EXPOSE 3000
CMD ["node", "src/server.js"]
