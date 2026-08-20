FROM node:24-slim

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package.json server.js db.js auth.js media.js seed.js smoke.js ./
COPY public/ ./public/
COPY stock-videos/ ./stock-videos/
COPY entrypoint.sh ./

RUN chmod +x entrypoint.sh \
  && mkdir -p /app/data \
  && chown -R node:node /app

ENV NODE_ENV=production \
    PORT=8080 \
    VANTAGE_DATA=/app/data \
    STOCK_DIR=/app/stock-videos \
    AUTO_SEED=1

USER node
EXPOSE 8080

HEALTHCHECK --interval=15s --timeout=5s --start-period=25s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/app/entrypoint.sh"]
