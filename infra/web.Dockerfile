# The browser client (M12j): the desktop React bundle built once, served by Caddy next to the API.
# Build context is the repository root (see docker-compose.yml, service `caddy`).
FROM node:22-alpine AS build
# The repository's layout is kept: the page editor imports its native bridge from apps/shared/mobile-editor/src
# (M153a, docs/WIKI.md §30.3).
WORKDIR /repo/apps/desktop
COPY apps/desktop/package.json apps/desktop/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY apps/shared/mobile-editor/src /repo/apps/shared/mobile-editor/src
COPY apps/desktop/ ./
RUN npm run build

FROM caddy:2
COPY infra/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /repo/apps/desktop/dist /srv/web
