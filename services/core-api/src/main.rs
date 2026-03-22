mod authz;
mod git_utils;
mod object_storage;
mod realtime;
mod server;
mod typst_cache;
mod types;

#[tokio::main]
async fn main() {
    server::run().await;
}
