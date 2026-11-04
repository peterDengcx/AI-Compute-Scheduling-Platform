FROM node:20-alpine

WORKDIR /app

# 零依赖项目，只需要源码；先拷元信息，方便后续扩展依赖缓存
COPY package.json ./
COPY server.js ./
COPY public ./public

ENV NODE_ENV=production \
    PORT=8787

RUN mkdir -p /app/data

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8787/api/state > /dev/null || exit 1

CMD ["node", "server.js"]
