# Built from the repository root so the shared @pantheon/ui workspace is available.
FROM node:20-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/ ./packages/
COPY pantheon/ ./pantheon/
RUN npm ci
ARG VITE_API_URL=http://localhost:3000
ARG VITE_MINERVA_URL
ARG VITE_VESTA_URL
ARG VITE_JUNO_URL
ARG VITE_JUPITER_URL
ARG VITE_CERES_URL
ARG VITE_MERCURY_URL
ENV VITE_API_URL=$VITE_API_URL \
    VITE_MINERVA_URL=$VITE_MINERVA_URL \
    VITE_VESTA_URL=$VITE_VESTA_URL \
    VITE_JUNO_URL=$VITE_JUNO_URL \
    VITE_JUPITER_URL=$VITE_JUPITER_URL \
    VITE_CERES_URL=$VITE_CERES_URL \
    VITE_MERCURY_URL=$VITE_MERCURY_URL
RUN npm -w pantheon run build

FROM node:20-slim AS serve
WORKDIR /app
RUN npm install -g serve@14
COPY --from=build /app/pantheon/dist ./dist
EXPOSE 5179
CMD ["sh", "-c", "serve -s dist -l ${PORT:-5179}"]
