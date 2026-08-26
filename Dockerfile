FROM node:22-bookworm-slim AS build

WORKDIR /app

COPY package.json ./
COPY package-lock.json ./
COPY tsconfig.json ./
COPY apps/api/package.json apps/api/package.json

# npm ci, not npm install, and the difference is the point of this file.
#
# `npm install` resolves the ranges in package.json every time it runs, so two
# builds of the SAME commit could install different versions - and every
# redeploy rebuilt the image. Nothing recorded what a given release actually
# contained.
#
# `npm ci` installs exactly what package-lock.json names, and fails loudly if
# the lock and the manifests disagree. That failure is the feature: a mismatch
# stops the build here rather than shipping a quietly different image.
RUN npm ci

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
