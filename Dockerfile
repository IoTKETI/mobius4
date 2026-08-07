# Node 24 to match .nvmrc. CI also covers 22, so either works, but the image should be the
# version the project develops against.
FROM node:24-alpine AS deps

WORKDIR /app

# Only the manifests, so this layer is rebuilt when dependencies change rather than when source
# does. `npm ci` needs both files and installs exactly what package-lock.json pins.
COPY package.json package-lock.json ./

# There are no devDependencies today, but --omit=dev keeps that true if any are added later: the
# test suite and its fixtures have no business in a deployment image.
RUN npm ci --omit=dev && npm cache clean --force


FROM node:24-alpine AS runtime

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY mobius4.js ./
COPY bindings ./bindings
COPY cse ./cse
COPY db ./db
COPY models ./models
COPY config ./config
COPY docker ./docker
COPY logger.js metrics.js ./

# Copying paths one by one rather than `COPY . .` plus .dockerignore. Both work; this way the
# image contains what someone chose to put there, and a new directory in the repository does not
# arrive in the image because nobody thought to exclude it. certs/ and config/local*.json are the
# two that must never be here -- one holds a private key, the other credentials -- and .dockerignore
# excludes them as well, so neither can arrive by way of the build context either.

# The identity volume. Created here so that its ownership is right before the volume is mounted
# over it: Docker copies the ownership of the image's directory onto a fresh named volume, and
# without this the volume would arrive owned by root and the node user could not write the
# identity file into it.
RUN mkdir -p /var/lib/mobius4 && chown node:node /var/lib/mobius4
VOLUME ["/var/lib/mobius4"]

# node:alpine ships an unprivileged `node` user (uid 1000). Nothing here needs root: the ports
# are above 1024 and the only writable path is the volume above.
USER node

ENV NODE_ENV=production

EXPOSE 7599 7580

# No init process. mobius4.js installs its own SIGTERM and SIGINT handlers and closes the
# listeners, the MQTT client and the database pools before exiting, and the entrypoint hands over
# by requiring it rather than spawning it, so those handlers belong to PID 1.
ENTRYPOINT ["node", "docker/entrypoint.js"]
