# The ConDex backend: one Node 24 process (API, MCP server file, background evaluation sweep) with its data in a file.
# Mount a persistent volume and point CONDEX_DB_PATH at it, or everything is lost on each deploy.
FROM node:24-slim

WORKDIR /app
ENV NODE_ENV=production

# Dependencies first, so a code-only change reuses this layer.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY public ./public
COPY demo ./demo

# Hosts such as Railway and Render set PORT. The server listens on all interfaces when CONDEX_DEV_MODE=false.
EXPOSE 8787
CMD ["npm", "start"]
