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
COPY docker ./docker
COPY logger.js metrics.js ./

# Root-owned and read-only to the app user, like every other COPY here. Do not add --chown: nothing
# writes into the image's config/ at runtime, and neither documented way of running the
# specialization build needs to either -- the operator's form bind-mounts the host checkout's
# config/ over this directory (host ownership then applies), and the rehearsal writes to /tmp via
# --out. See docs/examples/specializations/README.md. config/enums.js and config/validate.js are
# require()d on every request path, so leaving them unwritable by the uid the CSE runs as is what
# stops an arbitrary-write bug from becoming code that survives a restart.
COPY config ./config

# The specialization registry build. It is here so that a Docker deployment can add a
# <flexContainer> specialization without a Node toolchain on the host -- which is also why
# fast-xml-parser is a runtime dependency rather than a dev one. Named files rather than
# `COPY scripts ./scripts`: probe-capabilities.js and reset-test-db.js are development tools.
COPY scripts/build-specializations.js ./scripts/
COPY scripts/lib/xsd-specialization.js ./scripts/lib/

# Emptying a test deployment's resources. Here for the same reason as the build above -- doing it
# by hand means a database client and knowing which tables are the CSE's and which belong to
# PostGIS. It refuses while anything is connected, so it cannot be pointed at a running deployment.
COPY scripts/reset-resources.js ./scripts/

# The XSD that the shipped config/specializations.manifest.json resolves to. .dockerignore excludes
# docs/ wholesale and re-admits this one file, so that the manifest as shipped builds inside the
# image rather than failing on a path that is not there.
COPY docs/examples/specializations/parkingBlock.xsd ./docs/examples/specializations/

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
