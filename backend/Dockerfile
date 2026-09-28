# ==============================
# Stage 1 - Build
# ==============================
# P1-4: pin minor (was floating 22-alpine); digest pin is a follow-up.
FROM public.ecr.aws/docker/library/node:22.12-alpine AS builder

WORKDIR /app

# Install dependencies
COPY package.json package-lock.json ./
RUN npm ci --workspaces=false

# Copy application source (src, prompts, skills, evals, tsconfig)
COPY . .

# Build TypeScript application (emits dist/ mirroring src/)
RUN npm run build


# ==============================
# Stage 2 - Production
# ==============================
FROM public.ecr.aws/docker/library/node:22.12-alpine

WORKDIR /app

ENV NODE_ENV=production

# Install production dependencies
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --workspaces=false && npm cache clean --force

# Copy compiled application plus runtime prompt/skill packs.
# NOTE: src/prompting/template-loader.ts and src/skills/skill-loader.ts resolve
# <root>/prompts and <root>/skills relative to the compiled files,
# so both directories must ship alongside dist/ (config/ is legacy
# and no longer used).
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prompts ./prompts
COPY --from=builder /app/skills ./skills

# Security: Set ownership and run as non-privileged system user
RUN chown -R node:node /app
USER node

# Backend application port
EXPOSE 3000

# P1-1: container health + graceful-stop signal (K8s still governs the grace period).
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://localhost:3000/health > /dev/null 2>&1 || exit 1

# Start backend
CMD ["node", "dist/index.js"]
