# Use Node.js LTS version
FROM node:18-alpine

# Set timezone to Sydney
ENV TZ=Australia/Sydney
RUN apk add --no-cache tzdata

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy application files
COPY . .

# Create data directory
RUN mkdir -p /data

# Expose port (default 3000, but configurable via env)
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/api/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"

# Start the server as root (needed for volume mount permissions)
CMD ["node", "server.js"]
