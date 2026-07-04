FROM node:20-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
COPY . .
# Build-time config baked into the static bundle:
#   VITE_API_URL   — the shared Minerva api (badges endpoint)
#   VITE_*_URL     — where each deity's app is served (tiles open these)
# All are env edits at deploy time, so the Railway→custom-domain cutover is no code change.
ARG VITE_API_URL=http://localhost:3000
ARG VITE_MINERVA_URL
ARG VITE_VULCAN_URL
ARG VITE_JUNO_URL
ARG VITE_CERES_URL
ENV VITE_API_URL=$VITE_API_URL \
    VITE_MINERVA_URL=$VITE_MINERVA_URL \
    VITE_VULCAN_URL=$VITE_VULCAN_URL \
    VITE_JUNO_URL=$VITE_JUNO_URL \
    VITE_CERES_URL=$VITE_CERES_URL
RUN npm run build

# serve the built bundle
FROM node:20-slim AS serve
WORKDIR /app
RUN npm install -g serve@14
COPY --from=build /app/dist ./dist
EXPOSE 5177
# Listen on the platform-provided PORT (Railway), falling back to 5177 locally.
CMD ["sh", "-c", "serve -s dist -l ${PORT:-5177}"]
