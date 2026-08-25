FROM node:22-bookworm-slim AS build

WORKDIR /app

COPY package.json ./
COPY tsconfig.json ./
COPY apps/api/package.json apps/api/package.json

RUN npm install

COPY apps/api apps/api

RUN npm run build

FROM node:22-bookworm-slim

WORKDIR /app

ENV NODE_ENV=stage
ENV PORT=3000

COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

EXPOSE 3000

CMD ["npm", "run", "start"]
