FROM rust:1.88 AS builder
WORKDIR /app
COPY services/realtime/Cargo.toml ./Cargo.toml
COPY services/realtime/src ./src
RUN cargo build --release

FROM debian:bookworm-slim
WORKDIR /app
RUN apt-get update && apt-get install -y ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=builder /app/target/release/realtime /usr/local/bin/realtime
EXPOSE 8090
CMD ["realtime"]

