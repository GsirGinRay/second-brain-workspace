use axum::http::HeaderName;
use inbox_relay::limits::Limits;
use inbox_relay::store::Store;
use inbox_relay::{AppState, router, system_clock};
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

const PURGE_INTERVAL: Duration = Duration::from_secs(600);

/// Configuration comes from the environment:
/// - `INBOX_RELAY_ADDR` (default `127.0.0.1:8114`)
/// - `INBOX_RELAY_DB` (default `data/inbox-relay.sqlite`)
/// - `INBOX_RELAY_CLIENT_IP_HEADER`, only behind a proxy that sets it
#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let addr: SocketAddr = std::env::var("INBOX_RELAY_ADDR")
        .unwrap_or_else(|_| "127.0.0.1:8114".to_owned())
        .parse()?;
    let db = PathBuf::from(
        std::env::var("INBOX_RELAY_DB").unwrap_or_else(|_| "data/inbox-relay.sqlite".to_owned()),
    );
    if let Some(parent) = db.parent().filter(|parent| !parent.as_os_str().is_empty()) {
        std::fs::create_dir_all(parent)?;
    }
    let client_ip_header = match std::env::var("INBOX_RELAY_CLIENT_IP_HEADER") {
        Ok(name) if !name.trim().is_empty() => Some(HeaderName::try_from(name.trim())?),
        _ => None,
    };

    let state = Arc::new(AppState::new(
        Store::open(&db)?,
        Limits::default(),
        system_clock(),
        client_ip_header,
    ));
    let purging = Arc::clone(&state);
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(PURGE_INTERVAL);
        loop {
            interval.tick().await;
            if let Err(error) = purging.purge() {
                eprintln!("purge failed: {error}");
            }
        }
    });

    let listener = tokio::net::TcpListener::bind(addr).await?;
    println!("inbox-relay listening on {addr}");
    axum::serve(
        listener,
        router(state).into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown_signal())
    .await?;
    Ok(())
}

async fn shutdown_signal() {
    let interrupt = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let terminate = async {
        if let Ok(mut signal) =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        {
            signal.recv().await;
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! {
        () = interrupt => {}
        () = terminate => {}
    }
}
