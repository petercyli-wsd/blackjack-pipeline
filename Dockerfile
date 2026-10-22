FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
# Use the OS video binaries; do not download an architecture-specific binary at build time.
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY server.js ./
COPY src ./src
COPY public ./public
ENV NODE_ENV=production PORT=10000 DATA_DIR=/tmp/dealer-transition-studio FFMPEG_PATH=/usr/bin/ffmpeg FFPROBE_PATH=/usr/bin/ffprobe
USER node
EXPOSE 10000
CMD ["node", "server.js"]
