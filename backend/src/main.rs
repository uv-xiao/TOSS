mod git_utils;
mod object_storage;
mod realtime;
mod server;
mod services;
mod types;
mod typst_cache;

#[tokio::main]
async fn main() {
    server::run().await;
}
