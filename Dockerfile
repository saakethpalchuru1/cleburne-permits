# Use Microsoft's official Playwright image — Chromium and all OS deps preinstalled.
FROM mcr.microsoft.com/playwright:v1.49.0-jammy

WORKDIR /app

# Install Node deps. We pin playwright to match the base image above.
COPY package*.json ./
RUN npm install --omit=dev

# Copy the fetcher script. We don't need anything else from the repo at runtime.
COPY scripts ./scripts

# Render's Cron Job runs this on each scheduled trigger.
CMD ["node", "scripts/fetch-permits.js"]
