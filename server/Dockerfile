FROM node:22-bookworm-slim

# ffmpeg is needed to remux MKV and other formats into HLS. Debian's build includes libx264 and AAC.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src

RUN mkdir -p /data/cache && chown -R node:node /data /app
USER node

ENV NODE_ENV=production HOST=0.0.0.0 PORT=8787 CACHE_DIR=/data/cache
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:8787/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/index.js"]
