# The browser client (M12j): the desktop React bundle built once, served by Caddy next to the API.
# Build context is the repository root (see docker-compose.yml, service `caddy`).
FROM node:22-alpine AS build
WORKDIR /src
COPY apps/desktop/package.json apps/desktop/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY apps/desktop/ ./
RUN npm run build

FROM caddy:2
COPY infra/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /src/dist /srv/web
