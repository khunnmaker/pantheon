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
EXPOSE 5174
# Listen on the platform-provided PORT (Railway), falling back to 5174 locally.
CMD ["sh", "-c", "serve -s dist -l ${PORT:-5174}"]
