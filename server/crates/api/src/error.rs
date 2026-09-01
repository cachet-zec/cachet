//! API error type and its RFC 9457 (`application/problem+json`) rendering.

use axum::Json;
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use cachet_chain::ChainError;
use cachet_domain::DomainError;
use serde::Serialize;
use utoipa::ToSchema;

/// RFC 9457 problem document. Every non-2xx response uses this shape.
#[derive(Debug, Serialize, ToSchema)]
pub struct ProblemDetails {
    /// Stable, documentation-friendly error identifier.
    #[schema(example = "https://cachetzec.com/problems/asset-finalized")]
    pub r#type: String,
    /// Short human-readable summary.
    pub title: String,
    /// HTTP status code, duplicated for clients that drop it.
    pub status: u16,
    /// Human-readable explanation specific to this occurrence.
    pub detail: String,
}

/// Unified API error: everything a handler can fail with.
#[derive(Debug, thiserror::Error)]
pub enum ApiError {
    #[error(transparent)]
    Validation(#[from] DomainError),
    #[error(transparent)]
    Chain(#[from] ChainError),
    #[error("{what} not found")]
    NotFound { what: &'static str },
    #[error("this deployment is read-only; minting, transfers and burns are disabled")]
    ReadOnly,
    #[error(
        "hidden by this registry's operator; the on-chain commitment is unaffected and other \
         registries may serve this content"
    )]
    HiddenByOperator,
    #[error("this feature is not enabled on this instance: {reason}")]
    NotConfigured { reason: &'static str },
    #[error(
        "the registry's pending-upload pool is at capacity; retry in a few minutes          (bundles that are never minted get swept)"
    )]
    UploadPoolFull,
    #[error("admin authentication failed")]
    AdminUnauthorized,
}

impl ApiError {
    fn status(&self) -> StatusCode {
        match self {
            Self::Validation(_) => StatusCode::BAD_REQUEST,
            Self::NotFound { .. } => StatusCode::NOT_FOUND,
            Self::ReadOnly => StatusCode::FORBIDDEN,
            Self::HiddenByOperator => StatusCode::GONE,
            Self::NotConfigured { .. } => StatusCode::SERVICE_UNAVAILABLE,
            Self::UploadPoolFull => StatusCode::TOO_MANY_REQUESTS,
            Self::AdminUnauthorized => StatusCode::NOT_FOUND,
            Self::Chain(chain_error) => match chain_error {
                ChainError::Rejected { .. } => StatusCode::UNPROCESSABLE_ENTITY,
                ChainError::UnknownAsset(_) => StatusCode::NOT_FOUND,
                ChainError::AssetFinalized(_) => StatusCode::CONFLICT,
                ChainError::InsufficientFunds { .. } => StatusCode::UNPROCESSABLE_ENTITY,
                ChainError::InvalidRecipient { .. } => StatusCode::BAD_REQUEST,
                ChainError::Unavailable { .. } => StatusCode::SERVICE_UNAVAILABLE,
            },
        }
    }

    /// Stable identifier slug for the problem `type` URI.
    fn slug(&self) -> &'static str {
        match self {
            Self::Validation(_) => "validation",
            Self::NotFound { .. } => "not-found",
            Self::ReadOnly => "read-only-mode",
            Self::HiddenByOperator => "hidden-by-operator",
            Self::NotConfigured { .. } => "not-configured",
            Self::UploadPoolFull => "upload-pool-full",
            // 404 on purpose: with no token configured (or a wrong one),
            // the admin surface is indistinguishable from absent.
            Self::AdminUnauthorized => "not-found",
            Self::Chain(chain_error) => match chain_error {
                ChainError::Rejected { .. } => "rejected-by-node",
                ChainError::UnknownAsset(_) => "unknown-asset",
                ChainError::AssetFinalized(_) => "asset-finalized",
                ChainError::InsufficientFunds { .. } => "insufficient-funds",
                ChainError::InvalidRecipient { .. } => "invalid-recipient",
                ChainError::Unavailable { .. } => "node-unavailable",
            },
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let status = self.status();
        // 5xx details could leak infrastructure internals; log them and keep
        // the response generic. 4xx details are for the caller by design.
        let detail = if status.is_server_error() {
            tracing::error!(error = %self, "chain backend failure");
            "upstream node is unavailable; retry later".to_owned()
        } else {
            self.to_string()
        };

        let body = ProblemDetails {
            r#type: format!("https://cachetzec.com/problems/{}", self.slug()),
            title: status.canonical_reason().unwrap_or("Error").to_owned(),
            status: status.as_u16(),
            detail,
        };
        (
            status,
            [(header::CONTENT_TYPE, "application/problem+json")],
            Json(body),
        )
            .into_response()
    }
}
