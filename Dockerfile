# Production image for Hot-Tub-Control (Bestway hot tub ↔ Google Home).
FROM node:22-slim

ENV NODE_ENV=production
# Default the runtime state onto the mounted volume (see railway.json).
ENV DATA_DIR=/data

WORKDIR /app

# Install only production deps first for better layer caching.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# App source.
COPY src ./src

# Persistent state lives here. On Railway, attach a Railway Volume mounted at
# /data (a Docker `VOLUME` instruction is rejected by Railway's builder, so we
# only create the mount point; the platform mounts the real volume over it).
RUN mkdir -p /data

# Railway/most PaaS inject PORT; the app reads process.env.PORT.
EXPOSE 3000

CMD ["node", "src/index.js"]
