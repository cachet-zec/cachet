//! HTTP API for Cachet.
//!
//! The router is built against the [`cachet_chain::ChainBackend`] trait so the
//! whole API is testable with the in-memory backend and needs zero changes
//! when the OrchardZSA backend lands (ADR-001).

mod admin;
pub mod client_key;
pub mod dto;
pub mod error;
mod routes;
pub use routes::health;

/// Mount the liveness probe on an already-built router. Kept out of
/// [`router`] so the binary can add it OUTSIDE the rate-limit layer (a
/// bursting client must never starve the monitoring); tests and embedders
/// call this to complete the surface.
pub fn with_health(router: axum::Router) -> axum::Router {
    router.route("/healthz", axum::routing::get(routes::health))
}
pub mod snapshot;

use std::sync::Arc;

use axum::Router;
use cachet_chain::ChainBackend;
use cachet_index::MetadataStore;
use utoipa::OpenApi;
use utoipa_swagger_ui::SwaggerUi;

/// Shared application state: the chain boundary, the (optional) metadata
/// registry store, and the deployment mode.
#[derive(Clone)]
pub struct AppState {
    pub chain: Arc<dyn ChainBackend>,
    pub metadata: Option<Arc<dyn MetadataStore>>,
    /// Public read-only deployments: every mutating endpoint answers 403.
    pub read_only: bool,
    /// Operator key for signed registry snapshots; absent → the snapshot
    /// endpoint answers 503 (CACHET_SNAPSHOT_KEY).
    pub snapshot_key: Option<Arc<ed25519_dalek::SigningKey>>,
    /// Bearer token guarding the operator admin surface. Absent (the
    /// default) → every admin route answers 404, indistinguishable from
    /// not existing (CACHET_ADMIN_TOKEN).
    pub admin_token: Option<Arc<str>>,
    /// Discord webhook notified when a relayed transaction MINTS assets
    /// (public facts only — txid and asset ids, never a client address).
    /// Absent → no notification (CACHET_DISCORD_WEBHOOK).
    pub mint_webhook: Option<Arc<str>>,
    /// Per-client write-path throttles keyed by a salted hash of the
    /// client address (PRIVACY.md P2): memory only, never logged.
    pub client_limits: Arc<client_key::ClientLimits>,
}

/// Minimum length of an accepted `CACHET_ADMIN_TOKEN`: 32 characters,
/// the shortest value that stays out of brute-force range at the API's
/// request budget. `openssl rand -hex 32` produces 64, comfortably over.
pub const MIN_ADMIN_TOKEN_CHARS: usize = 32;

/// Vet a configured admin token. A short one would be brute-forceable
/// within the API's request budget, so it is refused outright rather than
/// quietly accepted: an operator who sets `admin123` gets NO admin
/// surface (and a warning), never a guessable one.
fn accepted_admin_token(configured: Option<String>) -> Option<Arc<str>> {
    let token = configured?.trim().to_owned();
    if token.is_empty() {
        return None;
    }
    if token.chars().count() < MIN_ADMIN_TOKEN_CHARS {
        tracing::warn!(
            min_chars = MIN_ADMIN_TOKEN_CHARS,
            "CACHET_ADMIN_TOKEN is too short — the admin surface stays DISABLED. \
             Generate one with `openssl rand -hex 32`."
        );
        return None;
    }
    Some(Arc::from(token.as_str()))
}

/// Bytes currently held by bundles that nothing references, updated
/// by the garbage-collection pass in the binary. When it exceeds
/// [`routes::ORPHAN_POOL_CAP_BYTES`], uploads answer 429 until the sweep
/// drains — the hard stop that keeps a botnet from outrunning the GC.
pub static ORPHAN_BYTES: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// OpenAPI document for the whole API. The TypeScript client in
/// `packages/api-client` is generated from this — handlers must stay
/// annotated, and DTOs live in [`dto`] so the schema never leaks
/// protocol-internal types.
#[derive(OpenApi)]
#[openapi(
    info(
        title = "Cachet API",
        description = "Issuance console and verifiable registry for Zcash Shielded Assets \
                       (ZSA), running against the public ZSA testnet.\n\n\
                       Everything the registry serves is **derived from the chain** and \
                       independently checkable: metadata hashes participate in the asset id \
                       itself (ZIP 227), so a response can be re-verified client-side. The \
                       public instance at `api.cachetzec.com` is **read-only** — every \
                       mutating `issuance` endpoint answers 403 there; browser mints go \
                       through `POST /api/v1/relay`, which only forwards signed bytes.\n\n\
                       Rate limit: 30 requests/s per client, bursts of 60 - sized for a \
                       real session, a browser wallet paging through the chain included. \
                       Need better limits, or none at all? Run your own instance: the \
                       code is MIT, the limit is one environment variable \
                       (`CACHET_RATE_LIMIT_PER_SEC`, `0` disables it), and the public ZSA \
                       node accepts transactions directly. This deployment is a \
                       convenience, never a chokepoint.\n\n\
                       No cookies, no telemetry, and no authentication \
                       anywhere except the optional operator surface.",
        license(name = "MIT")
    ),
    tags(
        (name = "registry", description = "The public registry, derived from the chain: \
            assets, issuers, per-asset history, and permissionless description resolution \
            (accepted only when it hashes to the on-chain commitment)."),
        (name = "metadata", description = "Content-addressed metadata bundles. A bundle's \
            SHA-256 travels inside the on-chain asset description, so what these endpoints \
            serve can never be silently swapped."),
        (name = "chain", description = "Raw chain access: network info, raw blocks for \
            local wallet scanning (identical bytes for every caller), and the relay that \
            forwards signed transactions without seeing a key."),
        (name = "issuance", description = "Server-wallet issuance for self-hosted \
            deployments. Disabled (403) on public read-only instances — mint from the \
            browser instead."),
        (name = "snapshot", description = "Deterministic registry export, sealed under the \
            operator's Ed25519 key. Any mirror can serve it; any client can verify it \
            (format in packages/registry-spec)."),
        (name = "ops", description = "Liveness, and the optional token-gated \
            operator surface (absent — 404 — unless CACHET_ADMIN_TOKEN is set)."),
    ),
    paths(
        routes::health,
        routes::chain_info,
        routes::raw_transactions,
        routes::registry_snapshot,
        routes::list_assets,
        routes::list_collections,
        routes::issue_asset,
        routes::issue_asset_batch,
        routes::get_asset,
        routes::resolve_description,
        routes::transfer_asset,
        routes::burn_asset,
        routes::relay_transaction,
        routes::upload_metadata,
        routes::get_metadata,
        routes::get_metadata_image,
        routes::wallet_balances,
        routes::asset_events,
        admin::hide,
        admin::unhide,
        admin::list,
    ),
    components(schemas(
        dto::ChainInfoResponse,
        snapshot::SnapshotResponse,
        dto::RawBlocksResponse,
        dto::RawBlockResponse,
        dto::IssueAssetRequest,
        dto::IssueAssetResponse,
        dto::BatchIssueRequest,
        dto::BatchIssueResponse,
        dto::ResolveDescriptionRequest,
        dto::RelayRequest,
        dto::TransferAssetRequest,
        dto::BurnAssetRequest,
        dto::TxResponse,
        dto::AssetSummaryResponse,
        dto::CollectionResponse,
        dto::MetadataUploadRequest,
        dto::MetadataUploadResponse,
        dto::AccountBalancesResponse,
        dto::HoldingResponse,
        dto::AssetEventResponse,
        admin::ModerationRequest,
        admin::ModerationEntryResponse,
        error::ProblemDetails,
    ))
)]
pub struct ApiDoc;

/// Build the application router.
///
/// `/api/docs` serves Swagger UI, `/api/openapi.json` the raw document used
/// for client generation. `metadata` is the registry's bundle store; when
/// absent the metadata endpoints answer 503 and listings stay hex-only.
pub fn router(
    chain: Arc<dyn ChainBackend>,
    metadata: Option<Arc<dyn MetadataStore>>,
    read_only: bool,
    snapshot_key: Option<Arc<ed25519_dalek::SigningKey>>,
) -> Router {
    let state = AppState {
        chain,
        metadata,
        read_only,
        snapshot_key,
        admin_token: accepted_admin_token(std::env::var("CACHET_ADMIN_TOKEN").ok()),
        mint_webhook: std::env::var("CACHET_DISCORD_WEBHOOK")
            .ok()
            .filter(|url| url.starts_with("https://"))
            .map(Arc::from),
        client_limits: Arc::new(client_key::ClientLimits::new(
            client_key::ClientLimits::trust_proxy_from_env(),
        )),
    };
    Router::new()
        .merge(SwaggerUi::new("/api/docs").url("/api/openapi.json", ApiDoc::openapi()))
        .merge(routes::router())
        // Explicit request-body cap (don't lean on axum's implicit default):
        // the largest legitimate body is an image bundle (≤400 KB data URI);
        // 1 MiB leaves headroom and bounds what reaches the tx/JSON parsers.
        .layer(axum::extract::DefaultBodyLimit::max(1024 * 1024))
        .with_state(state)
}

#[cfg(test)]
mod tests {
    use super::{MIN_ADMIN_TOKEN_CHARS, accepted_admin_token};

    #[test]
    fn weak_admin_tokens_disable_the_surface() {
        assert!(accepted_admin_token(None).is_none());
        assert!(accepted_admin_token(Some("   ".into())).is_none());
        assert!(accepted_admin_token(Some("admin123".into())).is_none());
        assert!(accepted_admin_token(Some("x".repeat(MIN_ADMIN_TOKEN_CHARS - 1))).is_none());

        let strong = "x".repeat(MIN_ADMIN_TOKEN_CHARS);
        assert_eq!(
            accepted_admin_token(Some(strong.clone())).as_deref(),
            Some(strong.as_str())
        );
        // Surrounding whitespace from an .env file must not count toward
        // the length, nor survive into the compared value.
        assert_eq!(
            accepted_admin_token(Some(format!("  {strong}  "))).as_deref(),
            Some(strong.as_str())
        );
    }
}
