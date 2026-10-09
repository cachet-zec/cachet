//! Wire types (DTOs) for the HTTP API.
//!
//! These are the API contract: they change only with intent, never as a side
//! effect of domain or protocol refactors. Conversions to and from
//! `cachet-domain` types happen here and nowhere else.

use cachet_chain::ChainInfo;
use cachet_domain::{DomainError, IssuanceReceipt, IssuanceRequest, Recipient, TxId};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

/// The Orchard note commitment tree after a block: where a wallet created
/// at that block starts reading the chain.
#[derive(Debug, Serialize, ToSchema)]
pub struct OrchardTreeResponse {
    /// The block the tree stands after (the current tip when asked).
    pub height: u64,
    /// The tree's frontier, hex, in zcashd's `CommitmentTree` encoding
    /// (as `z_gettreestate` reports it).
    pub final_state: String,
    /// The tree's root, hex, when the node reports it.
    pub final_root: Option<String>,
}

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

/// One issue action of a decoded transaction.
#[derive(Debug, Serialize, ToSchema)]
pub struct DecodedIssueActionResponse {
    pub asset_id: String,
    /// ZIP 227 description hash, hex; absent when the backend cannot see it.
    pub asset_desc_hash: Option<String>,
    /// Issue notes in the action, the reference note included.
    pub notes: u32,
    /// Units issued by this action (the reference note carries zero).
    pub amount: u64,
    /// Whether this action seals the asset's supply.
    pub finalize: bool,
    /// Whether the action carries the reference note of a first issuance.
    pub reference_note: bool,
}

/// The issuance bundle of a decoded transaction.
#[derive(Debug, Serialize, ToSchema)]
pub struct DecodedIssuanceResponse {
    /// Issuance validating key, ZIP 227 canonical encoding, hex.
    pub issuer: String,
    pub actions: Vec<DecodedIssueActionResponse>,
}

/// Units of one asset burned in the open.
#[derive(Debug, Serialize, ToSchema)]
pub struct DecodedBurnResponse {
    pub asset_id: String,
    pub amount: u64,
}

/// What a transaction publishes about ZSAs. Transfers stay encrypted:
/// only their action count is visible.
#[derive(Debug, Serialize, ToSchema)]
pub struct DecodedTransactionResponse {
    pub txid: String,
    /// Height of the block holding it; null while it waits in the mempool.
    pub height: Option<u64>,
    /// Transaction format version (6 for OrchardZSA).
    pub version: u32,
    pub issuance: Option<DecodedIssuanceResponse>,
    pub burns: Vec<DecodedBurnResponse>,
    pub orchard_actions: u32,
    pub transparent_inputs: u32,
    pub transparent_outputs: u32,
    pub sapling_spends: u32,
    pub sapling_outputs: u32,
    /// The swap board offer this transaction filled, when it filled one on
    /// this registry: the offer's terms were public on the board, and the
    /// link is recorded only once the chain holds the very transaction the
    /// maker countersigned.
    pub swap: Option<SwapFillResponse>,
}

/// A board offer a transaction filled.
#[derive(Debug, Serialize, ToSchema)]
pub struct SwapFillResponse {
    pub offer_id: String,
    pub give_asset: String,
    pub give_amount: u64,
    pub want_asset: String,
    pub want_amount: u64,
}

impl From<cachet_index::SwapFill> for SwapFillResponse {
    fn from(fill: cachet_index::SwapFill) -> Self {
        Self {
            offer_id: fill.offer_id,
            give_asset: hex::encode(fill.give_asset),
            give_amount: fill.give_amount,
            want_asset: hex::encode(fill.want_asset),
            want_amount: fill.want_amount,
        }
    }
}

impl From<cachet_domain::DecodedTransaction> for DecodedTransactionResponse {
    fn from(tx: cachet_domain::DecodedTransaction) -> Self {
        Self {
            txid: tx.txid.to_string(),
            height: tx.height,
            version: tx.version,
            issuance: tx.issuance.map(|issuance| DecodedIssuanceResponse {
                issuer: issuance.issuer,
                actions: issuance
                    .actions
                    .into_iter()
                    .map(|action| DecodedIssueActionResponse {
                        asset_id: action.asset_id.to_string(),
                        asset_desc_hash: action.asset_desc_hash,
                        notes: action.notes,
                        amount: action.amount,
                        finalize: action.finalize,
                        reference_note: action.reference_note,
                    })
                    .collect(),
            }),
            burns: tx
                .burns
                .into_iter()
                .map(|burn| DecodedBurnResponse {
                    asset_id: burn.asset_id.to_string(),
                    amount: burn.amount,
                })
                .collect(),
            orchard_actions: tx.orchard_actions,
            transparent_inputs: tx.transparent_inputs,
            transparent_outputs: tx.transparent_outputs,
            sapling_spends: tx.sapling_spends,
            sapling_outputs: tx.sapling_outputs,
            swap: None,
        }
    }
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

/// Request body for resolving an asset's description.
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

/// Sealed content this registry still holds for an asset the chain it
/// follows no longer carries (a reset test network takes its assets with
/// it). No supply, no issuer: those were chain facts and went with the
/// chain. What is left is what the asset id commits to, so minting it again
/// under the same key gives the same asset id.
#[derive(Debug, Serialize, ToSchema)]
pub struct KeptAssetResponse {
    /// Asset id (hex-encoded 32 bytes) the description was journaled under.
    pub asset_id: String,
    /// The asset description as it was: for a Cachet asset, the v1
    /// envelope naming the sealed bundle.
    pub description: String,
    pub display_name: String,
    /// `envelope` or `free_text`, as on a listed asset.
    #[schema(example = "envelope")]
    pub name_source: String,
    /// Server-relative path to the sealed image, when the bundle is still
    /// held and embeds one.
    pub image_path: Option<String>,
}

impl From<AssetSummaryResponse> for KeptAssetResponse {
    fn from(summary: AssetSummaryResponse) -> Self {
        Self {
            asset_id: summary.asset_id,
            description: summary.description.unwrap_or_default(),
            display_name: summary.display_name.unwrap_or_default(),
            name_source: summary.name_source.unwrap_or_default(),
            image_path: summary.image_path,
        }
    }
}

/// The public record of one asset: a registry listing row, and also the
/// full response of the single-asset endpoint.
#[derive(Debug, Serialize, ToSchema)]
pub struct AssetSummaryResponse {
    /// Asset id (hex-encoded 32 bytes).
    pub asset_id: String,
    /// Raw asset description, when known. The chain only stores the
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
    /// Height of the latest public event (issuance, burn or seal), when
    /// known. Shielded transfers never count.
    pub last_height: Option<u64>,
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
            last_height: summary.last_height,
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
    /// Ready-to-use asset description (`{"v":1,"name":…,"sha256":…}`).
    pub chain_description: String,
}
