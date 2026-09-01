//! Operator admin surface: moderation over HTTP, token-gated.
//!
//! Disabled by default — with no CACHET_ADMIN_TOKEN in the environment
//! every route here answers 404, indistinguishable from not existing.
//! With a token, requests carry `Authorization: Bearer <token>`, compared
//! in constant time. This is the one deliberate exception to
//! "moderation only over SSH": it stays availability-only (hide, never
//! alter), auditable and reversible, exactly like the CLI it mirrors.

use axum::Json;
use axum::extract::State;
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use crate::AppState;
use crate::error::ApiError;
use crate::routes::{metadata_error, require_metadata_store};

/// Constant-time byte comparison: a wrong token must cost the same time
/// as a right one, whatever the mismatch position.
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn authorize(state: &AppState, headers: &axum::http::HeaderMap) -> Result<(), ApiError> {
    let Some(expected) = &state.admin_token else {
        // No token configured → the surface does not exist.
        return Err(ApiError::AdminUnauthorized);
    };
    // RFC 7235: the auth-scheme is case-insensitive.
    let provided = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| {
            let (scheme, token) = value.split_once(' ')?;
            scheme
                .eq_ignore_ascii_case("bearer")
                .then_some(token.trim())
        })
        .unwrap_or_default();
    if constant_time_eq(provided.as_bytes(), expected.as_bytes()) {
        Ok(())
    } else {
        Err(ApiError::AdminUnauthorized)
    }
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct ModerationRequest {
    /// `bundle`, `description` or `issuer`.
    pub kind: String,
    /// Hex-encoded key: bundle sha256, asset id, or issuance validating key.
    pub key: String,
    /// Optional operator note, stored with the entry (audit trail).
    pub reason: Option<String>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct ModerationEntryResponse {
    pub kind: String,
    pub key: String,
    pub reason: Option<String>,
    pub hidden_at: String,
}

fn parse_request(
    body: &ModerationRequest,
) -> Result<(cachet_index::ModerationKind, Vec<u8>), ApiError> {
    let kind = cachet_index::ModerationKind::parse(&body.kind).ok_or(ApiError::Validation(
        cachet_domain::DomainError::InvalidMetadata {
            reason: "kind must be bundle, description or issuer",
        },
    ))?;
    let key = hex::decode(body.key.trim()).map_err(|_| {
        ApiError::Validation(cachet_domain::DomainError::InvalidMetadata {
            reason: "key must be hex",
        })
    })?;
    // Length is part of the identity: a truncated asset id would be stored
    // happily and match nothing, so the operator would see "hidden" while
    // the content stayed visible. Silent moderation failure is the worst
    // kind, so a wrong length is refused loudly.
    let expected = match kind {
        cachet_index::ModerationKind::Issuer => 33, // issuance validating key
        _ => 32,                                    // bundle sha256 / asset id
    };
    if key.len() != expected {
        return Err(ApiError::Validation(
            cachet_domain::DomainError::InvalidMetadata {
                reason: "key has the wrong length for this kind (32 bytes for bundle and                          description, 33 for an issuer key)",
            },
        ));
    }
    Ok((kind, key))
}

/// Hide a bundle, description or issuer from this registry's distribution.
#[utoipa::path(
    post,
    path = "/api/v1/admin/moderation",
    tag = "ops",
    request_body = ModerationRequest,
    responses(
        (status = 204, description = "Hidden"),
        (status = 404, description = "Admin surface disabled or bad token"),
    )
)]
pub(crate) async fn hide(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
    Json(body): Json<ModerationRequest>,
) -> Result<axum::http::StatusCode, ApiError> {
    authorize(&state, &headers)?;
    let store = require_metadata_store(&state)?;
    let (kind, key) = parse_request(&body)?;
    store
        .moderation_hide(kind, &key, body.reason.as_deref())
        .await
        .map_err(metadata_error)?;
    tracing::info!(kind = body.kind, key = body.key, "admin: hidden");
    Ok(axum::http::StatusCode::NO_CONTENT)
}

/// Lift a moderation entry.
#[utoipa::path(
    delete,
    path = "/api/v1/admin/moderation",
    tag = "ops",
    request_body = ModerationRequest,
    responses(
        (status = 204, description = "Unhidden (or was not hidden)"),
        (status = 404, description = "Admin surface disabled or bad token"),
    )
)]
pub(crate) async fn unhide(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
    Json(body): Json<ModerationRequest>,
) -> Result<axum::http::StatusCode, ApiError> {
    authorize(&state, &headers)?;
    let store = require_metadata_store(&state)?;
    let (kind, key) = parse_request(&body)?;
    store
        .moderation_unhide(kind, &key)
        .await
        .map_err(metadata_error)?;
    tracing::info!(kind = body.kind, key = body.key, "admin: unhidden");
    Ok(axum::http::StatusCode::NO_CONTENT)
}

/// Every moderation entry, for the operator's audit view.
#[utoipa::path(
    get,
    path = "/api/v1/admin/moderation",
    tag = "ops",
    responses(
        (status = 200, body = Vec<ModerationEntryResponse>),
        (status = 404, description = "Admin surface disabled or bad token"),
    )
)]
pub(crate) async fn list(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
) -> Result<Json<Vec<ModerationEntryResponse>>, ApiError> {
    authorize(&state, &headers)?;
    let store = require_metadata_store(&state)?;
    let entries = store.moderation_list().await.map_err(metadata_error)?;
    Ok(Json(
        entries
            .into_iter()
            .map(|entry| ModerationEntryResponse {
                kind: entry.kind,
                key: entry.key,
                reason: entry.reason,
                hidden_at: entry.hidden_at,
            })
            .collect(),
    ))
}

#[cfg(test)]
mod tests {
    use super::constant_time_eq;

    #[test]
    fn constant_time_eq_matches_semantics() {
        assert!(constant_time_eq(b"secret", b"secret"));
        assert!(!constant_time_eq(b"secret", b"secreT"));
        assert!(!constant_time_eq(b"secret", b"secret2"));
        assert!(!constant_time_eq(b"", b"x"));
        assert!(constant_time_eq(b"", b""));
    }
}
