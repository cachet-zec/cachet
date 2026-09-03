//! Pure business types for Cachet, an issuance console for Zcash Shielded
//! Assets (ZSA / OrchardZSA).
//!
//! This crate is deliberately free of chain, database, and framework
//! dependencies: everything here is testable without a node and stable across
//! upstream protocol churn. Chain-facing conversions live in `cachet-chain`;
//! HTTP DTOs live in `cachet-api`.

pub mod asset;
pub mod id;
pub mod metadata;

pub use asset::{
    AccountBalances, AssetDescription, AssetEvent, AssetEventKind, AssetState, AssetSummary,
    BurnRequest, CollectionSummary, Holding, IssuanceReceipt, IssuanceRequest, Recipient,
    TransferRequest,
};
pub use id::{AssetId, TxId};
pub use metadata::{ChainDescription, MetadataBundle};

/// Where a display name came from — clients must render names differently
/// depending on how much the chain vouches for them (anti-phishing: a name
/// is never shown without its provenance).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NameSource {
    /// Cachet v1 envelope: the name is sealed (via the bundle hash) into
    /// the asset id itself.
    Envelope,
    /// Free-text on-chain description: issuer-chosen, no format, display
    /// only as an unverified label.
    FreeText,
}

/// Derive the safest display name for a chain description, with its
/// provenance. Returns `None` only for a missing description.
pub fn display_name_for(description: &str) -> (String, NameSource) {
    if let Some(envelope) = ChainDescription::parse(description) {
        return (envelope.name, NameSource::Envelope);
    }
    (description.to_owned(), NameSource::FreeText)
}

/// Errors produced by domain validation rules.
///
/// These are user-facing by design: every variant message must make sense to
/// an API consumer without knowledge of protocol internals.
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum DomainError {
    #[error("asset description must not be empty")]
    EmptyAssetDescription,

    #[error("asset description must be at most {max} bytes, got {actual}")]
    AssetDescriptionTooLong { max: usize, actual: usize },

    #[error("issuance amount must be greater than zero")]
    ZeroIssuanceAmount,

    #[error("{operation} amount must be greater than zero")]
    ZeroAmount { operation: &'static str },

    #[error("invalid {kind} identifier: expected {expected} hex characters")]
    InvalidId { kind: &'static str, expected: usize },

    #[error("recipient must be a shielded address or `account:N`")]
    InvalidRecipient,

    #[error("invalid metadata: {reason}")]
    InvalidMetadata { reason: &'static str },

    #[error("batch must contain between 1 and {max} items")]
    InvalidBatchSize { max: usize },

    #[error("batch contains duplicate asset descriptions")]
    DuplicateBatchDescription,
}
