## Build the static bundle, then serve it from nginx. Nothing in OVERSTRIKE runs
## server-side — the whole game is the client — so the runtime image carries no node.

FROM node:22-alpine AS build
WORKDIR /app

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
