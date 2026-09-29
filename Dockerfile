# Overlap has no dependencies, so the image is just Node and the source.
# node:sqlite needs Node 22.13 or newer; the 22 tag tracks the latest 22.x.
FROM node:22-alpine

WORKDIR /app
COPY package.json ./
COPY server ./server
COPY public ./public

# The database lives on a volume at /data. Creating it here, owned by the unprivileged
# node user, means a fresh named volume starts out writable by that user.
RUN mkdir /data && chown node:node /data
USER node

ENV HOST=0.0.0.0 \
    PORT=8080 \
    DB_PATH=/data/overlap.db \
    NODE_ENV=production

VOLUME /data

# Run node directly rather than through npm so it receives SIGTERM from `docker stop`
# and closes the database cleanly.
CMD ["node", "--disable-warning=ExperimentalWarning", "server/index.js"]
