FROM node:22-alpine AS web-builder
WORKDIR /app
COPY web/package.json ./package.json
COPY web/package-lock.json ./package-lock.json
RUN npm ci
COPY web .
RUN npm run build

FROM rust:1.88 AS builder
WORKDIR /app
COPY backend/Cargo.toml ./Cargo.toml
COPY backend/src ./src
COPY backend/migrations ./migrations
RUN cargo build --release

FROM debian:bookworm-slim
WORKDIR /app
RUN apt-get update && apt-get install -y ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=builder /app/target/release/core-api /usr/local/bin/core-api
COPY --from=builder /app/migrations ./migrations
COPY --from=web-builder /app/dist ./web-dist
ENV WEB_STATIC_DIR=/app/web-dist
EXPOSE 8080
CMD ["core-api"]
