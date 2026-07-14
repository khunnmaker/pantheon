FROM node:20-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/ ./packages/
COPY apollo/ ./apollo/
RUN npm ci
ARG VITE_API_URL=http://localhost:3000
ARG VITE_PORTAL_URL=https://pantheon.prominentdental.com
ENV VITE_API_URL=$VITE_API_URL VITE_PORTAL_URL=$VITE_PORTAL_URL
RUN npm -w apollo run build

FROM node:20-slim AS serve
WORKDIR /app
RUN npm install -g serve@14
COPY --from=build /app/apollo/dist ./dist
EXPOSE 5180
CMD ["sh", "-c", "serve -s dist -l ${PORT:-5180}"]
