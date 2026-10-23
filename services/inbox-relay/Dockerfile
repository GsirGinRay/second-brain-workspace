# Build from the repository root:
#   docker build -f services/inbox-relay/Dockerfile .

FROM node:22-bookworm-slim AS web
WORKDIR /src
COPY package.json package-lock.json ./
COPY packages/brain-core ./packages/brain-core
COPY packages/brain-ui/package.json ./packages/brain-ui/package.json
COPY apps/desktop/package.json ./apps/desktop/package.json
COPY apps/mobile-capture ./apps/mobile-capture
COPY docs/fixtures ./docs/fixtures
RUN npm ci --workspace @second-brain/mobile-capture --include-workspace-root=false --ignore-scripts --no-audit --no-fund \
    && npm --workspace @second-brain/mobile-capture run build

FROM rust:1.93-slim-bookworm AS relay
WORKDIR /src
COPY services/inbox-relay/Cargo.toml services/inbox-relay/Cargo.lock ./
COPY services/inbox-relay/src ./src
RUN cargo build --release --locked

FROM debian:bookworm-slim
RUN useradd --system --uid 10001 --home-dir /data relay \
    && mkdir -p /data && chown relay /data
COPY --from=relay /src/target/release/inbox-relay /usr/local/bin/inbox-relay
COPY --from=web /src/apps/mobile-capture/dist /srv/web
USER relay
ENV INBOX_RELAY_ADDR=0.0.0.0:8114 \
    INBOX_RELAY_DB=/data/inbox-relay.sqlite \
    INBOX_RELAY_STATIC=/srv/web
VOLUME /data
EXPOSE 8114
CMD ["inbox-relay"]
