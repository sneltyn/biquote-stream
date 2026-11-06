FROM node:22-alpine AS base
WORKDIR /app
ENV YARN_ENABLE_GLOBAL_CACHE=false
# Corepack ships with this Node image and reads `packageManager` from
# package.json, so the exact Yarn is pinned without the 2.7 MB runtime living in
# git. The prompt must be silenced or the download blocks a non-interactive build.
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable

FROM base AS deps
COPY package.json yarn.lock .yarnrc.yml ./
RUN yarn install --immutable

FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/.yarnrc.yml ./.yarnrc.yml
COPY . .
RUN yarn build

FROM base AS runner
ENV NODE_ENV=production
COPY --from=builder /app/dist ./dist
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./

CMD ["node", "./dist/server.js"]
