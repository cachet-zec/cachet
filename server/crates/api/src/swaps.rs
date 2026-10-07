//! The public swap board: a mailbox for the three messages of an atomic
//! swap (crates/swap, ADR 004), so two people need not pass them by hand.
//!
//! The registry holds messages, never keys, and signs nothing. An offer is
//! public by design. A take is read back only by the maker, a
//! countersignature only by the taker, each with the capability token its
//! author was handed (the registry keeps their SHA-256). Without accounts:
//! whoever holds the token is the party. Nothing here can move funds: a
//! take is useless without the maker's signature, and the maker checks the
//! transaction against its own offer before signing.
//!
//! An offer is built on an Orchard root, and a taker's wallet can build on
//! the roots of its last `ANCHOR_WINDOW` blocks only. So the board takes an
//! offer only on a recent root of the chain it reads, lists it while a
//! taker still has `ANCHOR_MARGIN` blocks to scan and prove in, and then
//! reports it `stale`: the maker's page posts it again on a newer root.

use axum::Json;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use cachet_chain::{ANCHOR_WINDOW, RecentAnchors};
use cachet_index::{SWAP_TAKE_HOLD_SECS, SwapRow};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use utoipa::ToSchema;

use crate::AppState;
use crate::error::ApiError;
use crate::routes::{metadata_error, require_metadata_store};

/// Offers that may be open at once: the board is a convenience, not storage.
const MAX_OPEN_OFFERS: u32 = 200;
/// Longest an offer may stay up, and its default, in hours.
const MAX_HOURS: u32 = 72;
const DEFAULT_HOURS: u32 = 24;
/// Size caps per message (an offer carries a path; a take, a transaction).
const MAX_OFFER_BYTES: usize = 16 * 1024;
const MAX_TAKE_BYTES: usize = 192 * 1024;
const MAX_SIGNATURE_BYTES: usize = 1024;
/// Header carrying a capability token.
const TOKEN_HEADER: &str = "x-swap-token";
/// Blocks left to a taker between seeing an offer and its anchor leaving
/// the wallets' reach: time to scan and prove, at minutes a block.
const ANCHOR_MARGIN: u64 = 10;

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs() as i64)
        .unwrap_or_default()
}

fn invalid(reason: &'static str) -> ApiError {
    ApiError::Validation(cachet_domain::DomainError::InvalidMetadata { reason })
}

/// The anchor an offer message is built on.
fn offer_anchor(offer: &str) -> Option<[u8; 32]> {
    let offer: cachet_swap::Offer = serde_json::from_str(offer).ok()?;
    hex::decode(offer.anchor).ok()?.try_into().ok()
}

/// Whether a wallet at the tip can still build on the offer's anchor, with
/// `margin` blocks to spare. With nothing to check against, it can.
fn anchor_fresh(anchors: Option<&RecentAnchors>, offer: &str, margin: u64) -> bool {
    let Some(anchors) = anchors else {
        return true;
    };
    offer_anchor(offer)
        .and_then(|anchor| anchors.age(&anchor))
        .is_some_and(|age| age + margin < ANCHOR_WINDOW)
}

/// The chain's recent roots for reads: a node that does not answer leaves
/// offers as they are (a take is still checked in full) rather than
/// emptying the board.
async fn recent_anchors(state: &AppState) -> Option<std::sync::Arc<RecentAnchors>> {
    match state.chain.recent_anchors().await {
        Ok(anchors) => anchors,
        Err(error) => {
            tracing::warn!(%error, "swap board: recent anchors unavailable");
            None
        }
    }
}

fn random_hex<const N: usize>() -> String {
    let mut bytes = [0u8; N];
    rand::RngCore::fill_bytes(&mut rand::rngs::OsRng, &mut bytes);
    hex::encode(bytes)
}

/// The SHA-256 of the token in the request, or 404: a wrong or missing
/// token looks exactly like an offer that is not there.
fn token_hash(headers: &HeaderMap) -> Result<[u8; 32], ApiError> {
    let token = headers
        .get(TOKEN_HEADER)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| hex::decode(value.trim()).ok())
        .filter(|bytes| bytes.len() == 32)
        .ok_or(ApiError::NotFound { what: "swap" })?;
    Ok(Sha256::digest(token).into())
}

/// Where an offer stands.
fn status(row: &SwapRow, now: i64, stale: bool) -> &'static str {
    if row.closed {
        "closed"
    } else if now >= row.expires_at {
        "expired"
    } else if row.countersignature.is_some() {
        "countersigned"
    } else if row.is_open(now) && stale {
        "stale"
    } else if row.is_open(now) {
        "open"
    } else {
        "taken"
    }
}

/// Post an offer.
#[derive(Debug, Deserialize, ToSchema)]
pub struct PostOfferRequest {
    /// The offer message, as the mint engine wrote it (JSON text).
    pub offer: String,
    /// Hours it stays up: 1 to 72, 24 by default.
    pub hours: Option<u32>,
}

/// A posted offer, and the token that manages it.
#[derive(Debug, Serialize, ToSchema)]
pub struct PostOfferResponse {
    pub id: String,
    /// Shown once. Reads the take, posts the countersignature, withdraws.
    pub maker_token: String,
    pub expires_at: i64,
}

/// An offer on the board.
#[derive(Debug, Serialize, ToSchema)]
pub struct SwapOfferResponse {
    pub id: String,
    pub give_asset: String,
    pub give_amount: u64,
    pub want_asset: String,
    pub want_amount: u64,
    pub created_at: i64,
    pub expires_at: i64,
    /// `open`, `taken` (held for the maker's signature), `countersigned`,
    /// `closed`, `expired`, or `stale` (its anchor is too old for takers'
    /// wallets: off the board until the maker posts it again).
    pub status: String,
    /// The offer message itself; only on the single-offer route.
    pub offer: Option<String>,
}

fn summary(row: &SwapRow, now: i64, with_offer: bool, stale: bool) -> SwapOfferResponse {
    SwapOfferResponse {
        id: row.id.clone(),
        give_asset: hex::encode(row.give_asset),
        give_amount: row.give_amount,
        want_asset: hex::encode(row.want_asset),
        want_amount: row.want_amount,
        created_at: row.created_at,
        expires_at: row.expires_at,
        status: status(row, now, stale).to_owned(),
        offer: with_offer.then(|| row.offer.clone()),
    }
}

/// Take an offer.
#[derive(Debug, Deserialize, ToSchema)]
pub struct TakeRequest {
    /// The taker's message (JSON text): the transaction awaiting the maker.
    pub take: String,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct TakeResponse {
    /// Shown once. Reads the countersignature, reports the swap done.
    pub taker_token: String,
    /// The take holds the offer this long for the maker, in seconds.
    pub hold_secs: i64,
}

/// The take, for the maker.
#[derive(Debug, Serialize, ToSchema)]
pub struct TakeEnvelope {
    pub take: Option<String>,
    /// Identifies the take a countersignature answers.
    pub taken_at: Option<i64>,
}

/// The maker's answer.
#[derive(Debug, Deserialize, ToSchema)]
pub struct CountersignRequest {
    pub countersignature: String,
    /// The `taken_at` of the take it signs.
    pub taken_at: i64,
}

/// The countersignature, for the taker.
#[derive(Debug, Serialize, ToSchema)]
pub struct CountersignatureEnvelope {
    pub countersignature: Option<String>,
}

/// Post an offer to the swap board. The offer is checked the way a taker
/// would check it before it is listed.
#[utoipa::path(
    post,
    path = "/api/v1/swaps",
    tag = "swaps",
    request_body = PostOfferRequest,
    responses(
        (status = 201, body = PostOfferResponse),
        (status = 400, body = crate::error::ProblemDetails, content_type = "application/problem+json"),
        (status = 429, body = crate::error::ProblemDetails, content_type = "application/problem+json"),
    )
)]
pub(crate) async fn post_offer(
    State(state): State<AppState>,
    crate::client_key::Client(client): crate::client_key::Client,
    Json(body): Json<PostOfferRequest>,
) -> Result<(StatusCode, Json<PostOfferResponse>), ApiError> {
    if state.write_paths_paused() {
        return Err(ApiError::MintsPaused);
    }
    if !state.client_limits.take_offer(client) {
        return Err(ApiError::SwapOfferBudgetSpent);
    }
    let store = require_metadata_store(&state)?;
    if body.offer.len() > MAX_OFFER_BYTES {
        return Err(invalid("the offer is too large"));
    }
    let offer: cachet_swap::Offer =
        serde_json::from_str(&body.offer).map_err(|_| invalid("that is not a swap offer"))?;
    let terms = cachet_swap::inspect_offer(&offer).map_err(|error| {
        tracing::debug!(%error, "swap board: offer refused");
        invalid("the offer does not hold together")
    })?;
    // Built on a root this chain had in its last blocks, or no wallet could
    // take it. Asked of the node now: an offer is not listed unchecked.
    let anchors = state.chain.recent_anchors().await?;
    if !anchor_fresh(anchors.as_deref(), &body.offer, ANCHOR_MARGIN) {
        return Err(invalid(
            "the offer is not built on a recent Orchard root of this chain",
        ));
    }
    let hours = body.hours.unwrap_or(DEFAULT_HOURS);
    if !(1..=MAX_HOURS).contains(&hours) {
        return Err(invalid("hours must be between 1 and 72"));
    }
    let now = now();
    if store
        .swap_list_open(now, MAX_OPEN_OFFERS)
        .await
        .map_err(metadata_error)?
        .len() as u32
        >= MAX_OPEN_OFFERS
    {
        return Err(ApiError::SwapBoardFull);
    }

    let id = random_hex::<16>();
    let token = random_hex::<32>();
    let expires_at = now + i64::from(hours) * 3600;
    store
        .swap_insert(SwapRow {
            id: id.clone(),
            offer: body.offer,
            give_asset: terms.give_asset,
            give_amount: terms.give_amount,
            want_asset: terms.want_asset,
            want_amount: terms.want_amount,
            maker_token: Sha256::digest(hex::decode(&token).expect("hex just made")).into(),
            created_at: now,
            expires_at,
            maker_seen_at: now,
            take: None,
            taker_token: None,
            taken_at: None,
            countersignature: None,
            closed: false,
        })
        .await
        .map_err(metadata_error)?;
    Ok((
        StatusCode::CREATED,
        Json(PostOfferResponse {
            id,
            maker_token: token,
            expires_at,
        }),
    ))
}

/// Offers open to takers, newest first.
#[utoipa::path(
    get,
    path = "/api/v1/swaps",
    tag = "swaps",
    responses((status = 200, body = Vec<SwapOfferResponse>))
)]
pub(crate) async fn list_offers(
    State(state): State<AppState>,
) -> Result<Json<Vec<SwapOfferResponse>>, ApiError> {
    let store = require_metadata_store(&state)?;
    let now = now();
    let rows = store
        .swap_list_open(now, MAX_OPEN_OFFERS)
        .await
        .map_err(metadata_error)?;
    let anchors = recent_anchors(&state).await;
    Ok(Json(
        rows.iter()
            .filter(|row| anchor_fresh(anchors.as_deref(), &row.offer, ANCHOR_MARGIN))
            .map(|row| summary(row, now, false, false))
            .collect(),
    ))
}

/// One offer, with the offer message itself.
#[utoipa::path(
    get,
    path = "/api/v1/swaps/{id}",
    tag = "swaps",
    params(("id" = String, Path, description = "Offer id")),
    responses(
        (status = 200, body = SwapOfferResponse),
        (status = 404, body = crate::error::ProblemDetails, content_type = "application/problem+json"),
    )
)]
pub(crate) async fn get_offer(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<SwapOfferResponse>, ApiError> {
    let store = require_metadata_store(&state)?;
    let row = store
        .swap_get(&id)
        .await
        .map_err(metadata_error)?
        .ok_or(ApiError::NotFound { what: "swap" })?;
    let anchors = recent_anchors(&state).await;
    let stale = !anchor_fresh(anchors.as_deref(), &row.offer, ANCHOR_MARGIN);
    Ok(Json(summary(&row, now(), true, stale)))
}

/// Take an offer: hold it for the maker's countersignature.
#[utoipa::path(
    post,
    path = "/api/v1/swaps/{id}/take",
    tag = "swaps",
    params(("id" = String, Path, description = "Offer id")),
    request_body = TakeRequest,
    responses(
        (status = 201, body = TakeResponse),
        (status = 409, body = crate::error::ProblemDetails, content_type = "application/problem+json", description = "Not open: taken, closed or expired"),
    )
)]
pub(crate) async fn take_offer(
    State(state): State<AppState>,
    crate::client_key::Client(client): crate::client_key::Client,
    Path(id): Path<String>,
    Json(body): Json<TakeRequest>,
) -> Result<(StatusCode, Json<TakeResponse>), ApiError> {
    if state.write_paths_paused() {
        return Err(ApiError::MintsPaused);
    }
    if !state.client_limits.take_relay(client) {
        return Err(ApiError::RelayBudgetSpent);
    }
    let store = require_metadata_store(&state)?;
    if body.take.len() > MAX_TAKE_BYTES {
        return Err(invalid("the take is too large"));
    }
    let take: cachet_swap::Take =
        serde_json::from_str(&body.take).map_err(|_| invalid("that is not a swap take"))?;
    let row = store
        .swap_get(&id)
        .await
        .map_err(metadata_error)?
        .ok_or(ApiError::NotFound { what: "swap" })?;
    if !row.is_open(now()) {
        return Err(ApiError::SwapUnavailable);
    }
    // No margin here: a wallet that built on the anchor in time may hold it.
    if !anchor_fresh(recent_anchors(&state).await.as_deref(), &row.offer, 0) {
        return Err(invalid(
            "this offer's anchor is too old for any wallet to build on; the maker posts it again",
        ));
    }
    let offer: cachet_swap::Offer =
        serde_json::from_str(&row.offer).map_err(|_| invalid("the stored offer is unreadable"))?;
    // A take holds the offer: before it does, it must be a real answer to
    // it (the maker's note spent on the offer's anchor, the proof and the
    // binding signature valid, the taker's spends signed). Verifying a
    // proof is CPU work, kept off the async runtime.
    let checked = tokio::task::spawn_blocking(move || cachet_swap::check_take(&offer, &take))
        .await
        .map_err(|_| invalid("the take could not be checked"))?;
    if let Err(error) = checked {
        tracing::debug!(%error, "swap board: take refused");
        return Err(invalid("the take does not answer this offer"));
    }
    let token = random_hex::<32>();
    let hash: [u8; 32] = Sha256::digest(hex::decode(&token).expect("hex just made")).into();
    if !store
        .swap_take(&id, &body.take, hash, now())
        .await
        .map_err(metadata_error)?
    {
        return Err(ApiError::SwapUnavailable);
    }
    Ok((
        StatusCode::CREATED,
        Json(TakeResponse {
            taker_token: token,
            hold_secs: SWAP_TAKE_HOLD_SECS,
        }),
    ))
}

/// The take waiting for the maker (maker token).
#[utoipa::path(
    get,
    path = "/api/v1/swaps/{id}/take",
    tag = "swaps",
    params(("id" = String, Path, description = "Offer id")),
    responses(
        (status = 200, body = TakeEnvelope),
        (status = 404, body = crate::error::ProblemDetails, content_type = "application/problem+json"),
    )
)]
pub(crate) async fn read_take(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<TakeEnvelope>, ApiError> {
    let store = require_metadata_store(&state)?;
    let hash = token_hash(&headers)?;
    // Each check-in keeps the offer on the board: the maker's page is what
    // answers a take, so the board lists only offers whose page is there.
    store
        .swap_seen(&id, hash, now())
        .await
        .map_err(metadata_error)?;
    let row = store
        .swap_get(&id)
        .await
        .map_err(metadata_error)?
        .filter(|row| row.maker_token == hash)
        .ok_or(ApiError::NotFound { what: "swap" })?;
    // A take whose hold ran out is no longer the maker's to answer.
    let live = row.countersignature.is_none() && !row.is_open(now()) && !row.closed;
    Ok(Json(TakeEnvelope {
        take: live.then(|| row.take.clone()).flatten(),
        taken_at: live.then_some(row.taken_at).flatten(),
    }))
}

/// Release the take holding an offer (maker token): the maker's page refused
/// it, and the offer is open again at once rather than after the hold.
#[utoipa::path(
    delete,
    path = "/api/v1/swaps/{id}/take",
    tag = "swaps",
    params(("id" = String, Path, description = "Offer id")),
    responses(
        (status = 204, description = "Released"),
        (status = 404, body = crate::error::ProblemDetails, content_type = "application/problem+json"),
    )
)]
pub(crate) async fn release_take(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<StatusCode, ApiError> {
    let store = require_metadata_store(&state)?;
    let hash = token_hash(&headers)?;
    if store
        .swap_release(&id, hash)
        .await
        .map_err(metadata_error)?
    {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err(ApiError::NotFound { what: "swap" })
    }
}

/// Post the maker's countersignature (maker token).
#[utoipa::path(
    post,
    path = "/api/v1/swaps/{id}/countersignature",
    tag = "swaps",
    params(("id" = String, Path, description = "Offer id")),
    request_body = CountersignRequest,
    responses(
        (status = 204, description = "Stored for the taker"),
        (status = 404, body = crate::error::ProblemDetails, content_type = "application/problem+json"),
        (status = 409, body = crate::error::ProblemDetails, content_type = "application/problem+json"),
    )
)]
pub(crate) async fn post_countersignature(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(body): Json<CountersignRequest>,
) -> Result<StatusCode, ApiError> {
    let store = require_metadata_store(&state)?;
    let hash = token_hash(&headers)?;
    if body.countersignature.len() > MAX_SIGNATURE_BYTES {
        return Err(invalid("the countersignature is too large"));
    }
    serde_json::from_str::<cachet_swap::Countersignature>(&body.countersignature)
        .map_err(|_| invalid("that is not a swap countersignature"))?;
    if !store
        .swap_countersign(&id, hash, body.taken_at, &body.countersignature)
        .await
        .map_err(metadata_error)?
    {
        return Err(ApiError::SwapUnavailable);
    }
    Ok(StatusCode::NO_CONTENT)
}

/// The countersignature, once the maker posted it (taker token).
#[utoipa::path(
    get,
    path = "/api/v1/swaps/{id}/countersignature",
    tag = "swaps",
    params(("id" = String, Path, description = "Offer id")),
    responses(
        (status = 200, body = CountersignatureEnvelope),
        (status = 404, body = crate::error::ProblemDetails, content_type = "application/problem+json"),
    )
)]
pub(crate) async fn read_countersignature(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<CountersignatureEnvelope>, ApiError> {
    let store = require_metadata_store(&state)?;
    let hash = token_hash(&headers)?;
    let row = store
        .swap_get(&id)
        .await
        .map_err(metadata_error)?
        .filter(|row| row.taker_token == Some(hash))
        .ok_or(ApiError::NotFound { what: "swap" })?;
    Ok(Json(CountersignatureEnvelope {
        countersignature: row.countersignature,
    }))
}

/// Close an offer: the maker withdrawing it (maker token), or the taker
/// reporting it complete once countersigned (taker token).
#[utoipa::path(
    delete,
    path = "/api/v1/swaps/{id}",
    tag = "swaps",
    params(("id" = String, Path, description = "Offer id")),
    responses(
        (status = 204, description = "Closed"),
        (status = 404, body = crate::error::ProblemDetails, content_type = "application/problem+json"),
    )
)]
pub(crate) async fn close_offer(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<StatusCode, ApiError> {
    let store = require_metadata_store(&state)?;
    let hash = token_hash(&headers)?;
    if store.swap_close(&id, hash).await.map_err(metadata_error)? {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err(ApiError::NotFound { what: "swap" })
    }
}
