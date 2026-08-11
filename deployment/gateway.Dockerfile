FROM node:22-bookworm-slim AS frontend-build

WORKDIR /workspace/med-translator-frontend
COPY med-translator-frontend/package.json med-translator-frontend/package-lock.json ./
RUN npm ci
COPY med-translator-frontend ./

ARG VITE_API_URL=/api/translate
ENV VITE_API_URL=${VITE_API_URL}
RUN npm run build

FROM caddy:2.10-alpine
COPY deployment/Caddyfile /etc/caddy/Caddyfile
COPY --from=frontend-build /workspace/med-translator-frontend/dist /srv
