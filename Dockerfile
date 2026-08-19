## Build the static bundle, then serve it from nginx. This image is the CLIENT only —
## the dedicated game server is a separate app with its own image (Dockerfile.gameserver),
## so this runtime carries no node.
##
## VITE_SERVER_URL is baked in at build time and decides whether the shipped client looks
## for a server at all. Empty means single player: the game simulates in the tab exactly
## as it always did, so the offline experience never depends on the server being up.
##
##   fly deploy --build-arg VITE_SERVER_URL=wss://overstrike-gs.fly.dev

FROM node:22-alpine AS build
WORKDIR /app

ARG VITE_SERVER_URL=""
ENV VITE_SERVER_URL=$VITE_SERVER_URL

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build
# Pre-compress at maximum effort, once, at build time. Fly's proxy pulls from the
# origin without Accept-Encoding and re-encodes whatever it gets at a much lower
# level; handing it a finished .gz keeps the bundle at ~320 KB instead of ~473 KB.
RUN find dist -type f \( -name '*.js' -o -name '*.css' -o -name '*.html' -o -name '*.svg' -o -name '*.json' \) \
      -exec gzip -9 -k {} \;

FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 8080
CMD ["nginx", "-g", "daemon off;"]
