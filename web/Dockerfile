# PILOT (punch #5): built from the REPO ROOT context, not the web/ subdir, so the shared
# workspace package (packages/pantheon-ui) is inside the build context. On Railway set this
# service's Root Directory = repo root and Dockerfile Path = web/Dockerfile.
FROM node:20-slim AS build
WORKDIR /app
# Root manifests + the shared package + this app. Sibling apps are intentionally NOT copied;
# `npm ci` at the workspace root tolerates absent sibling workspaces and installs only what is
# present (the pantheon-ui + web subtree), which keeps the image lean.
COPY package.json package-lock.json ./
COPY packages/ ./packages/
COPY web/ ./web/
RUN npm ci
# API base URL is baked at build time for the static bundle (points at the shared Minerva api)
ARG VITE_API_URL=http://localhost:3000
ENV VITE_API_URL=$VITE_API_URL
RUN npm -w web run build

# serve the built bundle
FROM node:20-slim AS serve
WORKDIR /app
RUN npm install -g serve@14
COPY --from=build /app/web/dist ./dist
EXPOSE 5173
# Listen on the platform-provided PORT (Railway), falling back to 5173 locally.
CMD ["sh", "-c", "serve -s dist -l ${PORT:-5173}"]
