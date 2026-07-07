FROM node:20-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
COPY . .
# API base URL is baked at build time for the static bundle (points at the shared Minerva api)
ARG VITE_API_URL=http://localhost:3000
ENV VITE_API_URL=$VITE_API_URL
RUN npm run build

# serve the built bundle
FROM node:20-slim AS serve
WORKDIR /app
RUN npm install -g serve@14
COPY --from=build /app/dist ./dist
EXPOSE 5175
# Listen on the platform-provided PORT (Railway), falling back to 5175 locally.
# NOTE: NOT `serve -s` — `--single` rewrites EVERY path to /index.html, which would clobber the
# prerendered marketing pages (e.g. /lab would serve Home). Instead, dist/serve.json (from
# public/serve.json) serves the static prerendered files at their clean URLs and rewrites only
# the client-rendered routes (/catalog, /orders, /admin, /product/:sku) back to /index.html.
CMD ["sh", "-c", "serve dist -l ${PORT:-5175}"]
