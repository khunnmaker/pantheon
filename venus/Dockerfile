# Built from the REPO ROOT context, not the venus/ subdir, so the shared workspace package
# (packages/pantheon-ui) is inside the build context — required since venus joined the suite
# SSO (App.tsx imports @pantheon/ui). On Railway set this service's Root Directory = repo root
# and Dockerfile Path = venus/Dockerfile (same convention as every other deity service).
FROM node:20-slim AS build
WORKDIR /app
# Root manifests + the shared package + this app. Sibling apps are intentionally NOT copied;
# `npm ci` at the workspace root tolerates absent sibling workspaces and installs only what is
# present (the pantheon-ui + venus subtree), which keeps the image lean.
COPY package.json package-lock.json ./
COPY packages/ ./packages/
COPY venus/ ./venus/
RUN npm ci
# API base URL is baked at build time for the static bundle (points at the shared Minerva api)
ARG VITE_API_URL=http://localhost:3000
ENV VITE_API_URL=$VITE_API_URL
RUN npm -w venus run build

# serve the built bundle
FROM node:20-slim AS serve
WORKDIR /app
RUN npm install -g serve@14
COPY --from=build /app/venus/dist ./dist
EXPOSE 5178
# Listen on the platform-provided PORT (Railway), falling back to 5178 locally.
CMD ["sh", "-c", "serve -s dist -l ${PORT:-5178}"]
