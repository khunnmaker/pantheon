FROM node:20-slim AS base
WORKDIR /app

# openssl is required by Prisma engines on slim images
RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

# install deps (cache-friendly)
COPY package.json package-lock.json* ./
RUN npm install

# prisma client needs the schema at generate time
COPY prisma ./prisma
RUN npx prisma generate

# app source
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

EXPOSE 3000
# apply migrations then start (safe to run on every boot)
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/index.js"]
