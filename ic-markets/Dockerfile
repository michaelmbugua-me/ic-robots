FROM node:20-slim

WORKDIR /app

# Copy package files and install
COPY package.json pnpm-lock.yaml ./
RUN npm install -g pnpm && pnpm install --frozen-lockfile

# Copy all source files (including .proto files)
COPY . .

# The bot writes state files — use /app as writable dir
ENV NODE_ENV=production

# Default: monitor mode. Override with --auto-execute via Cloud Run env/args.
CMD ["node", "index.js"]

