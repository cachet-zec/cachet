//! Asset issuance requests and observed asset state.

use serde::{Deserialize, Serialize};

use crate::{AssetId, DomainError};

/// Maximum byte length of an asset description, per ZIP 227.
///
/// The description participates in the derivation of the on-chain asset id,
/// so it is immutable once the first issuance transaction is mined.
pub const MAX_ASSET_DESCRIPTION_BYTES: usize = 512;

/// A validated ZSA asset description.
///
/// Invariants: non-empty, at most [`MAX_ASSET_DESCRIPTION_BYTES`] bytes.
/// Construction is only possible through [`AssetDescription::new`], so any
/// value of this type is known-valid.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(transparent)]
pub struct AssetDescription(String);

impl AssetDescription {
    pub fn new(description: impl Into<String>) -> Result<Self, DomainError> {
        let description = description.into();
        if description.is_empty() {
            return Err(DomainError::EmptyAssetDescription);
        }
        let actual = description.len();
        if actual > MAX_ASSET_DESCRIPTION_BYTES {
            return Err(DomainError::AssetDescriptionTooLong {
                max: MAX_ASSET_DESCRIPTION_BYTES,
                actual,
            });
        }
        Ok(Self(description))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl<'de> Deserialize<'de> for AssetDescription {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let s = String::deserialize(deserializer)?;
        Self::new(s).map_err(serde::de::Error::custom)
    }
}

/// A request to issue units of an asset.
///
/// Issuing under a description that has no prior issuance creates the asset;
/// issuing again under the same description (before finalization) increases
/// its supply.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct IssuanceRequest {
    /// Immutable description; determines the asset id together with the
    /// issuer key.
    pub description: AssetDescription,
    /// Number of units to issue. Must be non-zero (validated by
    /// [`IssuanceRequest::new`]).
    pub amount: u64,
    /// When true, no further issuance of this asset is allowed after this
    /// transaction (ZIP 227 finalization).
    pub finalize: bool,
}

impl IssuanceRequest {
    pub fn new(
        description: AssetDescription,
        amount: u64,
        finalize: bool,
    ) -> Result<Self, DomainError> {
        if amount == 0 {
            return Err(DomainError::ZeroIssuanceAmount);
        }
        Ok(Self {
            description,
            amount,
            finalize,
        })
    }
}

/// Maximum items in one batch issuance. Chosen conservatively below
/// transaction size / relay limits (the reference ecosystem batch on the
/// public ZSA testnet carried 10 actions).
pub const MAX_BATCH_ITEMS: usize = 16;

/// Validate the shape of a batch issuance: 1..=[`MAX_BATCH_ITEMS`] items
/// and no duplicate descriptions (one asset id may appear at most once per
/// issuance bundle).
pub fn validate_issuance_batch(requests: &[IssuanceRequest]) -> Result<(), DomainError> {
    if requests.is_empty() || requests.len() > MAX_BATCH_ITEMS {
        return Err(DomainError::InvalidBatchSize {
            max: MAX_BATCH_ITEMS,
        });
    }
    let mut seen = std::collections::HashSet::new();
    for request in requests {
        if !seen.insert(request.description.as_str()) {
            return Err(DomainError::DuplicateBatchDescription);
        }
    }
    Ok(())
}

/// Where transferred units should land.
///
/// The domain stays protocol-agnostic: an external address is an opaque
/// string validated by the chain layer (on ZSA that's a unified address
/// with an Orchard receiver); an internal account is an index into the
/// wallet's own derivation (demo/testing convenience).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Recipient {
    Internal { account: u32 },
    External { address: String },
}

/// A request to move units of an asset to a recipient.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TransferRequest {
    pub asset_id: AssetId,
    /// Units to move; must be non-zero.
    pub amount: u64,
    pub recipient: Recipient,
}

impl TransferRequest {
    pub fn new(asset_id: AssetId, amount: u64, recipient: Recipient) -> Result<Self, DomainError> {
        if amount == 0 {
            return Err(DomainError::ZeroAmount {
                operation: "transfer",
            });
        }
        Ok(Self {
            asset_id,
            amount,
            recipient,
        })
    }
}

/// A request to permanently destroy units of an asset from the issuer's
/// own holdings.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BurnRequest {
    pub asset_id: AssetId,
    /// Units to destroy; must be non-zero.
    pub amount: u64,
}

impl BurnRequest {
    pub fn new(asset_id: AssetId, amount: u64) -> Result<Self, DomainError> {
        if amount == 0 {
            return Err(DomainError::ZeroAmount { operation: "burn" });
        }
        Ok(Self { asset_id, amount })
    }
}

/// What one wallet account holds of one asset.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Holding {
    pub asset_id: AssetId,
    pub amount: u64,
}

/// Spendable balances of one wallet account.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AccountBalances {
    pub account: u32,
    pub holdings: Vec<Holding>,
}

/// A public on-chain event in an asset's life. Transfers never appear
/// here: they are shielded, and their existence is not attributable to any
/// particular asset by design.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AssetEventKind {
    Issuance,
    Burn,
    Finalization,
}

/// One public event, as observed at a block height.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AssetEvent {
    pub asset_id: AssetId,
    pub height: u64,
    pub txid: crate::TxId,
    pub kind: AssetEventKind,
    /// Units issued or burned; zero for finalization-only events.
    pub amount: u64,
}

/// Outcome of an accepted issuance: the transaction that carried it and the
/// asset it minted (derived from issuer key + description per ZIP 227, so it
/// is known as soon as the transaction is built).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct IssuanceReceipt {
    pub txid: crate::TxId,
    pub asset_id: AssetId,
}

/// The state of an asset as observed on chain.
///
/// This is derived data: the chain is the source of truth, and any store of
/// `AssetState` must be reconstructible from it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AssetState {
    pub asset_id: AssetId,
    /// Total units issued so far, net of burns.
    pub total_supply: u64,
    /// Whether further issuance has been permanently disabled.
    pub finalized: bool,
}

/// One row of the asset registry listing.
///
/// The description is optional by nature: the chain only carries the
/// description *hash* (ZIP 227), so the text is known only for assets this
/// instance issued itself (kept in a local journal, re-derivable by the
/// issuer from their own records).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AssetSummary {
    pub asset_id: AssetId,
    pub description: Option<String>,
    /// The issuance validating key that minted this asset, in its ZIP 227
    /// canonical encoding (lowercase hex). `None` when no issuance has been
    /// observed (burn-only sightings).
    pub issuer: Option<String>,
    pub total_supply: u64,
    pub finalized: bool,
}

/// A collection: the set of assets sharing one issuance key. This is the
/// chain-level notion of a collection, and everything in it is exact
/// public chain data.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CollectionSummary {
    /// Issuance validating key, ZIP 227 canonical encoding, lowercase hex.
    pub issuer: String,
    pub asset_count: u64,
    /// Sum of the circulating supplies of the issuer's assets.
    pub total_supply: u64,
    /// How many of the issuer's assets are finalized.
    pub finalized_count: u64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_empty_description() {
        assert_eq!(
            AssetDescription::new(""),
            Err(DomainError::EmptyAssetDescription)
        );
    }

    #[test]
    fn rejects_oversized_description() {
        let too_long = "x".repeat(MAX_ASSET_DESCRIPTION_BYTES + 1);
        assert!(matches!(
            AssetDescription::new(too_long),
            Err(DomainError::AssetDescriptionTooLong { .. })
        ));
    }

    #[test]
    fn accepts_boundary_description() {
        let max = "x".repeat(MAX_ASSET_DESCRIPTION_BYTES);
        assert!(AssetDescription::new(max).is_ok());
    }

    #[test]
    fn rejects_zero_amount_issuance() {
        let description = AssetDescription::new("Test Asset").unwrap();
        assert_eq!(
            IssuanceRequest::new(description, 0, false),
            Err(DomainError::ZeroIssuanceAmount)
        );
    }

    #[test]
    fn deserialization_enforces_validation() {
        let raw = format!("\"{}\"", "x".repeat(MAX_ASSET_DESCRIPTION_BYTES + 1));
        assert!(serde_json::from_str::<AssetDescription>(&raw).is_err());
    }
}
