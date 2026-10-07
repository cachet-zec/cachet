//! What one transaction says about ZSAs, read from its public bytes.
//!
//! Issuance is public by design (ZIP 227): the issuer key, which assets,
//! how many units, and whether the supply is sealed. Burns are public too
//! (ZIP 226). Everything else in an OrchardZSA bundle, which asset moved,
//! how much, to whom, stays encrypted: a decoder can count the actions and
//! say nothing more about them.

use crate::{AssetId, TxId};

/// One issue action: units of one asset, as the chain recorded them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DecodedIssueAction {
    pub asset_id: AssetId,
    /// ZIP 227 description hash, hex. `None` when the backend cannot see it.
    pub asset_desc_hash: Option<String>,
    /// Issue notes in the action, the reference note included.
    pub notes: u32,
    /// Units issued (the reference note carries zero).
    pub amount: u64,
    /// Whether this action seals the asset's supply.
    pub finalize: bool,
    /// Whether the action carries the reference note that marks a first
    /// issuance.
    pub reference_note: bool,
}

/// The issuance bundle of a transaction.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DecodedIssuance {
    /// Issuance validating key, ZIP 227 canonical encoding, hex.
    pub issuer: String,
    pub actions: Vec<DecodedIssueAction>,
}

/// Units of one asset destroyed in the open.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DecodedBurn {
    pub asset_id: AssetId,
    pub amount: u64,
}

/// A transaction's public ZSA content.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DecodedTransaction {
    pub txid: TxId,
    /// Height of the block holding it; `None` while it waits in the mempool.
    pub height: Option<u64>,
    /// Transaction format version (6 for OrchardZSA).
    pub version: u32,
    pub issuance: Option<DecodedIssuance>,
    pub burns: Vec<DecodedBurn>,
    /// Orchard actions. Their assets, values and recipients are encrypted.
    pub orchard_actions: u32,
    pub transparent_inputs: u32,
    pub transparent_outputs: u32,
    pub sapling_spends: u32,
    pub sapling_outputs: u32,
}
