//! Route handlers. Thin by design: parse DTO → call the chain boundary →
//! map to DTO. Business rules live in `cachet-domain`, chain logic in
//! `cachet-chain`.

use axum::extract::{Path, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use cachet_domain::AssetId;

use crate::AppState;
use crate::dto::{
    AccountBalancesResponse, AssetEventResponse, AssetSummaryResponse, BatchIssueRequest,
    BatchIssueResponse, BurnAssetRequest, ChainInfoResponse, CollectionResponse, IssueAssetRequest,
    IssueAssetResponse, KeptAssetResponse, MetadataUploadRequest, MetadataUploadResponse,
    RawBlocksResponse, RelayRequest, ResolveDescriptionRequest, TransferAssetRequest, TxResponse,
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
        .route("/api/v1/assets", get(list_assets).post(issue_asset))
        .route("/api/v1/assets/batch", post(issue_asset_batch))
        .route("/api/v1/collections", get(list_collections))
        .route("/api/v1/kept", get(list_kept))
        .route("/api/v1/kept/{asset_id}", get(get_kept))
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
            "/api/v1/admin/pause",
            get(crate::admin::pause_get).put(crate::admin::pause_set),
        )
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

/// Issuer-level moderation, applied wherever an asset's content can be
/// obtained: a hidden issuance key's assets answer 410 from every route,
/// not just the ones that list them.
async fn refuse_hidden_issuer(state: &AppState, issuer: Option<&str>) -> Result<(), ApiError> {
    let (Some(store), Some(issuer)) = (&state.metadata, issuer) else {
        return Ok(());
    };
    let Ok(issuer_bytes) = hex::decode(issuer) else {
        return Ok(());
    };
    let hidden = store.hidden_issuers().await.map_err(metadata_error)?;
    if hidden.iter().any(|key| key == &issuer_bytes) {
        return Err(ApiError::HiddenByOperator);
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
        state.write_paths_paused(),
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
// Said outright: the handler takes the extractor inside a `Result`, where
// the macro can no longer read it off the signature.
#[into_params(parameter_in = Query)]
pub(crate) struct ListAssetsParams {
    /// Keep only the newest N assets. Omitted: the whole registry (what a
    /// client doing its own search or mirroring wants).
    pub limit: Option<usize>,
    /// Skip this many assets before the first one returned. With `limit`,
    /// a page. The totals a pager needs come back as headers.
    pub offset: Option<usize>,
    /// `true`: keep only assets whose description is known, so their name
    /// is attested rather than an id. Omitted: everything, which stays the
    /// default - this is a caller's view preference, never moderation.
    pub resolved: Option<bool>,
    /// Keep assets whose name or description contains this text (case
    /// ignored), or whose asset id or issuer key starts with it.
    pub q: Option<String>,
    /// Keep only assets minted under this issuance key (hex).
    pub issuer: Option<String>,
    /// `sealed`: finalized assets only. `open`: the others.
    #[param(inline)]
    pub supply: Option<SupplyFilter>,
    /// `named_first`: sealed names, then free-text labels, then unnamed,
    /// chain order kept inside each group. Omitted: newest first.
    #[param(inline)]
    pub order: Option<ListOrder>,
}

/// Which supply states a listing keeps.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "snake_case")]
pub(crate) enum SupplyFilter {
    Sealed,
    Open,
}

/// How a listing is ordered.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ListOrder {
    NamedFirst,
}

/// Assets the registry lists, before the caller's own filters.
const REGISTRY_COUNT: &str = "x-registry-count";
/// Assets matching the caller's filters, before `offset` and `limit`.
const TOTAL_COUNT: &str = "x-total-count";
/// Among those, the ones without a resolved description.
const UNRESOLVED_COUNT: &str = "x-unresolved-count";

/// A JSON body the caller can keep: it carries a validator, and comes back
/// as `304 Not Modified`, without a body, to a caller that already holds
/// it. A registry is polled far more often than it changes.
///
/// The validator is weak and compared by prefix: a proxy that compresses
/// the response is allowed to decorate it on the way out.
fn revalidated_json<T: serde::Serialize>(
    request: &HeaderMap,
    body: &T,
    counts: &[(&'static str, usize)],
) -> Response {
    use sha2::Digest;

    let bytes = serde_json::to_vec(body).expect("a listing is plain data");
    let mut hasher = sha2::Sha256::new();
    hasher.update(&bytes);
    for (name, value) in counts {
        hasher.update(name.as_bytes());
        hasher.update(value.to_le_bytes());
    }
    let tag = hex::encode(&hasher.finalize()[..16]);

    let held = request
        .get(header::IF_NONE_MATCH)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| {
            value.split(',').any(|candidate| {
                candidate
                    .trim()
                    .trim_start_matches("W/")
                    .trim_matches('"')
                    .starts_with(&tag)
            })
        });

    let mut response = if held {
        StatusCode::NOT_MODIFIED.into_response()
    } else {
        ([(header::CONTENT_TYPE, "application/json")], bytes).into_response()
    };
    let headers = response.headers_mut();
    headers.insert(
        header::ETAG,
        HeaderValue::from_str(&format!("W/\"{tag}\"")).expect("hex is a valid header value"),
    );
    // Keep it, but ask before every reuse.
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
    for (name, value) in counts {
        headers.insert(*name, HeaderValue::from(*value as u64));
    }
    response
}

/// List every asset observed on the chain, newest first.
///
/// Without parameters: the whole registry, as before. `limit` and `offset`
/// cut a page out of it; `q`, `issuer`, `supply` and `resolved` narrow it
/// first, and `order=named_first` brings attested names to the front. All
/// of them are the caller's view, never moderation: everything stays
/// reachable without them.
///
/// Three headers carry what a pager needs: `X-Registry-Count` (assets
/// listed at all), `X-Total-Count` (assets matching the filters, before the
/// page is cut) and `X-Unresolved-Count` (those among them without a
/// resolved description). The response carries an `ETag`; send it back in
/// `If-None-Match` and an unchanged listing answers `304` with no body.
#[utoipa::path(
    get,
    path = "/api/v1/assets",
    tag = "registry",
    params(ListAssetsParams),
    responses(
        (status = 200, body = Vec<AssetSummaryResponse>, headers(
            ("ETag" = String, description = "Validator for `If-None-Match`"),
            ("X-Registry-Count" = u64, description = "Assets listed, before any filter"),
            ("X-Total-Count" = u64, description = "Assets matching the filters, before `offset` and `limit`"),
            ("X-Unresolved-Count" = u64, description = "Matching assets without a resolved description"),
        )),
        (status = 304, description = "The listing the caller holds is still current"),
        (status = 400, body = crate::error::ProblemDetails, content_type = "application/problem+json"),
        (status = 503, body = crate::error::ProblemDetails, content_type = "application/problem+json"),
    )
)]
pub(crate) async fn list_assets(
    State(state): State<AppState>,
    params: Result<
        axum::extract::Query<ListAssetsParams>,
        axum::extract::rejection::QueryRejection,
    >,
    request: HeaderMap,
) -> Result<Response, ApiError> {
    let axum::extract::Query(params) = params?;
    // Operator moderation at issuer granularity: a hidden issuance key
    // removes every asset minted under it from listings. Availability
    // only, as always: the chain record is untouched and any other
    // registry can keep serving it.
    let hidden_issuers = match &state.metadata {
        Some(store) => store.hidden_issuers().await.map_err(metadata_error)?,
        None => Vec::new(),
    };
    // An issuer that is not a key matches nothing; say so rather than
    // answer an empty page that looks like an issuer without assets.
    let issuer = params
        .issuer
        .as_deref()
        .map(|issuer| {
            hex::decode(issuer)
                .ok()
                .filter(|key| key.len() == 33)
                .ok_or(ApiError::Validation(
                    cachet_domain::DomainError::InvalidId {
                        kind: "issuer",
                        expected: 66,
                    },
                ))
        })
        .transpose()?;
    // The backend filters, orders, cuts the page and counts: the page is
    // cut after moderation (a hidden issuer must not consume a slot) and
    // before enrichment (only what is sent gets enriched).
    let page = state
        .chain
        .list_assets_page(&cachet_domain::AssetListQuery {
            hidden_issuers,
            resolved_only: params.resolved == Some(true),
            issuer,
            supply: params.supply.map(|supply| match supply {
                SupplyFilter::Sealed => cachet_domain::SupplyState::Sealed,
                SupplyFilter::Open => cachet_domain::SupplyState::Open,
            }),
            search: params
                .q
                .as_deref()
                .and_then(cachet_domain::AssetListQuery::search_text),
            order: match params.order {
                Some(ListOrder::NamedFirst) => cachet_domain::ListingOrder::NamedFirst,
                None => cachet_domain::ListingOrder::Newest,
            },
            offset: params.offset.unwrap_or(0),
            limit: params.limit,
        })
        .await?;
    let (registry_count, total_count, unresolved_count) =
        (page.registry_count, page.total_count, page.unresolved_count);
    let mut responses: Vec<AssetSummaryResponse> = page.items.into_iter().map(Into::into).collect();
    enrich_image_paths(&state, &mut responses).await?;
    Ok(revalidated_json(
        &request,
        &responses,
        &[
            (REGISTRY_COUNT, registry_count),
            (TOTAL_COUNT, total_count),
            (UNRESOLVED_COUNT, unresolved_count),
        ],
    ))
}

/// Chain-level collections: every asset minted under one issuance key,
/// grouped — the only provenance statement the chain itself makes.
#[utoipa::path(
    get,
    path = "/api/v1/collections",
    tag = "registry",
    responses(
        (status = 200, body = Vec<CollectionResponse>, headers(
            ("ETag" = String, description = "Validator for `If-None-Match`"),
        )),
        (status = 304, description = "The listing the caller holds is still current"),
        (status = 503, body = crate::error::ProblemDetails, content_type = "application/problem+json"),
    )
)]
pub(crate) async fn list_collections(
    State(state): State<AppState>,
    request: HeaderMap,
) -> Result<Response, ApiError> {
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
    Ok(revalidated_json(&request, &responses, &[]))
}

/// Point `image_path` at the stored image for every row whose sealed
/// bundle holds one: one bounded store query for the whole page instead of
/// two per row, and no bundle payload crosses the wire for a listing (the
/// endpoints are public and cheap to call; their cost must not scale with
/// what they list).
async fn enrich_image_paths(
    state: &AppState,
    responses: &mut [AssetSummaryResponse],
) -> Result<(), ApiError> {
    let Some(store) = &state.metadata else {
        return Ok(());
    };
    let sealed_hash = |response: &AssetSummaryResponse| {
        response
            .description
            .as_deref()
            .and_then(cachet_domain::ChainDescription::parse)
            .and_then(|envelope| {
                parse_sha256(&envelope.sha256)
                    .ok()
                    .map(|hash| (hash, envelope.sha256))
            })
    };
    let hashes: Vec<[u8; 32]> = responses
        .iter()
        .filter_map(|response| sealed_hash(response).map(|(hash, _)| hash))
        .collect();
    let visible = store
        .visible_image_hashes(&hashes)
        .await
        .map_err(metadata_error)?;
    for response in responses {
        if let Some((hash, hex)) = sealed_hash(response) {
            if visible.contains(&hash) {
                response.image_path = Some(format!("/api/v1/metadata/{hex}/image"));
            }
        }
    }
    Ok(())
}

/// A kept description as a response, with its image when still held.
fn kept_summary(asset_id: AssetId, description: String) -> AssetSummaryResponse {
    cachet_domain::AssetSummary {
        asset_id,
        description: Some(description),
        issuer: None,
        total_supply: 0,
        finalized: false,
    }
    .into()
}

/// Query parameters for the kept listing.
#[derive(Debug, serde::Deserialize, utoipa::IntoParams)]
// Said outright: the handler takes the extractor inside a `Result`, where
// the macro can no longer read it off the signature.
#[into_params(parameter_in = Query)]
pub(crate) struct ListKeptParams {
    /// Rows per page (1-100, default 25).
    pub limit: Option<usize>,
    /// Rows to skip.
    pub offset: Option<usize>,
}

/// Sealed content kept for assets the chain no longer carries.
///
/// A test network can be reset, and a reset takes every asset with it. The
/// registry's journal of descriptions and its bundles are keyed by asset id
/// and survive: this lists the ones whose asset is no longer on the chain
/// the registry follows, sealed names first. `X-Total-Count` carries the
/// total. Descriptions the operator withholds are left out.
#[utoipa::path(
    get,
    path = "/api/v1/kept",
    tag = "registry",
    params(ListKeptParams),
    responses(
        (status = 200, body = Vec<KeptAssetResponse>, headers(
            ("ETag" = String, description = "Validator for `If-None-Match`"),
            ("X-Total-Count" = u64, description = "Kept assets, before `offset` and `limit`"),
        )),
        (status = 304, description = "The listing the caller holds is still current"),
        (status = 503, body = crate::error::ProblemDetails, content_type = "application/problem+json"),
    )
)]
pub(crate) async fn list_kept(
    State(state): State<AppState>,
    params: Result<axum::extract::Query<ListKeptParams>, axum::extract::rejection::QueryRejection>,
    request: HeaderMap,
) -> Result<Response, ApiError> {
    let axum::extract::Query(params) = params?;
    let limit = params.limit.unwrap_or(25).clamp(1, 100);
    let (kept, total) = state
        .chain
        .kept_off_chain(limit, params.offset.unwrap_or(0))
        .await?;
    let mut summaries: Vec<AssetSummaryResponse> = kept
        .into_iter()
        .map(|(asset_id, description)| kept_summary(asset_id, description))
        .collect();
    enrich_image_paths(&state, &mut summaries).await?;
    let responses: Vec<KeptAssetResponse> = summaries.into_iter().map(Into::into).collect();
    Ok(revalidated_json(
        &request,
        &responses,
        &[(TOTAL_COUNT, total)],
    ))
}

/// The sealed content kept for one asset the chain no longer carries.
///
/// `404` when the asset is on chain (ask `/api/v1/assets/{asset_id}`), was
/// never known here, or its description is withheld by the operator.
#[utoipa::path(
    get,
    path = "/api/v1/kept/{asset_id}",
    tag = "registry",
    params(("asset_id" = String, Path, description = "Asset id, hex-encoded 32 bytes")),
    responses(
        (status = 200, body = KeptAssetResponse),
        (status = 400, body = crate::error::ProblemDetails, content_type = "application/problem+json"),
        (status = 404, body = crate::error::ProblemDetails, content_type = "application/problem+json"),
        (status = 503, body = crate::error::ProblemDetails, content_type = "application/problem+json"),
    )
)]
pub(crate) async fn get_kept(
    State(state): State<AppState>,
    Path(asset_id): Path<String>,
) -> Result<Json<KeptAssetResponse>, ApiError> {
    let asset_id: AssetId = asset_id.parse().map_err(ApiError::Validation)?;
    let description = state
        .chain
        .kept_description(asset_id)
        .await?
        .ok_or(ApiError::NotFound {
            what: "kept content for this asset",
        })?;
    let mut summary = kept_summary(asset_id, description);
    enrich_image_paths(&state, std::slice::from_mut(&mut summary)).await?;
    Ok(Json(summary.into()))
}

/// Relay a fully signed, browser-built ZSA transaction (issuance, transfer or burn).
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
        (status = 429, body = crate::error::ProblemDetails, content_type = "application/problem+json", description = "This client already has the maximum number of relays in flight (retry shortly), or has spent its relay budget for the minute (wait a minute)"),
        (status = 503, body = crate::error::ProblemDetails, content_type = "application/problem+json"),
    )
)]
pub(crate) async fn relay_transaction(
    State(state): State<AppState>,
    crate::client_key::Client(client): crate::client_key::Client,
    Json(body): Json<RelayRequest>,
) -> Result<(StatusCode, Json<TxResponse>), ApiError> {
    // Relays are serialized behind the node (one block at a time), so a
    // client that keeps one waiting holds everyone. Two bounds per client:
    // a budget per minute (rate: a script relaying one proof at a time was
    // never refused by the slot cap), then what it can have in flight; the
    // slot frees itself when this handler returns, whatever happened.
    if state.write_paths_paused() {
        return Err(ApiError::MintsPaused);
    }
    if !state.client_limits.take_relay(client) {
        return Err(ApiError::RelayBudgetSpent);
    }
    let _slot = state
        .client_limits
        .begin_relay(client)
        .ok_or(ApiError::RelayBusy)?;
    let tx_bytes = hex::decode(body.tx_hex.trim()).map_err(|_| {
        ApiError::Validation(cachet_domain::DomainError::InvalidMetadata {
            reason: "tx_hex must be hex-encoded transaction bytes",
        })
    })?;
    // Every relay that reaches the node counts toward the instance's own
    // breaker, whoever sent it: per-client budgets stop one address, this
    // stops a crowd of them. The relay that trips it is refused too.
    if let Some(trip) = state.breaker.record() {
        tracing::warn!(
            relays = trip.relays,
            pause_secs = trip.until_unix - trip.since_unix,
            "circuit breaker: relay flood, write paths paused automatically"
        );
        if let Some(webhook) = &state.mint_webhook {
            let webhook = webhook.clone();
            let content = format!(
                "⛔ **Minting paused automatically**: {} relays reached the node in five minutes \
                 (threshold {}). Reopens by itself in {} minutes; resume earlier from /admin.",
                trip.relays,
                state.breaker.threshold(),
                (trip.until_unix - trip.since_unix) / 60
            );
            tokio::spawn(async move {
                let sent = reqwest::Client::new()
                    .post(webhook.as_ref())
                    .json(&serde_json::json!({ "content": content }))
                    .timeout(std::time::Duration::from_secs(5))
                    .send()
                    .await;
                if let Err(error) = sent {
                    tracing::warn!(%error, "breaker webhook delivery failed");
                }
            });
        }
        return Err(ApiError::MintsPaused);
    }
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
            // The first origin listed is this instance's own console.
            let origin = std::env::var("CACHET_CORS_ORIGIN")
                .ok()
                .and_then(|value| value.split(',').next().map(|first| first.trim().to_owned()))
                .filter(|first| !first.is_empty())
                .unwrap_or_else(|| "http://localhost:3000".to_owned());
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
        (status = 410, body = crate::error::ProblemDetails, content_type = "application/problem+json", description = "These exact bytes were withheld or purged by this registry's operator"),
        (status = 429, body = crate::error::ProblemDetails, content_type = "application/problem+json", description = "This client's upload budget for the minute is spent, or the pending-upload pool is at capacity"),
        (status = 503, body = crate::error::ProblemDetails, content_type = "application/problem+json"),
    )
)]
pub(crate) async fn upload_metadata(
    State(state): State<AppState>,
    crate::client_key::Client(client): crate::client_key::Client,
    Json(body): Json<MetadataUploadRequest>,
) -> Result<(StatusCode, Json<MetadataUploadResponse>), ApiError> {
    // Open to everyone, read-only deployments included: community mints
    // carry full bundles (name, description, image). The abuse bound is
    // chain-anchored — a bundle that no RESOLVED asset description
    // references is swept after a grace window, so durable storage costs
    // a real zk proof and leaves a public trace — plus two throttles that
    // keep the transient window itself bounded:
    //   1. a per-client upload budget (nobody legitimately uploads
    //      faster than they can prove mints, and one client's excess must
    //      not become everyone's 429 - a global counter did exactly that);
    //   2. a hard cap on the orphan pool, so a botnet cannot outrun the
    //      sweeper and exhaust the disk.
    // The budget is keyed by a salted hash of the address, memory only,
    // never logged (PRIVACY.md P2 holds).
    if state.write_paths_paused() {
        return Err(ApiError::MintsPaused);
    }
    if !state.client_limits.take_upload(client) {
        return Err(ApiError::UploadPoolFull);
    }
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

    // Content-addressed, so the hash is known before anything is stored:
    // bytes the operator withheld (or purged) are refused here rather
    // than landing on disk again under the same name.
    let bytes = bundle.to_canonical_bytes();
    let sha256: [u8; 32] = {
        use sha2::{Digest, Sha256};
        Sha256::digest(&bytes).into()
    };
    if store.is_hidden(sha256).await.map_err(metadata_error)? {
        return Err(ApiError::HiddenByOperator);
    }
    let sha256 = store.put(bytes).await.map_err(metadata_error)?;
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
/// registry cannot be lied to. This is how assets issued elsewhere gain
/// names here.
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
    // A hidden issuer's asset must not come back enriched through the
    // resolution route either - the check precedes the write.
    {
        let current: AssetSummaryResponse = state.chain.asset_state(asset_id).await?.into();
        refuse_hidden_issuer(&state, current.issuer.as_deref()).await?;
    }
    state
        .chain
        .resolve_description(asset_id, &body.description)
        .await?;
    let mut response: AssetSummaryResponse = state.chain.asset_state(asset_id).await?.into();
    enrich_image_paths(&state, std::slice::from_mut(&mut response)).await?;
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
    refuse_hidden_issuer(&state, response.issuer.as_deref()).await?;
    enrich_image_paths(&state, std::slice::from_mut(&mut response)).await?;
    Ok(Json(response))
}
