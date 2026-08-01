FROM node:22-bookworm-slim

# ffmpeg — used by frameCapture.mjs to grab stills from the livestream
# python3 — required by youtube-dl-exec (yt-dlp) to resolve the actual
#           video stream URL from a YouTube link
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    python3 \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .

CMD ["node", "src/index.mjs"]
