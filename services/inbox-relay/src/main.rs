use axum::http::HeaderName;
use inbox_relay::limits::Limits;
use inbox_relay::line::{Line, LineMessaging};
use inbox_relay::membership::{
    Directory, Mailer, NoDirectory, NoMailer, ResendMailer, SheetDirectory, normalize_email,
};
use inbox_relay::store::Store;
use inbox_relay::{AppState, router, router_with_static, system_clock};
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

const PURGE_INTERVAL: Duration = Duration::from_secs(600);
const RECHECK_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);
const DEFAULT_MEMBER_TAB: &str = "Members(自動化)";

fn env(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

fn db_path() -> PathBuf {
    PathBuf::from(env("INBOX_RELAY_DB").unwrap_or_else(|| "data/inbox-relay.sqlite".to_owned()))
}

/// `inbox-relay grant <email> [note]`, `ungrant <email>`, `grants`: manual
/// access for people who paid outside Skool. Run inside the container;
/// `check <email>` tests the member Sheet.
fn run_admin(args: &[String]) -> Result<(), Box<dyn std::error::Error>> {
    let store = Store::open(&db_path())?;
    let email = || {
        args.get(1)
            .and_then(|value| normalize_email(value))
            .ok_or("an email address is required")
    };
    match args[0].as_str() {
        "grant" => {
            let note = args.get(2..).map(|rest| rest.join(" ")).unwrap_or_default();
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)?
                .as_secs() as i64;
            store.grant(&email()?, &note, now)?;
            println!("granted");
        }
        "ungrant" => {
            let removed = store.ungrant(&email()?)?;
            println!("{}", if removed { "removed" } else { "not found" });
        }
        "grants" => {
            for (email, note) in store.grants()? {
                println!("{email}\t{note}");
            }
        }
        other => return Err(format!("unknown command {other}").into()),
    }
    Ok(())
}

/// Members come from the Skool-synced Google Sheet; codes are sent with Resend.
/// Without these variables nobody can unlock the "today" list (manual grants
/// still need a code, so the mailer is required either way).
type Membership = (Arc<dyn Directory>, Arc<dyn Mailer>);

fn membership() -> Result<Membership, Box<dyn std::error::Error>> {
    let directory: Arc<dyn Directory> = match (
        env("GOOGLE_SERVICE_ACCOUNT_JSON"),
        env("GOOGLE_SHEETS_MEMBER_SHEET_ID"),
    ) {
        (Some(account), Some(sheet)) => {
            let tab =
                env("INBOX_RELAY_MEMBER_TAB").unwrap_or_else(|| DEFAULT_MEMBER_TAB.to_owned());
            Arc::new(SheetDirectory::new(&account, &sheet, &tab)?)
        }
        _ => Arc::new(NoDirectory),
    };
    let mailer: Arc<dyn Mailer> = match (env("RESEND_API_KEY"), env("EMAIL_FROM")) {
        (Some(key), Some(from)) => Arc::new(ResendMailer::new(&key, &from)?),
        _ => Arc::new(NoMailer),
    };
    Ok((directory, mailer))
}

/// Configuration comes from the environment:
/// - `INBOX_RELAY_ADDR` (default `127.0.0.1:8114`)
/// - `INBOX_RELAY_DB` (default `data/inbox-relay.sqlite`)
/// - `INBOX_RELAY_CLIENT_IP_HEADER`, only behind a proxy that sets it
/// - `INBOX_RELAY_STATIC`, the built phone web app (`apps/mobile-capture/dist`)
/// - `GOOGLE_SERVICE_ACCOUNT_JSON`, `GOOGLE_SHEETS_MEMBER_SHEET_ID`,
///   `INBOX_RELAY_MEMBER_TAB`, `RESEND_API_KEY`, `EMAIL_FROM` for the paid list
/// - `LINE_CHANNEL_SECRET`, `LINE_CHANNEL_ACCESS_TOKEN`, `LINE_BOT_ID` for LINE to inbox
#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) == Some("check") {
        // `inbox-relay check <email>`: reads the member Sheet without sending mail.
        let email = args
            .get(1)
            .and_then(|value| normalize_email(value))
            .ok_or("an email address is required")?;
        let (directory, _) = membership()?;
        match directory.is_member(&email).await {
            Ok(true) => println!("member"),
            Ok(false) => println!("not a member"),
            Err(_) => println!("member directory unavailable"),
        }
        return Ok(());
    }
    if !args.is_empty() {
        return run_admin(&args);
    }
    let addr: SocketAddr = std::env::var("INBOX_RELAY_ADDR")
        .unwrap_or_else(|_| "127.0.0.1:8114".to_owned())
        .parse()?;
    let db = db_path();
    if let Some(parent) = db.parent().filter(|parent| !parent.as_os_str().is_empty()) {
        std::fs::create_dir_all(parent)?;
    }
    let client_ip_header = match std::env::var("INBOX_RELAY_CLIENT_IP_HEADER") {
        Ok(name) if !name.trim().is_empty() => Some(HeaderName::try_from(name.trim())?),
        _ => None,
    };

    let (directory, mailer) = membership()?;
    let mut state = AppState::new(
        Store::open(&db)?,
        Limits::default(),
        system_clock(),
        client_ip_header,
    )
    .with_membership(directory, mailer);
    if let (Some(secret), Some(token), Some(bot_id)) = (
        env("LINE_CHANNEL_SECRET"),
        env("LINE_CHANNEL_ACCESS_TOKEN"),
        env("LINE_BOT_ID"),
    ) {
        state = state.with_line(Line::new(
            &secret,
            &bot_id,
            Arc::new(LineMessaging::new(&token)?),
        ));
        println!("LINE to inbox is on");
    }
    let state = Arc::new(state);
    let rechecking = Arc::clone(&state);
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(RECHECK_INTERVAL);
        loop {
            interval.tick().await;
            match rechecking.recheck_entitlements().await {
                Ok((_, revoked)) if revoked > 0 => println!("entitlements revoked: {revoked}"),
                Ok(_) => {}
                Err(error) => eprintln!("entitlement recheck failed: {error}"),
            }
        }
    });
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

    let app = match std::env::var("INBOX_RELAY_STATIC") {
        Ok(dir) if !dir.trim().is_empty() => {
            router_with_static(state, std::path::Path::new(dir.trim()))
        }
        _ => router(state),
    };
    let listener = tokio::net::TcpListener::bind(addr).await?;
    println!("inbox-relay listening on {addr}");
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
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
