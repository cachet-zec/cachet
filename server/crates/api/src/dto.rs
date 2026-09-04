//! Wire types (DTOs) for the HTTP API.
//!
//! These are the API contract: they change only with intent, never as a side
//! effect of domain or protocol refactors. Conversions to and from
//! `cachet-domain` types happen here and nowhere else.

use cachet_chain::ChainInfo;
use cachet_domain::{DomainError, IssuanceReceipt, IssuanceRequest, Recipient, TxId};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

/// Connected network, chain tip, and deployment mode.
#[derive(Debug, Serialize, ToSchema)]
pub struct ChainInfoResponse {
    /// Network name, e.g. `regtest`, `zsa-testnet`, `in-memory`.
    #[schema(example = "regtest")]
    pub network: String,
    /// Chain tip height as seen by the node.
    pub tip_height: u64,
    /// When true, the wallet-signing endpoints (mint, batch mint,
    /// transfer, burn, wallet) answer 403 — a public read-only
    /// deployment. Relay, description resolution and metadata upload stay
    /// open: they need no key from this instance.
    pub read_only: bool,
    /// When true, the operator has paused minting through this instance:
    /// the relay and metadata uploads answer 503 until it is lifted. The
    /// chain itself is unaffected.
    pub mints_paused: bool,
    /// Ed25519 public key (hex) that signs this instance's registry
    /// snapshots; absent when snapshots are not enabled. Compare it to
    /// the operator's out-of-band publications (working paper, posts)
    /// before trusting a mirror.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub snapshot_public_key: Option<String>,
}

impl ChainInfoResponse {
    pub fn from_info(
        info: ChainInfo,
        read_only: bool,
        mints_paused: bool,
        snapshot_public_key: Option<String>,
    ) -> Self {
        Self {
            network: info.network,
            tip_height: info.tip_height,
            read_only,
            mints_paused,
            snapshot_public_key,
        }
    }
}

/// One block's raw transactions, hex-encoded, consensus order.
#[derive(Debug, Serialize, ToSchema)]
pub struct RawBlockResponse {
    pub height: u64,
    /// Every transaction of the block (coinbase included), raw hex. Order
    /// matters: client-side note scanning must append commitments in
    /// exactly this order.
    pub txs: Vec<String>,
}

/// A page of raw blocks for client-side note scanning. Public chain data,
/// identical for every caller: browsers scan for their own notes locally
/// and never tell the server which notes are theirs.
#[derive(Debug, Serialize, ToSchema)]
pub struct RawBlocksResponse {
    /// Chain tip at the time of the call: fetch until `height == tip_height`.
    pub tip_height: u64,
    pub blocks: Vec<RawBlockResponse>,
}

impl RawBlocksResponse {
    pub fn from_chain(raw: cachet_chain::RawBlocks) -> Self {
        Self {
            tip_height: raw.tip_height,
            blocks: raw
                .blocks
                .into_iter()
                .map(|block| RawBlockResponse {
                    height: block.height,
                    txs: block.txs,
                })
                .collect(),
        }
    }
}

/// One asset held by a wallet account.
#[derive(Debug, Serialize, ToSchema)]
pub struct HoldingResponse {
    pub asset_id: String,
    pub amount: u64,
}

/// Spendable balances of one wallet account.
#[derive(Debug, Serialize, ToSchema)]
pub struct AccountBalancesResponse {
    pub account: u32,
    pub holdings: Vec<HoldingResponse>,
}

impl From<cachet_domain::AccountBalances> for AccountBalancesResponse {
    fn from(balances: cachet_domain::AccountBalances) -> Self {
        Self {
            account: balances.account,
            holdings: balances
                .holdings
                .into_iter()
                .map(|holding| HoldingResponse {
                    asset_id: holding.asset_id.to_string(),
                    amount: holding.amount,
                })
                .collect(),
        }
    }
}

/// One public event of an asset's life. Transfers are shielded and never
/// listed.
#[derive(Debug, Serialize, ToSchema)]
pub struct AssetEventResponse {
    pub height: u64,
    pub txid: String,
    /// `issuance`, `burn`, or `finalization`.
    #[schema(example = "issuance")]
    pub kind: String,
    /// Units issued or burned; zero for finalization.
    pub amount: u64,
}

impl From<cachet_domain::AssetEvent> for AssetEventResponse {
    fn from(event: cachet_domain::AssetEvent) -> Self {
        Self {
            height: event.height,
            txid: event.txid.to_string(),
            kind: match event.kind {
                cachet_domain::AssetEventKind::Issuance => "issuance",
                cachet_domain::AssetEventKind::Burn => "burn",
                cachet_domain::AssetEventKind::Finalization => "finalization",
            }
            .to_owned(),
            amount: event.amount,
        }
    }
}

/// Request body for issuing units of an asset.
#[derive(Debug, Deserialize, ToSchema)]
pub struct IssueAssetRequest {
    /// Asset description (1–512 bytes). Immutable once first issued: together
    /// with the issuer key it determines the on-chain asset id.
    #[schema(example = "Cachet Demo Ticket", min_length = 1, max_length = 512)]
    pub description: String,
    /// Units to issue; must be greater than zero.
    #[schema(example = 1000, minimum = 1)]
    pub amount: u64,
    /// Permanently disable further issuance after this transaction.
    #[serde(default)]
    pub finalize: bool,
}

impl TryFrom<IssueAssetRequest> for IssuanceRequest {
    type Error = DomainError;

    fn try_from(request: IssueAssetRequest) -> Result<Self, Self::Error> {
        let description = cachet_domain::AssetDescription::new(request.description)?;
        IssuanceRequest::new(description, request.amount, request.finalize)
    }
}

/// Request body for minting several assets in one transaction.
#[derive(Debug, Deserialize, ToSchema)]
pub struct BatchIssueRequest {
    /// 1–16 items, no duplicate descriptions. The whole batch lands in one
    /// issuance bundle: one transaction, one txid, all-or-nothing.
    pub items: Vec<IssueAssetRequest>,
}

impl BatchIssueRequest {
    pub fn into_requests(self) -> Result<Vec<IssuanceRequest>, DomainError> {
        let requests = self
            .items
            .into_iter()
            .map(IssuanceRequest::try_from)
            .collect::<Result<Vec<_>, _>>()?;
        cachet_domain::asset::validate_issuance_batch(&requests)?;
        Ok(requests)
    }
}

/// Result of an accepted batch issuance.
#[derive(Debug, Serialize, ToSchema)]
pub struct BatchIssueResponse {
    /// The single transaction that minted every asset in the batch.
    pub txid: String,
    /// Minted asset ids, in request order.
    pub asset_ids: Vec<String>,
}

/// Request body for resolving an asset's on-chain description.
///
/// Permissionless by design: the chain stores only the description hash
/// (ZIP 227), so a preimage either matches the commitment or is rejected —
/// the registry cannot be lied to. This is how assets issued by *other*
/// parties gain names here.
#[derive(Debug, Deserialize, ToSchema)]
pub struct ResolveDescriptionRequest {
    /// The plaintext asset description (1–512 bytes).
    #[schema(example = "Testnet Sample", min_length = 1, max_length = 512)]
    pub description: String,
}

/// Result of an accepted issuance.
#[derive(Debug, Serialize, ToSchema)]
pub struct IssueAssetResponse {
    /// Transaction id (hex, display order). Acceptance, not finality.
    pub txid: String,
    /// Id of the minted asset — use it with `GET /api/v1/assets/{asset_id}`.
    pub asset_id: String,
}

impl From<IssuanceReceipt> for IssueAssetResponse {
    fn from(receipt: IssuanceReceipt) -> Self {
        Self {
            txid: receipt.txid.to_string(),
            asset_id: receipt.asset_id.to_string(),
        }
    }
}

/// Request body for transferring units of an asset from the wallet.
#[derive(Debug, Deserialize, ToSchema)]
pub struct TransferAssetRequest {
    /// Units to move; must be greater than zero.
    #[schema(example = 25, minimum = 1)]
    pub amount: u64,
    /// Destination: a unified address with an Orchard receiver, or
    /// `account:N` for one of the wallet's own accounts (demo convenience).
    #[schema(example = "account:1")]
    pub recipient: String,
}

impl TransferAssetRequest {
    /// Parse the recipient shorthand into the domain representation.
    pub fn recipient(&self) -> Result<Recipient, DomainError> {
        if let Some(account) = self.recipient.strip_prefix("account:") {
            let account = account
                .parse::<u32>()
                .map_err(|_| DomainError::InvalidRecipient)?;
            return Ok(Recipient::Internal { account });
        }
        if self.recipient.trim().is_empty() {
            return Err(DomainError::InvalidRecipient);
        }
        Ok(Recipient::External {
            address: self.recipient.clone(),
        })
    }
}

/// Request body for burning units of an asset from the wallet.
#[derive(Debug, Deserialize, ToSchema)]
pub struct BurnAssetRequest {
    /// Units to permanently destroy; must be greater than zero.
    #[schema(example = 10, minimum = 1)]
    pub amount: u64,
}

/// Request body for relaying a browser-built, fully signed transaction.
///
/// The instance signs nothing: the transaction was built, proven and
/// signed in the sender's browser (see the mint engine). The relay can
/// refuse, never alter. Available on read-only deployments — the whole
/// point is that the server holds no keys.
#[derive(Debug, Deserialize, ToSchema)]
pub struct RelayRequest {
    /// Complete signed v6 transaction, hex-encoded.
    pub tx_hex: String,
}

/// A transaction accepted by the chain.
#[derive(Debug, Serialize, ToSchema)]
pub struct TxResponse {
    /// Transaction id (hex, display order). Acceptance, not finality.
    pub txid: String,
}

impl From<TxId> for TxResponse {
    fn from(txid: TxId) -> Self {
        Self {
            txid: txid.to_string(),
        }
    }
}

/// The public record of one asset: a registry listing row, and also the
/// full response of the single-asset endpoint.
#[derive(Debug, Serialize, ToSchema)]
pub struct AssetSummaryResponse {
    /// Asset id (hex-encoded 32 bytes).
    pub asset_id: String,
    /// Raw chain description, when known. The chain only stores the
    /// description hash, so this is present only for assets issued through
    /// this instance (local journal).
    pub description: Option<String>,
    /// Safest human-readable name derived from the description: the sealed
    /// envelope name or the raw free text. Render it according to
    /// `name_source`.
    pub display_name: Option<String>,
    /// Where `display_name` comes from — `envelope` (sealed into the asset
    /// id) or `free_text` (issuer-chosen, unverified label). Anti-phishing:
    /// clients must not present a name without its provenance.
    #[schema(example = "envelope")]
    pub name_source: Option<String>,
    /// Server-relative path to the asset's image (serve from the API
    /// origin), when a stored metadata bundle embeds one.
    pub image_path: Option<String>,
    /// The issuance validating key that minted this asset (ZIP 227
    /// canonical encoding, lowercase hex). The chain's only provenance
    /// statement: assets sharing this key share an issuer.
    pub issuer: Option<String>,
    pub total_supply: u64,
    pub finalized: bool,
}

impl From<cachet_domain::AssetSummary> for AssetSummaryResponse {
    fn from(summary: cachet_domain::AssetSummary) -> Self {
        let named = summary
            .description
            .as_deref()
            .map(cachet_domain::display_name_for);
        let (display_name, name_source) = match named {
            Some((name, source)) => (
                Some(name),
                Some(
                    match source {
                        cachet_domain::NameSource::Envelope => "envelope",
                        cachet_domain::NameSource::FreeText => "free_text",
                    }
                    .to_owned(),
                ),
            ),
            None => (None, None),
        };
        Self {
            asset_id: summary.asset_id.to_string(),
            description: summary.description,
            display_name,
            name_source,
            image_path: None, // filled by the handler when a bundle exists
            issuer: summary.issuer,
            total_supply: summary.total_supply,
            finalized: summary.finalized,
        }
    }
}

/// A chain-level collection: every asset minted under one issuance key.
#[derive(Debug, Serialize, ToSchema)]
pub struct CollectionResponse {
    /// Issuance validating key, ZIP 227 canonical encoding, lowercase hex.
    pub issuer: String,
    pub asset_count: u64,
    /// Sum of the circulating supplies of the issuer's assets.
    pub total_supply: u64,
    /// How many of the issuer's assets are finalized.
    pub finalized_count: u64,
}

impl From<cachet_domain::CollectionSummary> for CollectionResponse {
    fn from(summary: cachet_domain::CollectionSummary) -> Self {
        Self {
            issuer: summary.issuer,
            asset_count: summary.asset_count,
            total_supply: summary.total_supply,
            finalized_count: summary.finalized_count,
        }
    }
}

/// Request body for registering a metadata bundle before issuance.
#[derive(Debug, Deserialize, ToSchema)]
pub struct MetadataUploadRequest {
    /// Display name (1–120 bytes); becomes part of the immutable on-chain
    /// description.
    #[schema(example = "Zcon Ticket 2027", min_length = 1, max_length = 120)]
    pub name: String,
    /// Long-form description (≤ 4096 bytes), stored in the bundle only.
    pub description: Option<String>,
    /// Embedded image as a base64 data URI (png/jpeg/webp/gif, ≤ ~400 KB).
    pub image_data_uri: Option<String>,
    /// Optional issuer link.
    #[schema(example = "https://example.com")]
    pub external_url: Option<String>,
}

/// Result of a metadata upload: the bundle hash and the exact description
/// string to use at issuance (which binds the bundle to the asset forever).
#[derive(Debug, Serialize, ToSchema)]
pub struct MetadataUploadResponse {
    /// SHA-256 of the stored bundle bytes, hex-encoded.
    pub sha256: String,
    /// Ready-to-use on-chain description (`{"v":1,"name":…,"sha256":…}`).
    pub chain_description: String,
}
