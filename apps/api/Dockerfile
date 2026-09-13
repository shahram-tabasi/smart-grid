FROM node:20-alpine AS base
WORKDIR /workspace

FROM base AS deps
COPY package.json package-lock.json* ./
COPY packages/shared/package.json packages/shared/package.json
COPY apps/api/package.json apps/api/package.json
COPY db/package.json db/package.json
COPY apps/edge-gateway/package.json apps/edge-gateway/package.json
COPY apps/web/package.json apps/web/package.json
RUN npm install --workspaces --if-present --no-audit --no-fund

FROM deps AS build
COPY . .
RUN npm run build --workspace=packages/shared
RUN npm run build --workspace=apps/api

FROM node:20-alpine AS runtime
WORKDIR /workspace
ENV NODE_ENV=production
COPY --from=build /workspace/node_modules ./node_modules
COPY --from=build /workspace/packages/shared ./packages/shared
COPY --from=build /workspace/apps/api ./apps/api
WORKDIR /workspace/apps/api
EXPOSE 4000
CMD ["node", "dist/server.js"]
