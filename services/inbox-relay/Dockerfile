FROM rust:1.93-slim-bookworm AS build
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY src ./src
RUN cargo build --release --locked

FROM debian:bookworm-slim
RUN useradd --system --uid 10001 --home-dir /data relay \
    && mkdir -p /data && chown relay /data
COPY --from=build /src/target/release/inbox-relay /usr/local/bin/inbox-relay
USER relay
ENV INBOX_RELAY_ADDR=0.0.0.0:8114 \
    INBOX_RELAY_DB=/data/inbox-relay.sqlite
VOLUME /data
EXPOSE 8114
CMD ["inbox-relay"]
