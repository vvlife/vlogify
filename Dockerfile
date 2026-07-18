FROM node:20-slim

# Install ffmpeg + python3 + pip (for edge-tts)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    python3 \
    python3-pip \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Install edge-tts
RUN pip3 install --break-system-packages edge-tts

# App directory
WORKDIR /app

# Copy package files and install
COPY package*.json ./
RUN npm ci --production

# Copy app source
COPY server.js ./
COPY public/ ./public/

# Create dirs
RUN mkdir -p uploads temp outputs

# Expose port
ENV PORT=3456
EXPOSE 3456

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:${PORT:-3456}/api/health || exit 1

# Start
CMD ["node", "server.js"]
