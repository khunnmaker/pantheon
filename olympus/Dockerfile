# Built from the REPO ROOT context (not the olympus/ subdir) so the shared workspace package
# (packages/pantheon-ui) is inside the build context, matching juno/vesta/apollo etc. On Railway
# set this service's Root Directory = repo root and Dockerfile Path = olympus/Dockerfile.
FROM node:20-slim AS build
WORKDIR /app
# Root manifests + the shared package + this app. Sibling apps are intentionally NOT copied;
# `npm ci` at the workspace root tolerates absent sibling workspaces and installs only what is
# present (the pantheon-ui + olympus subtree), which keeps the image lean.
COPY package.json package-lock.json ./
COPY packages/ ./packages/
COPY olympus/ ./olympus/
RUN npm ci
# Baked at build time for the static bundle — Olympus talks to the shared Pantheon api and
# bounces logged-out visitors to the shared portal for SSO, same as every other suite app.
ARG VITE_API_URL=http://localhost:3000
ARG VITE_PORTAL_URL=https://pantheon.prominentdental.com
ENV VITE_API_URL=$VITE_API_URL VITE_PORTAL_URL=$VITE_PORTAL_URL
RUN npm -w olympus run build

# serve the built bundle
FROM node:20-slim AS serve
WORKDIR /app
RUN npm install -g serve@14
COPY --from=build /app/olympus/dist ./dist
EXPOSE 5181
# Listen on the platform-provided PORT (Railway), falling back to 5181 locally. `serve -s`
# rewrites unknown paths to index.html, so a direct /hestia load gets SPA fallback.
CMD ["sh", "-c", "serve -s dist -l ${PORT:-5181}"]
