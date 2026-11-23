# Build stage
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# Runtime: only Chromium's headless shell and its system libraries (the official Playwright image
# ships all three browsers and is ~3.5 GB). The browser version always matches the installed
# `playwright` package, because it is installed by that package.
FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production \
    PW_HEADLESS=true \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
RUN npx playwright install --with-deps --only-shell chromium \
    && rm -rf /var/lib/apt/lists/* /root/.npm
USER node
ENTRYPOINT ["node", "dist/index.js"]
