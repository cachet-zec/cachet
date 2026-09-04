//! Cachet server binary.

use std::net::SocketAddr;
use std::sync::Arc;

use cachet_chain::ChainBackend;
use cachet_chain::memory::InMemoryChain;
use cachet_chain::zsa::{OrchardZsaBackend, ZsaConfig};
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // Contract export for client generation (`pnpm openapi:export`); must not
    // start the server or log anything else on stdout.
    if std::env::args().any(|arg| arg == "--dump-openapi") {
        use utoipa::OpenApi;
        println!("{}", cachet_api::ApiDoc::openapi().to_pretty_json()?);
        return Ok(());
    }

    // Fresh issuer seed for shared networks (the built-in regtest demo
    // phrase is public knowledge and must never be used there).
    if std::env::args().any(|arg| arg == "--generate-seed") {
        println!("{}", cachet_chain::zsa::generate_seed_phrase());
        return Ok(());
    }

    // Operator key for signed registry snapshots (hex seed for
    // CACHET_SNAPSHOT_KEY). The matching public key is printed so it can
    // be published out of band.
    if std::env::args().any(|arg| arg == "--generate-snapshot-key") {
        use rand::RngCore;
        let mut seed = [0u8; 32];
        rand::rngs::OsRng.fill_bytes(&mut seed);
        let key = ed25519_dalek::SigningKey::from_bytes(&seed);
        println!("CACHET_SNAPSHOT_KEY={}", hex::encode(seed));
        println!(
            "public key: {}",
            hex::encode(key.verifying_key().to_bytes())
        );
        return Ok(());
    }

    // Operator moderation: an availability-only denylist managed at the
    // server, not over HTTP — whoever can reach the database moderates.
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) == Some("moderate") {
        return run_moderation(&args[1..]).await;
    }

    // Default to info-level logs; RUST_LOG overrides. Privacy rule (P-series,
    // docs/PRIVACY.md): no request bodies, no client addresses in logs.
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .init();

    // Backend selection:
    //   CACHET_BACKEND = memory | zsa (default)
    //   CACHET_NETWORK = regtest (default) | zsa-testnet
    // On zsa-testnet a private CACHET_SEED_PHRASE is REQUIRED: the regtest
    // demo phrase is public knowledge, and on a shared chain it would let
    // anyone spend the wallet's notes and squat its asset ids.
    let backend_kind = std::env::var("CACHET_BACKEND").unwrap_or_else(|_| "zsa".to_owned());
    let mut metadata: Option<Arc<dyn cachet_index::MetadataStore>> = None;
    let chain: Arc<dyn ChainBackend> = match backend_kind.as_str() {
        "memory" => {
            metadata = Some(Arc::new(cachet_index::MemoryMetadataStore::new()));
            Arc::new(InMemoryChain::new())
        }
        "zsa" => {
            let network = std::env::var("CACHET_NETWORK").unwrap_or_else(|_| "regtest".to_owned());
            let mut config = match network.as_str() {
                "regtest" => {
                    let mut config = ZsaConfig::regtest("http://127.0.0.1:18232");
                    if let Ok(seed_phrase) = std::env::var("CACHET_SEED_PHRASE") {
                        config.seed_phrase = seed_phrase;
                    }
                    config
                }
                "zsa-testnet" => {
                    let seed_phrase = std::env::var("CACHET_SEED_PHRASE").map_err(|_| {
                        anyhow::anyhow!(
                            "CACHET_SEED_PHRASE is required on zsa-testnet — generate a \
                             private one with `cachet-server --generate-seed`"
                        )
                    })?;
                    let scan_start = std::env::var("CACHET_SCAN_START_HEIGHT")
                        .ok()
                        .map(|value| value.parse::<u64>())
                        .transpose()?
                        .unwrap_or(0);
                    ZsaConfig::zsa_testnet(seed_phrase, scan_start)
                }
                other => anyhow::bail!(
                    "unknown CACHET_NETWORK '{other}' (expected 'regtest' or 'zsa-testnet')"
                ),
            };
            if let Ok(node_url) = std::env::var("CACHET_NODE_URL") {
                config.node_url = node_url;
            }
            tracing::info!(node_url = %config.node_url, network = %config.network_label, "using OrchardZSA backend");
            let mut backend = OrchardZsaBackend::new(config.clone())?;

            // Testnet birthday defaulting: without an explicit start
            // height, begin at the current tip — earlier history cannot
            // contain a fresh issuer's notes. Pin CACHET_SCAN_START_HEIGHT
            // to keep wallet state stable across restarts.
            if network == "zsa-testnet" && config.scan_start_height == 0 {
                let tip = backend.chain_info().await?.tip_height;
                backend.set_scan_start_height(tip);
                tracing::warn!(
                    scan_start_height = tip,
                    "CACHET_SCAN_START_HEIGHT not set; defaulting to the current tip — pin \
                     this value in the environment to keep wallet state across restarts"
                );
            }

            // Registry cache: optional. Default URL matches
            // infra/docker-compose.yml; unreachable database → scan-only
            // mode with a warning, never a startup failure.
            let database_url = std::env::var("CACHET_DATABASE_URL").unwrap_or_else(|_| {
                "postgres://cachet:cachet-dev-only@localhost:5432/cachet".to_owned()
            });
            let mut has_index = false;
            let mut gc_index: Option<Arc<cachet_index::AssetIndex>> = None;
            match cachet_index::AssetIndex::connect(&database_url).await {
                Ok(index) => {
                    tracing::info!("asset index connected (Postgres registry cache)");
                    let index = Arc::new(index);
                    backend = backend.with_index(index.clone());
                    gc_index = Some(index.clone());
                    metadata = Some(index);
                    has_index = true;
                }
                Err(error) => {
                    tracing::warn!(%error, "asset index unavailable; listings will full-scan");
                }
            }
            let backend = Arc::new(backend);

            // Background registry sync: keep the index at the chain tip so
            // no visitor ever pays for a cold catch-up scan. Serialized
            // with request-triggered syncs by the backend's sync lock.
            if has_index {
                let interval_secs: u64 = std::env::var("CACHET_SYNC_INTERVAL_SECS")
                    .ok()
                    .and_then(|value| value.parse().ok())
                    .unwrap_or(30);
                let sync_backend = backend.clone();
                let gc_index = gc_index.clone();
                tokio::spawn(async move {
                    let mut ticker =
                        tokio::time::interval(std::time::Duration::from_secs(interval_secs.max(5)));
                    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
                    loop {
                        ticker.tick().await;
                        if let Err(error) = sync_backend.sync_registry().await {
                            tracing::warn!(%error, "background registry sync failed; will retry");
                        }
                        // Keep the block page cache hot too: the first
                        // pass walks the chain, later passes only fetch
                        // new blocks — first-visitor wallet scans become
                        // as fast as repeat ones.
                        if let Err(error) = sync_backend.warm_block_cache().await {
                            tracing::warn!(%error, "block cache warm-up failed; will retry");
                        }
                        // Chain-anchored bundle GC: the open uploader's
                        // abuse bound. Referenced = every envelope hash
                        // in the description journal (which the sync just
                        // refreshed, and which survives chain resets);
                        // everything else is swept after a 30-minute
                        // grace. The orphan gauge feeds the upload cap.
                        if let Some(gc) = &gc_index {
                            gc_pass(gc).await;
                        }
                    }
                });
                tracing::info!(interval_secs, "background registry sync enabled");
            }
            backend
        }
        other => anyhow::bail!("unknown CACHET_BACKEND '{other}' (expected 'zsa' or 'memory')"),
    };

    let port: u16 = std::env::var("PORT")
        .ok()
        .map(|value| value.parse())
        .transpose()?
        .unwrap_or(8080);
    // Bind loopback by default: a writable instance exposes wallet-signing
    // endpoints with no authentication, so it must NOT reach the network
    // unless the operator opts in. CACHET_BIND=0.0.0.0 (set by the prod
    // compose, where the container network is isolated behind Caddy) or any
    // explicit address enables external listening.
    let bind_ip: std::net::IpAddr = std::env::var("CACHET_BIND")
        .ok()
        .map(|value| value.parse())
        .transpose()
        .map_err(|_| anyhow::anyhow!("CACHET_BIND must be an IP address, e.g. 0.0.0.0"))?
        .unwrap_or_else(|| std::net::Ipv4Addr::LOCALHOST.into());
    let addr = SocketAddr::new(bind_ip, port);
    let read_only = matches!(
        std::env::var("CACHET_READ_ONLY").as_deref(),
        Ok("1") | Ok("true")
    );
    if !bind_ip.is_loopback() && !read_only {
        tracing::warn!(
            %addr,
            "binding a WRITABLE instance to a non-loopback address: wallet mint/transfer/burn \
             endpoints are unauthenticated — put an authenticating proxy in front or set \
             CACHET_READ_ONLY=1"
        );
    }

    // The console runs on its own origin in development; allow it
    // explicitly (never a wildcard — PRIVACY.md P5 keeps origins known).
    let cors_origin =
        std::env::var("CACHET_CORS_ORIGIN").unwrap_or_else(|_| "http://localhost:3000".to_owned());
    let cors = tower_http::cors::CorsLayer::new()
        .allow_origin(cors_origin.parse::<axum::http::HeaderValue>()?)
        // PUT, DELETE and Authorization exist for the token-gated admin surface
        // (404 unless configured); the origin stays exact, never a wildcard.
        .allow_methods([
            axum::http::Method::GET,
            axum::http::Method::POST,
            axum::http::Method::PUT,
            axum::http::Method::DELETE,
        ])
        .allow_headers([
            axum::http::header::CONTENT_TYPE,
            axum::http::header::AUTHORIZATION,
        ]);

    // Public read-only deployments: mutations disabled, browsing intact.
    // (read_only was resolved above, where the bind address is chosen.)
    if read_only {
        tracing::info!("read-only mode: minting, transfers and burns are disabled");
    } else {
        // Signing instances prove: warm the (process-cached) Orchard
        // proving key off the request path so the first mint is fast.
        std::thread::spawn(|| {
            let started = std::time::Instant::now();
            cachet_chain::prepare_proving();
            tracing::info!(elapsed = ?started.elapsed(), "orchard proving key ready");
        });
    }

    // The API serves user-uploaded bundles and images: never let browsers
    // sniff a response into a different content type.
    let nosniff = tower_http::set_header::SetResponseHeaderLayer::overriding(
        axum::http::header::X_CONTENT_TYPE_OPTIONS,
        axum::http::HeaderValue::from_static("nosniff"),
    );

    // The console is cross-origin isolated (COEP: require-corp) for the
    // threaded mint engine; without this header its documents could no
    // longer embed API-served resources such as bundle images.
    let corp = tower_http::set_header::SetResponseHeaderLayer::overriding(
        axum::http::header::HeaderName::from_static("cross-origin-resource-policy"),
        axum::http::HeaderValue::from_static("cross-origin"),
    );

    // Signed registry snapshots: enabled when the operator provides a key.
    let snapshot_key = match std::env::var("CACHET_SNAPSHOT_KEY") {
        Ok(hex_seed) => Some(Arc::new(
            cachet_api::snapshot::signing_key_from_hex(&hex_seed)
                .map_err(|reason| anyhow::anyhow!("CACHET_SNAPSHOT_KEY: {reason}"))?,
        )),
        Err(_) => None,
    };

    // Layer order matters: CORS is applied LAST below (outermost), so the
    // rate limiter's 429s still carry CORS headers and preflight OPTIONS
    // are answered by the CORS layer without consuming rate-limit budget.
    // Before this ordering, an exhausted burst turned preflights into
    // header-less 429s, which browsers surface as an opaque network
    // failure ("Failed to fetch") instead of a readable 429.
    // The operator's pause decision outlives the process: read it back
    // before serving, so a redeploy never silently reopens a paused relay.
    let mut options = cachet_api::RouterOptions::from_env(chain, metadata, read_only, snapshot_key);
    if let Some(store) = &options.metadata {
        let pause = cachet_api::pause_state_at_boot(store.as_ref()).await;
        if pause.paused {
            tracing::warn!(reason = ?pause.reason, "minting is paused by the operator (persisted)");
        }
        options.mints_paused = pause.paused;
    }
    let mut app = cachet_api::router_with(options).layer(nosniff).layer(corp);

    // Per-client rate limit (public deployments). Keys are client IPs
    // (X-Forwarded-For from the reverse proxy, else the peer address)
    // held in memory only and never logged — PRIVACY.md still holds.
    // CACHET_RATE_LIMIT_PER_SEC=0 disables; default 30 req/s, burst 60.
    // Sized for a real session, not against it: the browser wallet's
    // local scanning legitimately pages through the chain, and the only
    // expensive write (the relay) is serialized by its own lock anyway.
    let per_second: u64 = std::env::var("CACHET_RATE_LIMIT_PER_SEC")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(30);
    // checked_div is None exactly when per_second == 0 — the documented
    // "disabled" setting.
    // Only trust client-IP headers (X-Forwarded-For / X-Real-IP) when a
    // reverse proxy is declared to sit in front — CACHET_TRUST_PROXY=1, set
    // by the prod compose behind Caddy. Directly exposed, those headers are
    // attacker-controlled, so a spoofed one per request would mint a fresh
    // burst and neuter the limiter; default to the real peer address.
    let trust_proxy = matches!(
        std::env::var("CACHET_TRUST_PROXY").as_deref(),
        Ok("1") | Ok("true")
    );
    if let Some(replenish_millis) = 1000u64.checked_div(per_second) {
        // API-semantics trap: tower_governor's `per_second(n)` sets the
        // REPLENISH PERIOD to n seconds (one request per n seconds), not n
        // requests per second. `per_millisecond` with the inverted rate
        // expresses the intended requests-per-second budget. The key
        // extractor's type differs between the two branches, so the layer
        // is applied inside each (axum's Router::layer returns Router, so
        // `app` stays one type regardless).
        macro_rules! rate_limit_with {
            ($extractor:expr) => {{
                let governor_config = std::sync::Arc::new(
                    tower_governor::governor::GovernorConfigBuilder::default()
                        .key_extractor($extractor)
                        .per_millisecond(replenish_millis.max(1))
                        .burst_size(60)
                        .finish()
                        .expect("static governor parameters are valid"),
                );
                // The limiter's key map grows with distinct clients; prune it.
                let limiter = governor_config.limiter().clone();
                tokio::spawn(async move {
                    let mut ticker = tokio::time::interval(std::time::Duration::from_secs(60));
                    loop {
                        ticker.tick().await;
                        limiter.retain_recent();
                    }
                });
                app = app.layer(tower_governor::GovernorLayer::new(governor_config));
            }};
        }
        if trust_proxy {
            rate_limit_with!(tower_governor::key_extractor::SmartIpKeyExtractor);
        } else {
            rate_limit_with!(tower_governor::key_extractor::PeerIpKeyExtractor);
        }
        tracing::info!(
            per_second,
            burst = 60,
            trust_proxy,
            "per-client rate limit enabled"
        );
    }
    // Mounted AFTER the governor layer, so the liveness probe never shares
    // a rate-limit bucket with clients: a burst can 429 an IP, it must not
    // make the monitoring believe the process is down.
    let app = cachet_api::with_health(app);
    let app = app.layer(cors);

    let listener = tokio::net::TcpListener::bind(addr).await?;
    tracing::info!(%addr, "cachet-server listening (docs at /api/docs)");

    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown_signal())
    .await?;
    Ok(())
}

/// One garbage-collection pass over the bundle store: sweep uploads that
/// no journaled description references after a 30-minute grace window,
/// and publish the remaining orphan byte total for the upload cap.
async fn gc_pass(index: &cachet_index::AssetIndex) {
    const GRACE_SECS: i64 = 30 * 60;
    let texts = match index.all_description_texts().await {
        Ok(texts) => texts,
        Err(error) => {
            tracing::warn!(%error, "bundle GC: could not read the description journal");
            return;
        }
    };
    let referenced: Vec<[u8; 32]> = texts
        .iter()
        .filter_map(|text| cachet_domain::ChainDescription::parse(text))
        .filter_map(|envelope| {
            let mut hash = [0u8; 32];
            hex::decode_to_slice(&envelope.sha256, &mut hash)
                .ok()
                .map(|_| hash)
        })
        .collect();
    // An empty reference set means "delete every bundle": in SQL,
    // `NOT (sha256 = ANY('{}'))` is TRUE for every row. That is right for
    // a genuinely empty registry and catastrophic for a journal that is
    // merely missing — a restored dump, a truncated table, a migration in
    // flight. Bundle bytes are the one thing the chain cannot regenerate
    // (it commits to their hash, never their content), so the sweep is
    // skipped rather than trusted. A stalled sweep is recoverable; a
    // wrongly emptied store is not.
    if referenced.is_empty() {
        tracing::warn!(
            "bundle GC: no journaled description references any bundle — skipping the sweep \
             (refusing to treat an empty journal as 'everything is garbage')"
        );
        return;
    }
    match index
        .purge_unreferenced_bundles(&referenced, GRACE_SECS)
        .await
    {
        Ok((deleted, orphan_bytes)) => {
            cachet_api::ORPHAN_BYTES.store(orphan_bytes, std::sync::atomic::Ordering::Relaxed);
            if deleted > 0 {
                tracing::info!(
                    deleted,
                    orphan_bytes,
                    "bundle GC swept unreferenced uploads"
                );
            }
        }
        Err(error) => tracing::warn!(%error, "bundle GC sweep failed; will retry"),
    }
}

async fn shutdown_signal() {
    tokio::signal::ctrl_c()
        .await
        .expect("failed to install Ctrl+C handler");
    tracing::info!("shutdown signal received");
}

/// The operator denylist CLI. Hiding stops THIS registry from distributing
/// a bundle or a description; the chain commitment is untouched and any
/// other registry can keep serving the identical, self-verifying content.
/// Entries carry a reason and timestamp, and are reversible.
async fn run_moderation(args: &[String]) -> anyhow::Result<()> {
    const USAGE: &str = "usage: cachet-server moderate <command>\n\
         \n\
         commands:\n\
           list                                  show every hidden entry\n\
           hide-bundle <sha256> [reason…]        stop serving a metadata bundle\n\
           unhide-bundle <sha256>                serve it again\n\
           hide-description <asset_id> [reason…] stop showing an asset's description text\n\
           unhide-description <asset_id>         show it again\n\
           hide-issuer <issuance_key> [reason]   withhold every asset of an issuer\n\
           unhide-issuer <issuance_key>          list them again";

    let database_url = std::env::var("CACHET_DATABASE_URL")
        .unwrap_or_else(|_| "postgres://cachet:cachet-dev-only@localhost:5432/cachet".to_owned());
    let index = cachet_index::AssetIndex::connect(&database_url).await?;

    // Keys are variable length: 32 bytes for a bundle hash or an asset id,
    // 33 for an issuance validating key.
    let decode_key = |value: Option<&String>, expected: usize| -> anyhow::Result<Vec<u8>> {
        let hex_key = value.ok_or_else(|| anyhow::anyhow!(USAGE))?;
        let key = hex::decode(hex_key.trim()).map_err(|_| anyhow::anyhow!("key must be hex"))?;
        anyhow::ensure!(
            key.len() == expected,
            "key must be {expected} bytes ({} hex characters)",
            expected * 2
        );
        Ok(key)
    };
    let kind_of = |action: &str| {
        if action.ends_with("bundle") {
            cachet_index::ModerationKind::Bundle
        } else if action.ends_with("issuer") {
            cachet_index::ModerationKind::Issuer
        } else {
            cachet_index::ModerationKind::Description
        }
    };
    let key_len = |kind: cachet_index::ModerationKind| {
        if matches!(kind, cachet_index::ModerationKind::Issuer) {
            33
        } else {
            32
        }
    };

    match args.first().map(String::as_str) {
        Some("list") => {
            let entries = index.list_hidden().await?;
            if entries.is_empty() {
                println!("nothing hidden");
            }
            for entry in entries {
                println!(
                    "{}  {:<11}  {}  {}",
                    entry.hidden_at,
                    entry.kind,
                    entry.key,
                    entry.reason.unwrap_or_default()
                );
            }
        }
        Some(action @ ("hide-bundle" | "hide-description" | "hide-issuer")) => {
            let kind = kind_of(action);
            let key = decode_key(args.get(1), key_len(kind))?;
            let reason = (args.len() > 2).then(|| args[2..].join(" "));
            index.hide(kind, &key, reason.as_deref()).await?;
            println!("hidden: {} {}", kind.as_str(), hex::encode(key));
        }
        Some(action @ ("unhide-bundle" | "unhide-description" | "unhide-issuer")) => {
            let key = decode_key(args.get(1), key_len(kind_of(action)))?;
            let existed = index.unhide(kind_of(action), &key).await?;
            println!(
                "{}: {} {}",
                if existed {
                    "unhidden"
                } else {
                    "was not hidden"
                },
                kind_of(action).as_str(),
                hex::encode(key)
            );
        }
        _ => anyhow::bail!(USAGE),
    }
    Ok(())
}
