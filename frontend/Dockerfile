# ==============================
# Stage 1 - Build
# ==============================
FROM public.ecr.aws/docker/library/node:22-alpine AS builder

WORKDIR /app

# Copy package files
COPY package.json package-lock.json ./

# Install all dependencies for build
RUN npm ci

# Copy application source
COPY . .

# Build-time frontend API URL
ARG VITE_API_BASE_URL
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL

# Build Vite / React 19 application
RUN npm run build

# ==============================
# Stage 2 - Production Runtime
# ==============================
FROM public.ecr.aws/docker/library/node:22-alpine

WORKDIR /app

# Install production dependencies for runtime server (mysql2)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy built static distribution from builder and server script
COPY --from=builder /app/dist ./dist
COPY server.mjs ./

# Security: Run as non-privileged system user
USER node

# Frontend & Database API gateway listens on 8080
EXPOSE 8080

# Start production server
CMD ["node", "server.mjs"]
