//! Chain access layer for Cachet.
//!
//! This crate owns every interaction with the Zcash chain (regtest, the
//! public ZSA testnet, and eventually mainnet). It is the only crate in the
//! workspace allowed to depend on the QED-it protocol forks; `cachet-domain`
//! and `cachet-api` must compile and pass their tests without a node and
//! without those alpha dependencies (ADR-001).
//!
//! The [`ChainBackend`] trait is the boundary: `cachet-api` consumes it, and
//! implementations live here. [`memory::InMemoryChain`] is a deterministic
//! test double; the OrchardZSA implementation backed by the QEDIT stack
//! arrives with milestone C.

pub mod memory;
pub mod zsa;

/// Build (and cache, process-wide) the Orchard ZSA proving key so the
/// first mint of this process does not pay for it. Costs seconds of CPU;
/// call it from a background thread at boot on instances that sign
/// (read-only deployments never prove and should skip it). The cache
/// itself lives in the vendored zcash_primitives patch
/// (server/vendor/librustzcash/README.md).
pub fn prepare_proving() {
    zcash_primitives::transaction::builder::prepare_orchard_zsa_proving_key();
}

use async_trait::async_trait;
use cachet_domain::{
    AccountBalances, AssetEvent, AssetId, AssetSummary, BurnRequest, CollectionSummary,
    IssuanceReceipt, IssuanceRequest, TransferRequest, TxId,
};

/// Errors surfaced by chain backends.
#[derive(Debug, thiserror::Error)]
pub enum ChainError {
    /// The node rejected the transaction or request as invalid.
    #[error("rejected by node: {reason}")]
    Rejected { reason: String },

    /// The asset does not exist on the chain this backend is connected to.
    #[error("unknown asset: {0}")]
    UnknownAsset(AssetId),

    /// Further issuance was attempted on a finalized asset.
    #[error("asset {0} is finalized; no further issuance is allowed")]
    AssetFinalized(AssetId),

    /// The wallet does not hold enough spendable units of the asset.
    #[error("insufficient funds: needed {needed}, spendable {available}")]
    InsufficientFunds { needed: u64, available: u64 },

    /// The recipient could not be resolved to a valid shielded address.
    #[error("invalid recipient: {reason}")]
    InvalidRecipient { reason: String },

    /// The node is unreachable or misbehaving; retrying later may succeed.
    #[error("node unavailable: {reason}")]
    Unavailable { reason: String },
}

/// Description of the chain a backend is connected to, for display and
/// safety interlocks (the console refuses value-bearing actions when the
/// network is not the expected one).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChainInfo {
    /// Human-readable network name, e.g. `regtest` or `zsa-testnet`.
    pub network: String,
    /// Current chain tip height as seen by the node.
    pub tip_height: u64,
}

/// The single boundary between Cachet and the Zcash chain.
///
/// Implementations must be safe to share across request handlers
/// (`Send + Sync`) and must map every failure into a [`ChainError`] variant
/// that callers can act on.
#[async_trait]
pub trait ChainBackend: Send + Sync {
    /// Identify the connected network and its tip.
    async fn chain_info(&self) -> Result<ChainInfo, ChainError>;

    /// Submit an issuance transaction. The receipt carries the txid and the
    /// minted asset's id. Acceptance is not finality.
    async fn issue(&self, request: IssuanceRequest) -> Result<IssuanceReceipt, ChainError>;

    /// Mint several assets in ONE transaction: a single issuance bundle
    /// carrying one action per request, under one authorizing signature
    /// (standard ZIP 227 batching). Receipts come back in request order and
    /// share a txid. Callers validate the batch shape via
    /// [`cachet_domain::asset::validate_issuance_batch`].
    async fn issue_batch(
        &self,
        requests: Vec<IssuanceRequest>,
    ) -> Result<Vec<IssuanceReceipt>, ChainError>;

    /// Record the plaintext description of an asset observed on chain,
    /// after verifying it hashes to the on-chain commitment (ZIP 227
    /// assetDescHash). Permissionless by design: the chain only stores the
    /// hash, so a matching preimage is definitionally correct and the
    /// registry cannot be lied to. Rejects on mismatch.
    async fn resolve_description(
        &self,
        asset_id: AssetId,
        description: &str,
    ) -> Result<(), ChainError>;

    /// Read the current on-chain state of one asset, with its journaled
    /// description when this instance knows it (same shape as a `list_assets`
    /// row, so detail lookups need no second query).
    async fn asset_state(&self, asset_id: AssetId) -> Result<AssetSummary, ChainError>;

    /// List every asset observed on the chain, most recently created first.
    async fn list_assets(&self) -> Result<Vec<AssetSummary>, ChainError>;

    /// Chain-level collections: assets grouped by issuance key (the only
    /// provenance statement the chain itself makes), largest first.
    async fn collections(&self) -> Result<Vec<CollectionSummary>, ChainError>;

    /// Spendable balances of the wallet's tracked accounts (empty holdings
    /// omitted).
    async fn wallet_balances(&self) -> Result<Vec<AccountBalances>, ChainError>;

    /// Public events of an asset's life (issuances, burns, finalization),
    /// oldest first. Transfers are shielded and never listed.
    async fn asset_events(&self, asset_id: AssetId) -> Result<Vec<AssetEvent>, ChainError>;

    /// Move units of an asset from the wallet to a recipient.
    async fn transfer(&self, request: TransferRequest) -> Result<TxId, ChainError>;

    /// Permanently destroy units of an asset held by the wallet.
    async fn burn(&self, request: BurnRequest) -> Result<TxId, ChainError>;

    /// Relay a fully signed transaction built elsewhere (the browser mint
    /// engine) to the chain. The instance signs nothing and can refuse to
    /// relay, but never alter: acceptance is the chain's decision. Only
    /// shielded-protocol transactions are accepted (issuance bundles, and
    /// Orchard transfer/burn bundles) — this is a ZSA relay, not a general
    /// broadcast service. The receipt reports what the relayed bytes
    /// contained (public facts read from the transaction itself), so the
    /// API layer can notify without touching protocol types.
    async fn relay(&self, tx_bytes: Vec<u8>) -> Result<RelayReceipt, ChainError>;

    /// Raw transactions of a block range, in consensus order (every
    /// transaction of every block, coinbase included). Public chain data,
    /// identical for every caller: browser wallets fetch this to scan for
    /// their own notes locally — the server never learns which notes are
    /// theirs (PRIVACY.md).
    async fn raw_transactions(
        &self,
        start_height: u64,
        limit: u64,
    ) -> Result<RawBlocks, ChainError>;
}

/// What a relayed transaction contained — public facts read from the
/// signed bytes, so callers (webhooks, logs) never parse protocol types.
#[derive(Debug, Clone)]
pub struct RelayReceipt {
    pub txid: TxId,
    /// Asset ids minted by the transaction's issuance bundle, if any
    /// (empty for pure transfers/burns).
    pub issued_assets: Vec<AssetId>,
}

/// A page of raw blocks for client-side scanning.
#[derive(Debug, Clone)]
pub struct RawBlocks {
    /// Chain tip at the time of the call, so clients know when to stop.
    pub tip_height: u64,
    pub blocks: Vec<RawBlock>,
}

/// One block's transactions, consensus order, hex-encoded.
#[derive(Debug, Clone)]
pub struct RawBlock {
    pub height: u64,
    pub txs: Vec<String>,
}
