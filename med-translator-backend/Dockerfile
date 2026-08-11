FROM node:22-bookworm-slim AS runtime

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY scripts/deploy-healthcheck.mjs scripts/deploy-maintenance.mjs ./scripts/
RUN mkdir -p /app/uploads && chown -R node:node /app

USER node
EXPOSE 8080

CMD ["node", "src/server.js"]
