//! Route handlers. Thin by design: parse DTO → call the chain boundary →
//! map to DTO. Business rules live in `cachet-domain`, chain logic in
//! `cachet-chain`.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use cachet_domain::AssetId;

use crate::AppState;
use crate::dto::{
    AccountBalancesResponse, AssetEventResponse, AssetSummaryResponse, BatchIssueRequest,
    BatchIssueResponse, BurnAssetRequest, ChainInfoResponse, CollectionResponse, IssueAssetRequest,
    IssueAssetResponse, MetadataUploadRequest, MetadataUploadResponse, RawBlocksResponse,
    RelayRequest, ResolveDescriptionRequest, TransferAssetRequest, TxResponse,
    Zmd1ManifestResponse,
};
use crate::error::ApiError;

pub(crate) fn router() -> Router<AppState> {
    // NOTE: /healthz is deliberately absent — the binary mounts it OUTSIDE
    // the rate-limit layer so a bursting client can never starve the
    // liveness probe (see main.rs).
    Router::new()
        .route("/api/v1/chain", get(chain_info))
        .route("/api/v1/chain/transactions", get(raw_transactions))
        .route("/api/v1/snapshot", get(registry_snapshot))
        .route(
            "/api/v1/assets/{asset_id}/zmd1-manifest",
            get(zmd1_manifest),
        )
        .route("/api/v1/assets", get(list_assets).post(issue_asset))
        .route("/api/v1/assets/batch", post(issue_asset_batch))
        .route("/api/v1/collections", get(list_collections))
        .route("/api/v1/assets/{asset_id}", get(get_asset))
        .route(
            "/api/v1/assets/{asset_id}/description",
            post(resolve_description),
        )
        .route("/api/v1/assets/{asset_id}/events", get(asset_events))
        .route("/api/v1/wallet", get(wallet_balances))
        .route("/api/v1/assets/{asset_id}/transfers", post(transfer_asset))
        .route("/api/v1/assets/{asset_id}/burns", post(burn_asset))
        .route("/api/v1/relay", post(relay_transaction))
        .route("/api/v1/metadata", post(upload_metadata))
        .route("/api/v1/metadata/{sha256}", get(get_metadata))
        .route("/api/v1/metadata/{sha256}/image", get(get_metadata_image))
        // Token-gated operator surface; 404 unless CACHET_ADMIN_TOKEN is set.
        .route(
            "/api/v1/admin/moderation",
            get(crate::admin::list)
                .post(crate::admin::hide)
                .delete(crate::admin::unhide),
        )
}

/// Hard stop for the pending-upload (orphan) pool: bundles nothing
/// references yet may hold at most this many bytes before uploads pause
/// until the garbage collector drains them.
pub const ORPHAN_POOL_CAP_BYTES: u64 = 512 * 1024 * 1024;

/// Instance-wide upload backstop, per minute. This is NOT the storage
/// bound — [`ORPHAN_POOL_CAP_BYTES`] is — it only stops a runaway from
/// racing the sweeper. Sized well above any human pace (a mint costs
/// seconds of zk proving, so even a busy workshop stays far below) and
/// below the per-client request limit, so it can never be the thing a
/// real user hits. Deliberately not keyed by client: behind a reverse
/// proxy every request shares one peer address anyway, and reading
/// forwarded headers here would duplicate the limiter for no gain.
const UPLOADS_PER_MINUTE: u32 = 600;

fn check_upload_budget() -> Result<(), ApiError> {
    use std::time::Instant;
    static WINDOW: std::sync::Mutex<Option<(Instant, u32)>> = std::sync::Mutex::new(None);
    let mut guard = WINDOW
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let now = Instant::now();
    match guard.as_mut() {
        Some((started, count)) if started.elapsed().as_secs() < 60 => {
            if *count >= UPLOADS_PER_MINUTE {
                return Err(ApiError::UploadPoolFull);
            }
            *count += 1;
        }
        _ => {
            *guard = Some((now, 1));
        }
    }
    Ok(())
}

/// Liveness probe. Does not touch the chain: a wedged node must not make the
/// process look dead.
#[utoipa::path(get, path = "/healthz", tag = "ops", responses((status = 200, description = "Process is alive")))]
pub async fn health() -> StatusCode {
    StatusCode::OK
}

/// Identify the connected network and chain tip.
#[utoipa::path(
    get,
    path = "/api/v1/chain",
    tag = "chain",
    responses(
        (status = 200, body = ChainInfoResponse),
        (status = 503, body = crate::error::ProblemDetails, content_type = "application/problem+json"),
    )
)]
pub(crate) async fn chain_info(
    State(state): State<AppState>,
) -> Result<Json<ChainInfoResponse>, ApiError> {
    let info = state.chain.chain_info().await?;
    let snapshot_public_key = state
        .snapshot_key
        .as_ref()
        .map(|key| hex::encode(key.verifying_key().to_bytes()));
    Ok(Json(ChainInfoResponse::from_info(
        info,
        state.read_only,
        snapshot_public_key,
    )))
}

/// Query parameters for the raw-transactions page.
#[derive(Debug, serde::Deserialize, utoipa::IntoParams)]
pub(crate) struct RawTransactionsParams {
    /// First block height of the page (min 1).
    pub start_height: u64,
    /// Blocks per page (1-100, default 25).
    pub limit: Option<u64>,
}

/// Raw transactions of a block range, for client-side note scanning.
///
/// Public chain data, identical for every caller — a browser wallet
/// downloads these pages and trial-decrypts locally, so this instance
/// never learns which notes belong to whom (PRIVACY.md). Open on
/// read-only deployments for the same reason as description resolution:
/// serving public data is not signing.
#[utoipa::path(
    get,
    path = "/api/v1/chain/transactions",
    tag = "chain",
    params(RawTransactionsParams),
    responses(
        (status = 200, body = RawBlocksResponse),
        (status = 503, body = crate::error::ProblemDetails, content_type = "application/problem+json"),
    )
)]
pub(crate) async fn raw_transactions(
    State(state): State<AppState>,
    axum::extract::Query(params): axum::extract::Query<RawTransactionsParams>,
) -> Result<Json<RawBlocksResponse>, ApiError> {
    let raw = state
        .chain
        .raw_transactions(params.start_height, params.limit.unwrap_or(25))
        .await?;
    Ok(Json(RawBlocksResponse::from_chain(raw)))
}

/// Signed registry snapshot: a deterministic export of every asset the
/// registry knows, sealed under the operator's Ed25519 key so mirrors can
/// serve it offline and clients can verify it (see the registry spec for
/// the verification procedure). 503 until the operator configures
/// CACHET_SNAPSHOT_KEY.
#[utoipa::path(
    get,
    path = "/api/v1/snapshot",
    tag = "snapshot",
    responses(
        (status = 200, body = crate::snapshot::SnapshotResponse),
        (status = 503, body = crate::error::ProblemDetails, content_type = "application/problem+json"),
    )
)]
pub(crate) async fn registry_snapshot(
    State(state): State<AppState>,
) -> Result<Json<crate::snapshot::SnapshotResponse>, ApiError> {
    let Some(key) = &state.snapshot_key else {
        return Err(ApiError::NotConfigured {
            reason: "signed snapshots need an operator key (CACHET_SNAPSHOT_KEY)",
        });
    };
    // Sealing walks the whole registry and signs — cheap to request,
    // expensive to serve, and deterministic between registry changes. A
    // short TTL (matching the background sync cadence) bounds both the
    // amplification and the staleness. Tip-keyed caching would be subtly
    // wrong: description resolution changes the payload without moving
    // the tip.
    const SNAPSHOT_TTL: std::time::Duration = std::time::Duration::from_secs(30);
    static CACHE: std::sync::Mutex<
        Option<(std::time::Instant, crate::snapshot::SnapshotResponse)>,
    > = std::sync::Mutex::new(None);
    {
        let guard = CACHE
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some((sealed_at, cached)) = guard.as_ref() {
            if sealed_at.elapsed() < SNAPSHOT_TTL {
                return Ok(Json(cached.clone()));
            }
        }
    }
    let info = state.chain.chain_info().await?;
    let mut assets = state.chain.list_assets().await?;
    // Never seal what this registry withholds: an operator signature over
    // a hidden issuer's assets would contradict the moderation it just
    // applied. (Hidden descriptions are already filtered in SQL.)
    if let Some(store) = &state.metadata {
        let hidden = store.hidden_issuers().await.map_err(metadata_error)?;
        if !hidden.is_empty() {
            let hidden: std::collections::HashSet<String> =
                hidden.into_iter().map(hex::encode).collect();
            assets.retain(|asset| {
                asset
                    .issuer
                    .as_deref()
                    .is_none_or(|issuer| !hidden.contains(issuer))
            });
        }
    }
    // Deterministic payload: same chain state, same bytes, same signature.
    assets.sort_by(|a, b| a.asset_id.as_bytes().cmp(b.asset_id.as_bytes()));
    let payload = crate::snapshot::SnapshotPayload {
        version: 1,
        network: info.network,
        tip_height: info.tip_height,
        assets: assets
            .into_iter()
            .map(|asset| crate::snapshot::SnapshotAsset {
                asset_id: asset.asset_id.to_string(),
                issuer: asset.issuer,
                total_supply: asset.total_supply,
                finalized: asset.finalized,
                description: asset.description,
            })
            .collect(),
    };
    let sealed = crate::snapshot::seal(&payload, key);
    *CACHE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) =
        Some((std::time::Instant::now(), sealed.clone()));
    Ok(Json(sealed))
}

/// Verified ZMD-1 full-form manifest of a foreign asset.
///
/// ZMD-1 (ZecBit's convention) full-form descriptors commit the chain to
/// BLAKE2b-256 of a manifest document. This instance fetches the
/// manifest from its IPFS gateway, verifies the hash, and serves the
/// exact bytes — the same "the registry cannot lie" guarantee as
/// Cachet's own envelope, applied to a neighbour's format. 404 when the
/// asset has no resolved full-form descriptor; 422 when the fetched
/// bytes do not match the on-chain commitment.
#[utoipa::path(
    get,
    path = "/api/v1/assets/{asset_id}/zmd1-manifest",
    tag = "registry",
    params(("asset_id" = String, Path, description = "Asset id, hex-encoded 32 bytes")),
    responses(
        (status = 200, body = Zmd1ManifestResponse),
        (status = 404, body = crate::error::ProblemDetails, content_type = "application/problem+json"),
        (status = 422, body = crate::error::ProblemDetails, content_type = "application/problem+json"),
        (status = 503, body = crate::error::ProblemDetails, content_type = "application/problem+json"),
    )
)]
pub(crate) async fn zmd1_manifest(
    State(state): State<AppState>,
    Path(asset_id): Path<String>,
) -> Result<Json<Zmd1ManifestResponse>, ApiError> {
    let asset_id: AssetId = asset_id.parse().map_err(ApiError::Validation)?;
    let asset = state.chain.asset_state(asset_id).await?;
    let descriptor = asset
        .description
        .as_deref()
        .and_then(cachet_domain::zmd1::Zmd1Descriptor::parse)
        .ok_or(ApiError::NotFound {
            what: "ZMD-1 descriptor",
        })?;
    let (Some(cid), Some(content_hash)) = (&descriptor.manifest_cid, &descriptor.content_hash)
    else {
        return Err(ApiError::NotFound {
            what: "ZMD-1 full-form manifest (this descriptor is minimal-form)",
        });
    };

    let manifest = crate::zmd1_manifest::fetch_verified(&state.ipfs_gateway, cid, content_hash)
        .await
        .map_err(|error| match error {
            crate::zmd1_manifest::ManifestError::Unavailable(reason) => {
                ApiError::Chain(cachet_chain::ChainError::Unavailable { reason })
            }
            other => ApiError::Chain(cachet_chain::ChainError::Rejected {
                reason: other.to_string(),
            }),
        })?;

    Ok(Json(Zmd1ManifestResponse {
        manifest,
        cid: cid.clone(),
        content_hash: content_hash.clone(),
        display_name: descriptor.display_name(),
    }))
}

/// Spendable balances of the wallet's tracked accounts.
///
/// Disabled on read-only deployments: the operator's shielded balances are
/// exactly the kind of information this project exists to keep private,
/// and a public instance must not broadcast them.
#[utoipa::path(
    get,
    path = "/api/v1/wallet",
    tag = "issuance",
    responses(
        (status = 200, body = Vec<AccountBalancesResponse>),
        (status = 403, body = crate::error::ProblemDetails, content_type = "application/problem+json"),
        (status = 503, body = crate::error::ProblemDetails, content_type = "application/problem+json"),
    )
)]
pub(crate) async fn wallet_balances(
    State(state): State<AppState>,
) -> Result<Json<Vec<AccountBalancesResponse>>, ApiError> {
    ensure_writable(&state)?;
    let balances = state.chain.wallet_balances().await?;
    Ok(Json(balances.into_iter().map(Into::into).collect()))
}

/// Public events of an asset's life, oldest first. Transfers are shielded
/// and never listed.
#[utoipa::path(
    get,
    path = "/api/v1/assets/{asset_id}/events",
    tag = "registry",
    params(("asset_id" = String, Path, description = "Asset id, hex-encoded 32 bytes")),
    responses(
        (status = 200, body = Vec<AssetEventResponse>),
        (status = 400, body = crate::error::ProblemDetails, content_type = "application/problem+json"),
        (status = 503, body = crate::error::ProblemDetails, content_type = "application/problem+json"),
    )
)]
pub(crate) async fn asset_events(
    State(state): State<AppState>,
    Path(asset_id): Path<String>,
) -> Result<Json<Vec<AssetEventResponse>>, ApiError> {
    let asset_id: AssetId = asset_id.parse().map_err(ApiError::Validation)?;
    // Withholding has to be consistent: an asset hidden by issuer must not
    // keep serving its history through the side door.
    if let Some(store) = &state.metadata {
        let hidden = store.hidden_issuers().await.map_err(metadata_error)?;
        if !hidden.is_empty() {
            let issuer = state
                .chain
                .asset_state(asset_id)
                .await
                .ok()
                .and_then(|a| a.issuer);
            if let Some(issuer) = issuer {
                if hex::decode(&issuer)
                    .map(|bytes| hidden.iter().any(|key| key == &bytes))
                    .unwrap_or(false)
                {
                    return Err(ApiError::HiddenByOperator);
                }
            }
        }
    }
    let events = state.chain.asset_events(asset_id).await?;
    Ok(Json(events.into_iter().map(Into::into).collect()))
}

/// Refuse mutations on read-only deployments.
fn ensure_writable(state: &AppState) -> Result<(), ApiError> {
    if state.read_only {
        Err(ApiError::ReadOnly)
    } else {
        Ok(())
    }
}

/// Query parameters for the asset listing.
#[derive(Debug, serde::Deserialize, utoipa::IntoParams)]
pub(crate) struct ListAssetsParams {
    /// Keep only the newest N assets. Omitted: the whole registry (what a
    /// client doing its own search or mirroring wants).
    pub limit: Option<usize>,
    /// `true`: keep only assets whose description is known, so their name
    /// is attested rather than an id. Omitted: everything, which stays the
    /// default - this is a caller's view preference, never moderation.
    pub resolved: Option<bool>,
}

/// List every asset observed on the chain, newest first.
///
/// `resolved=true` narrows the listing to assets whose description is
/// known, which is what a client wants when it intends to show names
/// rather than ids. Everything stays reachable without it.
#[utoipa::path(
    get,
    path = "/api/v1/assets",
    tag = "registry",
    params(ListAssetsParams),
    responses(
        (status = 200, body = Vec<AssetSummaryResponse>),
        (status = 503, body = crate::error::ProblemDetails, content_type = "application/problem+json"),
    )
)]
pub(crate) async fn list_assets(
    State(state): State<AppState>,
    axum::extract::Query(params): axum::extract::Query<ListAssetsParams>,
) -> Result<Json<Vec<AssetSummaryResponse>>, ApiError> {
    let assets = state.chain.list_assets().await?;
    let mut responses: Vec<AssetSummaryResponse> = assets.into_iter().map(Into::into).collect();
    // Operator moderation at issuer granularity: a hidden issuance key
    // removes every asset minted under it from listings. Availability
    // only, as always — the chain record is untouched and any other
    // registry can keep serving it.
    if let Some(store) = &state.metadata {
        let hidden = store.hidden_issuers().await.map_err(metadata_error)?;
        if !hidden.is_empty() {
            let hidden: std::collections::HashSet<String> =
                hidden.into_iter().map(hex::encode).collect();
            responses.retain(|response| {
                response
                    .issuer
                    .as_deref()
                    .is_none_or(|issuer| !hidden.contains(issuer))
            });
        }
    }
    // Caller's choice, applied before the limit so `resolved` and
    // `limit` compose: asking for five resolved assets returns five, not
    // whatever is resolved among the five newest.
    if params.resolved == Some(true) {
        responses.retain(|response| response.name_source.is_some());
    }
    // Truncate after moderation (a hidden issuer must not consume a
    // slot) and before enrichment (only enrich what is actually sent).
    if let Some(limit) = params.limit {
        responses.truncate(limit);
    }
    // Bulk image enrichment: one bounded store query for the whole
    // listing instead of two per asset (the endpoint is public and cheap
    // to call; its cost must not scale with registry size).
    if let Some(store) = &state.metadata {
        let hashes: Vec<[u8; 32]> = responses
            .iter()
            .filter_map(|response| {
                response
                    .description
                    .as_deref()
                    .and_then(cachet_domain::ChainDescription::parse)
                    .and_then(|envelope| parse_sha256(&envelope.sha256).ok())
            })
            .collect();
        let visible = store
            .visible_image_hashes(&hashes)
            .await
            .map_err(metadata_error)?;
        for response in &mut responses {
            let Some(envelope) = response
                .description
                .as_deref()
                .and_then(cachet_domain::ChainDescription::parse)
            else {
                continue;
            };
            if let Ok(sha256) = parse_sha256(&envelope.sha256) {
                if visible.contains(&sha256) {
                    response.image_path =
                        Some(format!("/api/v1/metadata/{}/image", envelope.sha256));
                }
            }
        }
    }
    Ok(Json(responses))
}

/// Chain-level collections: every asset minted under one issuance key,
/// grouped — the only provenance statement the chain itself makes.
#[utoipa::path(
    get,
    path = "/api/v1/collections",
    tag = "registry",
    responses(
        (status = 200, body = Vec<CollectionResponse>),
        (status = 503, body = crate::error::ProblemDetails, content_type = "application/problem+json"),
    )
)]
pub(crate) async fn list_collections(
    State(state): State<AppState>,
) -> Result<Json<Vec<CollectionResponse>>, ApiError> {
    let collections = state.chain.collections().await?;
    let mut responses: Vec<CollectionResponse> = collections.into_iter().map(Into::into).collect();
    if let Some(store) = &state.metadata {
        let hidden = store.hidden_issuers().await.map_err(metadata_error)?;
        if !hidden.is_empty() {
            let hidden: std::collections::HashSet<String> =
                hidden.into_iter().map(hex::encode).collect();
            responses.retain(|collection| !hidden.contains(&collection.issuer));
        }
    }
    Ok(Json(responses))
}

/// Registry enrichment: point `image_path` at the stored bundle's image
/// when the description carries a v1 envelope whose bundle we hold and it
/// embeds one (true for anything sealed through this instance, browser
/// mints included, once its description is resolved).
async fn enrich_image_path(
    state: &AppState,
    response: &mut AssetSummaryResponse,
) -> Result<(), ApiError> {
    let Some(store) = &state.metadata else {
        return Ok(());
    };
    let Some(envelope) = response
        .description
        .as_deref()
        .and_then(cachet_domain::ChainDescription::parse)
    else {
        return Ok(());
    };
    let Ok(sha256) = parse_sha256(&envelope.sha256) else {
        return Ok(());
    };
    if store.is_hidden(sha256).await.map_err(metadata_error)? {
        return Ok(()); // operator denylist: don't advertise a hidden bundle
    }
    let has_image = store
        .get(sha256)
        .await
        .map_err(metadata_error)?
        .and_then(|bytes| serde_json::from_slice::<cachet_domain::MetadataBundle>(&bytes).ok())
        .is_some_and(|bundle| bundle.image_data_uri.is_some());
    if has_image {
        response.image_path = Some(format!("/api/v1/metadata/{}/image", envelope.sha256));
    }
    Ok(())
}

/// Relay a fully signed, browser-built issuance transaction to the chain.
///
/// Deliberately open on read-only deployments: read-only means "this
/// instance signs nothing", and a relayed transaction was signed by the
/// sender's own browser-held key. The relay can refuse; it cannot alter.
#[utoipa::path(
    post,
    path = "/api/v1/relay",
    tag = "chain",
    request_body = RelayRequest,
    responses(
        (status = 202, body = TxResponse, description = "Accepted by the chain"),
        (status = 400, body = crate::error::ProblemDetails, content_type = "application/problem+json"),
        (status = 422, body = crate::error::ProblemDetails, content_type = "application/problem+json"),
        (status = 503, body = crate::error::ProblemDetails, content_type = "application/problem+json"),
    )
)]
pub(crate) async fn relay_transaction(
    State(state): State<AppState>,
    Json(body): Json<RelayRequest>,
) -> Result<(StatusCode, Json<TxResponse>), ApiError> {
    let tx_bytes = hex::decode(body.tx_hex.trim()).map_err(|_| {
        ApiError::Validation(cachet_domain::DomainError::InvalidMetadata {
            reason: "tx_hex must be hex-encoded transaction bytes",
        })
    })?;
    let receipt = state.chain.relay(tx_bytes).await?;
    // Operator notification for MINTS relayed through this instance —
    // fire-and-forget, public facts only (asset ids and txid are chain
    // data; no client address is read, let alone sent). Opt-in via
    // CACHET_DISCORD_WEBHOOK; documented in PRIVACY.md P8.
    if let (Some(webhook), false) = (&state.mint_webhook, receipt.issued_assets.is_empty()) {
        let webhook = webhook.clone();
        let txid = receipt.txid.to_string();
        let assets: Vec<String> = receipt
            .issued_assets
            .iter()
            .map(|asset| asset.to_string())
            .collect();
        tokio::spawn(async move {
            let origin = std::env::var("CACHET_CORS_ORIGIN")
                .unwrap_or_else(|_| "http://localhost:3000".to_owned());
            let mut lines = vec![format!(
                "🪙 **Browser mint relayed** — {} asset{}",
                assets.len(),
                if assets.len() > 1 { "s" } else { "" }
            )];
            for asset in assets.iter().take(3) {
                lines.push(format!("{origin}/assets/{asset}"));
            }
            if assets.len() > 3 {
                lines.push(format!("… and {} more", assets.len() - 3));
            }
            lines.push(format!("txid `{txid}`"));
            let payload = serde_json::json!({ "content": lines.join("\n") });
            let sent = reqwest::Client::new()
                .post(webhook.as_ref())
                .json(&payload)
                .timeout(std::time::Duration::from_secs(5))
                .send()
                .await;
            if let Err(error) = sent {
                tracing::warn!(%error, "mint webhook delivery failed");
            }
        });
    }
    let txid = receipt.txid;
    Ok((StatusCode::ACCEPTED, Json(txid.into())))
}

/// Register a metadata bundle and get back the on-chain description that
/// binds it to the asset at issuance.
#[utoipa::path(
    post,
    path = "/api/v1/metadata",
    tag = "metadata",
    request_body = MetadataUploadRequest,
    responses(
        (status = 201, body = MetadataUploadResponse),
        (status = 400, body = crate::error::ProblemDetails, content_type = "application/problem+json"),
        (status = 503, body = crate::error::ProblemDetails, content_type = "application/problem+json"),
    )
)]
pub(crate) async fn upload_metadata(
    State(state): State<AppState>,
    Json(body): Json<MetadataUploadRequest>,
) -> Result<(StatusCode, Json<MetadataUploadResponse>), ApiError> {
    // Open to everyone, read-only deployments included: community mints
    // carry full bundles (name, description, image). The abuse bound is
    // chain-anchored — a bundle that no RESOLVED asset description
    // references is swept after a grace window, so durable storage costs
    // a real zk proof and leaves a public trace — plus two throttles that
    // keep the transient window itself bounded:
    //   1. a global upload budget (nobody legitimately uploads faster
    //      than they can prove mints);
    //   2. a hard cap on the orphan pool, so a botnet cannot outrun the
    //      sweeper and exhaust the disk.
    // Neither throttle records who called (PRIVACY.md P2 holds).
    check_upload_budget()?;
    if crate::ORPHAN_BYTES.load(std::sync::atomic::Ordering::Relaxed) > ORPHAN_POOL_CAP_BYTES {
        return Err(ApiError::UploadPoolFull);
    }
    let store = require_metadata_store(&state)?;
    let bundle = cachet_domain::MetadataBundle::new(
        body.name,
        body.description,
        body.image_data_uri,
        body.external_url,
    )
    .map_err(ApiError::Validation)?;

    let sha256 = store
        .put(bundle.to_canonical_bytes())
        .await
        .map_err(metadata_error)?;
    let sha256_hex = hex::encode(sha256);
    let chain_description = cachet_domain::ChainDescription::compose(&bundle.name, &sha256_hex)
        .map_err(ApiError::Validation)?;

    Ok((
        StatusCode::CREATED,
        Json(MetadataUploadResponse {
            sha256: sha256_hex,
            chain_description,
        }),
    ))
}

/// Fetch a metadata bundle by its content hash. Verifiable: re-hash the
/// body and compare with the path.
#[utoipa::path(
    get,
    path = "/api/v1/metadata/{sha256}",
    tag = "metadata",
    params(("sha256" = String, Path, description = "Bundle hash, hex-encoded 32 bytes")),
    responses(
        (status = 200, description = "The bundle JSON, byte-exact as stored"),
        (status = 404, body = crate::error::ProblemDetails, content_type = "application/problem+json"),
        (status = 503, body = crate::error::ProblemDetails, content_type = "application/problem+json"),
    )
)]
pub(crate) async fn get_metadata(
    State(state): State<AppState>,
    Path(sha256): Path<String>,
) -> Result<axum::response::Response, ApiError> {
    use axum::response::IntoResponse;
    let store = require_metadata_store(&state)?;
    let sha256 = parse_sha256(&sha256)?;
    if store.is_hidden(sha256).await.map_err(metadata_error)? {
        return Err(ApiError::HiddenByOperator);
    }
    let bytes = store
        .get(sha256)
        .await
        .map_err(metadata_error)?
        .ok_or_else(metadata_not_found)?;
    Ok((
        [
            (axum::http::header::CONTENT_TYPE, "application/json"),
            // Content-addressed: safe to cache forever.
            (
                axum::http::header::CACHE_CONTROL,
                "public, max-age=31536000, immutable",
            ),
        ],
        bytes,
    )
        .into_response())
}

/// Serve the image embedded in a metadata bundle (same-origin, so the
/// console never fetches third-party assets — PRIVACY.md P5).
#[utoipa::path(
    get,
    path = "/api/v1/metadata/{sha256}/image",
    tag = "metadata",
    params(("sha256" = String, Path, description = "Bundle hash, hex-encoded 32 bytes")),
    responses(
        (status = 200, description = "The embedded image bytes"),
        (status = 404, body = crate::error::ProblemDetails, content_type = "application/problem+json"),
        (status = 503, body = crate::error::ProblemDetails, content_type = "application/problem+json"),
    )
)]
pub(crate) async fn get_metadata_image(
    State(state): State<AppState>,
    Path(sha256): Path<String>,
) -> Result<axum::response::Response, ApiError> {
    use axum::response::IntoResponse;
    let store = require_metadata_store(&state)?;
    let sha256 = parse_sha256(&sha256)?;
    if store.is_hidden(sha256).await.map_err(metadata_error)? {
        return Err(ApiError::HiddenByOperator);
    }
    let bundle = store
        .get(sha256)
        .await
        .map_err(metadata_error)?
        .and_then(|bytes| serde_json::from_slice::<cachet_domain::MetadataBundle>(&bytes).ok())
        .ok_or_else(metadata_not_found)?;
    let (mime, bytes) = bundle.image_parts().ok_or_else(metadata_not_found)?;
    Ok((
        [
            (axum::http::header::CONTENT_TYPE, mime),
            // Content-addressed: safe to cache forever.
            (
                axum::http::header::CACHE_CONTROL,
                "public, max-age=31536000, immutable",
            ),
        ],
        bytes,
    )
        .into_response())
}

pub(crate) fn require_metadata_store(
    state: &AppState,
) -> Result<&std::sync::Arc<dyn cachet_index::MetadataStore>, ApiError> {
    state
        .metadata
        .as_ref()
        .ok_or(ApiError::Chain(cachet_chain::ChainError::Unavailable {
            reason: "metadata registry requires the database; connect Postgres".to_owned(),
        }))
}

fn parse_sha256(hex_hash: &str) -> Result<[u8; 32], ApiError> {
    let mut sha256 = [0u8; 32];
    hex::decode_to_slice(hex_hash, &mut sha256).map_err(|_| {
        ApiError::Validation(cachet_domain::DomainError::InvalidId {
            kind: "metadata",
            expected: 64,
        })
    })?;
    Ok(sha256)
}

pub(crate) fn metadata_error(error: cachet_index::IndexError) -> ApiError {
    ApiError::Chain(cachet_chain::ChainError::Unavailable {
        reason: format!("metadata store: {error}"),
    })
}

fn metadata_not_found() -> ApiError {
    ApiError::NotFound {
        what: "metadata bundle",
    }
}

/// Issue units of an asset (creates the asset on first issuance).
#[utoipa::path(
    post,
    path = "/api/v1/assets",
    tag = "issuance",
    request_body = IssueAssetRequest,
    responses(
        (status = 202, body = IssueAssetResponse, description = "Accepted into the mempool"),
        (status = 400, body = crate::error::ProblemDetails, content_type = "application/problem+json"),
        (status = 409, body = crate::error::ProblemDetails, content_type = "application/problem+json"),
        (status = 422, body = crate::error::ProblemDetails, content_type = "application/problem+json"),
        (status = 503, body = crate::error::ProblemDetails, content_type = "application/problem+json"),
    )
)]
pub(crate) async fn issue_asset(
    State(state): State<AppState>,
    Json(body): Json<IssueAssetRequest>,
) -> Result<(StatusCode, Json<IssueAssetResponse>), ApiError> {
    ensure_writable(&state)?;
    let request = body.try_into()?;
    let receipt = state.chain.issue(request).await?;
    Ok((StatusCode::ACCEPTED, Json(receipt.into())))
}

/// Mint several assets in ONE transaction (a single ZIP 227 issuance
/// bundle, one action per item, all-or-nothing).
#[utoipa::path(
    post,
    path = "/api/v1/assets/batch",
    tag = "issuance",
    request_body = BatchIssueRequest,
    responses(
        (status = 202, body = BatchIssueResponse, description = "Accepted into the mempool"),
        (status = 400, body = crate::error::ProblemDetails, content_type = "application/problem+json"),
        (status = 409, body = crate::error::ProblemDetails, content_type = "application/problem+json"),
        (status = 422, body = crate::error::ProblemDetails, content_type = "application/problem+json"),
        (status = 503, body = crate::error::ProblemDetails, content_type = "application/problem+json"),
    )
)]
pub(crate) async fn issue_asset_batch(
    State(state): State<AppState>,
    Json(body): Json<BatchIssueRequest>,
) -> Result<(StatusCode, Json<BatchIssueResponse>), ApiError> {
    ensure_writable(&state)?;
    let requests = body.into_requests().map_err(ApiError::Validation)?;
    let receipts = state.chain.issue_batch(requests).await?;
    let txid = receipts
        .first()
        .map(|receipt| receipt.txid.to_string())
        .unwrap_or_default();
    Ok((
        StatusCode::ACCEPTED,
        Json(BatchIssueResponse {
            txid,
            asset_ids: receipts
                .into_iter()
                .map(|receipt| receipt.asset_id.to_string())
                .collect(),
        }),
    ))
}

/// Teach the registry the plaintext description of an on-chain asset.
///
/// Verified, permissionless, and deliberately open on read-only
/// deployments: the chain stores only the description hash (ZIP 227), so a
/// submission either matches the on-chain commitment or is rejected — the
/// registry cannot be lied to. This is how assets issued elsewhere (e.g.
/// ZMD-1 collections) gain names here.
#[utoipa::path(
    post,
    path = "/api/v1/assets/{asset_id}/description",
    tag = "registry",
    params(("asset_id" = String, Path, description = "Asset id, hex-encoded 32 bytes")),
    request_body = ResolveDescriptionRequest,
    responses(
        (status = 200, body = AssetSummaryResponse, description = "Resolved; the enriched record"),
        (status = 400, body = crate::error::ProblemDetails, content_type = "application/problem+json"),
        (status = 404, body = crate::error::ProblemDetails, content_type = "application/problem+json"),
        (status = 422, body = crate::error::ProblemDetails, content_type = "application/problem+json", description = "The description does not hash to the on-chain commitment"),
        (status = 503, body = crate::error::ProblemDetails, content_type = "application/problem+json"),
    )
)]
pub(crate) async fn resolve_description(
    State(state): State<AppState>,
    Path(asset_id): Path<String>,
    Json(body): Json<ResolveDescriptionRequest>,
) -> Result<Json<AssetSummaryResponse>, ApiError> {
    let asset_id: AssetId = asset_id.parse().map_err(ApiError::Validation)?;
    // Domain-validate the description shape (1–512 bytes) before the
    // backend hashes it.
    cachet_domain::AssetDescription::new(body.description.clone()).map_err(ApiError::Validation)?;
    state
        .chain
        .resolve_description(asset_id, &body.description)
        .await?;
    let mut response: AssetSummaryResponse = state.chain.asset_state(asset_id).await?.into();
    enrich_image_path(&state, &mut response).await?;
    Ok(Json(response))
}

/// Transfer units of an asset from the wallet to a recipient.
#[utoipa::path(
    post,
    path = "/api/v1/assets/{asset_id}/transfers",
    tag = "issuance",
    params(("asset_id" = String, Path, description = "Asset id, hex-encoded 32 bytes")),
    request_body = TransferAssetRequest,
    responses(
        (status = 202, body = TxResponse, description = "Accepted by the chain"),
        (status = 400, body = crate::error::ProblemDetails, content_type = "application/problem+json"),
        (status = 404, body = crate::error::ProblemDetails, content_type = "application/problem+json"),
        (status = 422, body = crate::error::ProblemDetails, content_type = "application/problem+json"),
        (status = 503, body = crate::error::ProblemDetails, content_type = "application/problem+json"),
    )
)]
pub(crate) async fn transfer_asset(
    State(state): State<AppState>,
    Path(asset_id): Path<String>,
    Json(body): Json<TransferAssetRequest>,
) -> Result<(StatusCode, Json<TxResponse>), ApiError> {
    ensure_writable(&state)?;
    let asset_id: cachet_domain::AssetId = asset_id.parse().map_err(ApiError::Validation)?;
    let recipient = body.recipient().map_err(ApiError::Validation)?;
    let request = cachet_domain::TransferRequest::new(asset_id, body.amount, recipient)
        .map_err(ApiError::Validation)?;
    let txid = state.chain.transfer(request).await?;
    Ok((StatusCode::ACCEPTED, Json(txid.into())))
}

/// Permanently destroy units of an asset held by the wallet.
#[utoipa::path(
    post,
    path = "/api/v1/assets/{asset_id}/burns",
    tag = "issuance",
    params(("asset_id" = String, Path, description = "Asset id, hex-encoded 32 bytes")),
    request_body = BurnAssetRequest,
    responses(
        (status = 202, body = TxResponse, description = "Accepted by the chain"),
        (status = 400, body = crate::error::ProblemDetails, content_type = "application/problem+json"),
        (status = 404, body = crate::error::ProblemDetails, content_type = "application/problem+json"),
        (status = 422, body = crate::error::ProblemDetails, content_type = "application/problem+json"),
        (status = 503, body = crate::error::ProblemDetails, content_type = "application/problem+json"),
    )
)]
pub(crate) async fn burn_asset(
    State(state): State<AppState>,
    Path(asset_id): Path<String>,
    Json(body): Json<BurnAssetRequest>,
) -> Result<(StatusCode, Json<TxResponse>), ApiError> {
    ensure_writable(&state)?;
    let asset_id: cachet_domain::AssetId = asset_id.parse().map_err(ApiError::Validation)?;
    let request =
        cachet_domain::BurnRequest::new(asset_id, body.amount).map_err(ApiError::Validation)?;
    let txid = state.chain.burn(request).await?;
    Ok((StatusCode::ACCEPTED, Json(txid.into())))
}

/// Read the on-chain state of an asset, with its registry enrichment
/// (journaled description, display name, image) when known.
#[utoipa::path(
    get,
    path = "/api/v1/assets/{asset_id}",
    tag = "registry",
    params(("asset_id" = String, Path, description = "Asset id, hex-encoded 32 bytes")),
    responses(
        (status = 200, body = AssetSummaryResponse),
        (status = 400, body = crate::error::ProblemDetails, content_type = "application/problem+json"),
        (status = 404, body = crate::error::ProblemDetails, content_type = "application/problem+json"),
        (status = 503, body = crate::error::ProblemDetails, content_type = "application/problem+json"),
    )
)]
pub(crate) async fn get_asset(
    State(state): State<AppState>,
    Path(asset_id): Path<String>,
) -> Result<Json<AssetSummaryResponse>, ApiError> {
    let asset_id: AssetId = asset_id.parse().map_err(ApiError::Validation)?;
    let mut response: AssetSummaryResponse = state.chain.asset_state(asset_id).await?.into();
    // Issuer-level moderation: assets of a hidden issuance key answer 410.
    if let (Some(store), Some(issuer)) = (&state.metadata, response.issuer.as_deref()) {
        if let Ok(issuer_bytes) = hex::decode(issuer) {
            let hidden = store.hidden_issuers().await.map_err(metadata_error)?;
            if hidden.iter().any(|key| key == &issuer_bytes) {
                return Err(ApiError::HiddenByOperator);
            }
        }
    }
    enrich_image_path(&state, &mut response).await?;
    Ok(Json(response))
}
