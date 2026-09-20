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
    if let Some(name) = foreign_json_name(description) {
        return (name, NameSource::FreeText);
    }
    (description.to_owned(), NameSource::FreeText)
}

/// Longest name taken from a foreign JSON description, in characters.
const MAX_FOREIGN_NAME_CHARS: usize = 120;

/// The `name` of a description that is a JSON object in somebody else's
/// format. Still an issuer-chosen, unverified label (the caller keeps it
/// `FreeText`): showing the whole document as the name helps nobody, and
/// the raw description stays available for the identity check. Control
/// and bidirectional-override characters are dropped, since this string
/// is attacker-authored and ends up in listings.
fn foreign_json_name(description: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(description).ok()?;
    let name = value.as_object()?.get("name")?.as_str()?;
    let clean: String = name
        .trim()
        .chars()
        .filter(|c| {
            !c.is_control()
                && !matches!(c, '\u{200E}' | '\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}')
        })
        .take(MAX_FOREIGN_NAME_CHARS)
        .collect();
    (!clean.trim().is_empty()).then(|| clean.trim().to_owned())
}

#[cfg(test)]
mod name_tests {
    use super::*;

    #[test]
    fn a_foreign_json_description_shows_its_name_as_an_unverified_label() {
        let description =
            r#"{"v":1,"name":"Sample Pass #7","standard":"SAMPLE-1","tokenId":"0007"}"#;
        assert_eq!(
            display_name_for(description),
            ("Sample Pass #7".to_owned(), NameSource::FreeText)
        );
    }

    #[test]
    fn json_without_a_usable_name_stays_raw() {
        for description in [
            r#"{"title":"x"}"#,
            r#"{"name":"   "}"#,
            r#"{"name":42}"#,
            r#"["name"]"#,
        ] {
            assert_eq!(
                display_name_for(description),
                (description.to_owned(), NameSource::FreeText)
            );
        }
    }

    #[test]
    fn foreign_names_are_bounded_and_stripped_of_override_characters() {
        let long = format!(r#"{{"name":"{}"}}"#, "a".repeat(500));
        assert_eq!(
            display_name_for(&long).0.chars().count(),
            MAX_FOREIGN_NAME_CHARS
        );
        let tricky = "{\"name\":\"safe\u{202E}evil\"}";
        assert_eq!(display_name_for(tricky).0, "safeevil");
    }

    #[test]
    fn a_real_envelope_still_wins() {
        let text = ChainDescription::compose("Zcon Ticket", &"ab".repeat(32)).unwrap();
        assert_eq!(
            display_name_for(&text),
            ("Zcon Ticket".to_owned(), NameSource::Envelope)
        );
    }
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
