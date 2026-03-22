FROM rust:1.88 AS builder
WORKDIR /app
COPY services/core-api/Cargo.toml ./Cargo.toml
COPY services/core-api/src ./src
COPY services/core-api/migrations ./migrations
RUN cargo build --release

FROM debian:bookworm-slim
WORKDIR /app
RUN apt-get update && apt-get install -y ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=builder /app/target/release/core-api /usr/local/bin/core-api
COPY --from=builder /app/migrations ./migrations
EXPOSE 8080
CMD ["core-api"]

