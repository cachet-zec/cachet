//! OrchardZSA chain backend: real issuance against a (regtest) Zebra node
//! running the QEDIT ZSA stack.
//!
//! Flow per issuance (mirrors the reference `zcash_tx_tool` scenarios):
//! 1. build a v6 transaction whose issuance bundle mints the requested
//!    amount (optionally finalizing the asset),
//! 2. assemble a block from the node's `getblocktemplate` and submit it —
//!    the QEDIT regtest has no miner, so the client mines,
//! 3. confirm acceptance by watching the chain tip advance.
//!
//! Asset state is derived by scanning the chain (see [`scan`]).

mod block;
mod keys;
mod rpc;
mod scan;
mod wallet;

pub use keys::generate_seed_phrase;

use async_trait::async_trait;
use cachet_domain::{
    AccountBalances, AssetEvent, AssetId, AssetSummary, BurnRequest, Holding, IssuanceReceipt,
    IssuanceRequest, Recipient, TransferRequest, TxId,
};
use nonempty::NonEmpty;
use orchard::issuance::{IssueInfo, compute_asset_desc_hash};
use orchard::keys::SpendAuthorizingKey;
use orchard::note::{AssetBase, AssetId as OrchardAssetId};
use orchard::tree::MerklePath;
use orchard::value::NoteValue;
use orchard::{Address, Anchor, Note};
use rand::rngs::OsRng;
use zcash_primitives::transaction::Transaction;
use zcash_primitives::transaction::builder::{BuildConfig, Builder};
use zcash_primitives::transaction::fees::zip317::{FeeError, FeeRule};
use zcash_proofs::prover::LocalTxProver;
use zcash_protocol::consensus::REGTEST_NETWORK;
use zcash_protocol::memo::MemoBytes;
use zcash_protocol::value::Zatoshis;
use zcash_transparent::builder::TransparentSigningSet;

use crate::{ChainBackend, ChainError, ChainInfo, RawBlock, RawBlocks};
use keys::IssuerKeys;
use rpc::NodeRpc;
use wallet::{HotWallet, SelectedInputs, TRACKED_ACCOUNTS};

/// Configuration for the OrchardZSA backend.
#[derive(Debug, Clone)]
pub struct ZsaConfig {
    /// Zebra JSON-RPC endpoint, e.g. `http://127.0.0.1:18232` or
    /// `https://dev.zebra.zsa-test.net:443`.
    pub node_url: String,
    /// BIP-39 issuer seed phrase. Regtest/testnet only (PRIVACY.md P3).
    /// On shared networks this MUST be a private phrase: the tx_tool demo
    /// seed is public knowledge, and both note spending and asset-id
    /// derivation hang off it.
    pub seed_phrase: String,
    /// Label reported by `chain_info`, e.g. `regtest` / `zsa-testnet`.
    pub network_label: String,
    /// First block the wallet and asset scans consider (the issuer's
    /// "birthday"). 1 on regtest; on the long-lived public testnet, set to
    /// the height where this issuer started operating — earlier blocks
    /// cannot contain our notes, and the registry documents that it covers
    /// assets from this height onward.
    pub scan_start_height: u64,
}

impl ZsaConfig {
    /// Regtest defaults matching the QEDIT tx_tool test wallet, so assets
    /// issued here are cross-checkable against the reference scenarios.
    pub fn regtest(node_url: impl Into<String>) -> Self {
        Self {
            node_url: node_url.into(),
            seed_phrase: "fabric dilemma shift time border road fork license among uniform \
                          early laundry caution deer stamp"
                .to_owned(),
            network_label: "regtest".to_owned(),
            scan_start_height: 1,
        }
    }

    /// The public ZSA testnet operated by QEDIT (same protocol rules as the
    /// regtest single-node image, continuously producing blocks).
    pub fn zsa_testnet(seed_phrase: impl Into<String>, scan_start_height: u64) -> Self {
        Self {
            node_url: "https://dev.zebra.zsa-test.net:443".to_owned(),
            seed_phrase: seed_phrase.into(),
            network_label: "zsa-testnet".to_owned(),
            scan_start_height,
        }
    }
}

pub struct OrchardZsaBackend {
    rpc: NodeRpc,
    keys: IssuerKeys,
    network_label: String,
    scan_start_height: u64,
    /// Optional Postgres registry cache (shared with the API's metadata
    /// store). Absent → every listing is a full chain scan (always
    /// correct, fine at regtest scale).
    index: Option<std::sync::Arc<cachet_index::AssetIndex>>,
    /// Serializes index syncs: deltas are additive, so two concurrent
    /// syncs folding the same block range would double-count supplies.
    sync_lock: tokio::sync::Mutex<()>,
    /// Incrementally synced hot wallet: rebuilt from scratch only when the
    /// chain resets under it. The mutex both caches and serializes.
    wallet_cache: tokio::sync::Mutex<Option<WalletCache>>,
    /// Serializes relayed-transaction mining: two concurrent relays would
    /// race each other for the same template height and one would lose.
    relay_lock: tokio::sync::Mutex<()>,
    /// Immutable-block page cache for `raw_transactions`: heights at least
    /// `REORG_MARGIN` below the tip never change, so each is fetched from
    /// the node exactly once per process. Cleared when the chain resets
    /// under us (tip below a cached height — routine on regtest).
    block_cache: tokio::sync::RwLock<BlockCache>,
}

/// Cached raw transactions by height, plus the highest height ever cached
/// (for chain-reset detection).
#[derive(Default)]
struct BlockCache {
    blocks: std::collections::HashMap<u64, Vec<String>>,
    max_height: u64,
}

/// Blocks fewer than this many confirmations below the tip are served
/// fresh, never cached: deeper reorgs than this do not happen in practice
/// on the target networks, and a regtest reset clears the cache anyway.
const REORG_MARGIN: u64 = 6;

/// The cached wallet plus the chain position it is synced to.
struct WalletCache {
    wallet: HotWallet,
    tip_height: u64,
    tip_hash: String,
}

/// One asset of a batch issuance, resolved and preflighted.
struct BatchIssueItem {
    desc_hash: [u8; 32],
    amount: u64,
    finalize: bool,
    first_issuance: bool,
    asset: AssetBase,
}

impl OrchardZsaBackend {
    pub fn new(config: ZsaConfig) -> Result<Self, ChainError> {
        Ok(Self {
            rpc: NodeRpc::new(config.node_url),
            keys: IssuerKeys::from_seed_phrase(&config.seed_phrase)?,
            network_label: config.network_label,
            scan_start_height: config.scan_start_height.max(1),
            index: None,
            sync_lock: tokio::sync::Mutex::new(()),
            wallet_cache: tokio::sync::Mutex::new(None),
            relay_lock: tokio::sync::Mutex::new(()),
            block_cache: tokio::sync::RwLock::new(BlockCache::default()),
        })
    }

    /// Attach a Postgres index used as a registry cache for listings.
    pub fn with_index(mut self, index: std::sync::Arc<cachet_index::AssetIndex>) -> Self {
        self.index = Some(index);
        self
    }

    /// Override the scan start height (issuer birthday) after construction
    /// — used when the operator defaults it to the current tip at startup.
    pub fn set_scan_start_height(&mut self, height: u64) {
        self.scan_start_height = height.max(1);
    }

    /// Fill the immutable-block page cache up to the reorg margin, so the
    /// FIRST wallet scan of any visitor is as fast as a repeat one. The
    /// first pass after boot walks the whole chain (RPC-bound); later
    /// passes only fetch blocks the cache does not hold yet — pages
    /// already cached cost memory reads, not node RPCs.
    pub async fn warm_block_cache(&self) -> Result<(), ChainError> {
        let tip_height = self.chain_info_inner().await?.tip_height;
        let cutoff = tip_height.saturating_sub(REORG_MARGIN);
        let mut height = 1u64;
        let mut fetched_any = false;
        while height <= cutoff {
            let page_end = (height + 99).min(cutoff);
            let already_cached = {
                let cache = self.block_cache.read().await;
                (height..=page_end).all(|h| cache.blocks.contains_key(&h))
            };
            if !already_cached {
                fetched_any = true;
                self.raw_transactions(height, page_end - height + 1).await?;
            }
            height = page_end + 1;
        }
        if fetched_any {
            tracing::info!(up_to = cutoff, "block page cache warmed");
        }
        Ok(())
    }

    /// Bring the registry index up to the chain tip now. No-op without an
    /// index. Used by the server's background sync loop so the first
    /// visitor never pays for a cold catch-up scan.
    pub async fn sync_registry(&self) -> Result<(), ChainError> {
        match &self.index {
            Some(index) => self.sync_index(index).await,
            None => Ok(()),
        }
    }

    /// Bring the index up to the chain tip, wiping it first when the chain
    /// was reset or reorged past the checkpoint (routine on the ephemeral
    /// regtest).
    async fn sync_index(&self, index: &cachet_index::AssetIndex) -> Result<(), ChainError> {
        // One sync at a time: concurrent folds of the same range would
        // apply the same additive deltas repeatedly. Waiters re-read the
        // checkpoint after acquiring the lock, so they see the finished
        // sync and fold nothing.
        let _guard = self.sync_lock.lock().await;

        let map_index_error = |error: cachet_index::IndexError| ChainError::Unavailable {
            reason: format!("asset index: {error}"),
        };

        let tip_height = self.chain_info_inner().await?.tip_height;

        // Validate the stored checkpoint against the live chain.
        let mut from_height = self.scan_start_height;
        match index.checkpoint().await.map_err(map_index_error)? {
            Some(checkpoint) if checkpoint.tip_height <= tip_height => {
                let on_chain = self.rpc.block_summary(checkpoint.tip_height).await?;
                if on_chain.hash == checkpoint.tip_hash {
                    from_height = checkpoint.tip_height + 1;
                } else {
                    index.reset().await.map_err(map_index_error)?;
                }
            }
            Some(_) => {
                // Chain shrank below the checkpoint: definite reset.
                index.reset().await.map_err(map_index_error)?;
            }
            None => {}
        }

        if from_height > tip_height {
            return Ok(());
        }

        let mut fold = scan::AssetFold::default();
        scan::for_each_transaction_in(&self.rpc, from_height, tip_height, |height, tx| {
            fold.fold(height, tx);
            Ok(())
        })
        .await?;

        let events: Vec<cachet_index::EventRow> = fold
            .take_events()
            .into_iter()
            .map(|event| cachet_index::EventRow {
                asset_id: event.asset_id,
                height: event.height,
                txid: event.txid,
                kind: event.kind,
                amount: event.amount,
            })
            .collect();
        let deltas: Vec<cachet_index::AssetDelta> = fold
            .into_ordered()
            .into_iter()
            .map(|(asset_id, state)| cachet_index::AssetDelta {
                asset_id,
                issued: state.issued,
                burned: state.burned,
                finalized: state.finalized,
                asset_desc_hash: state.desc_hash,
                issuer_ik: state.issuer_ik,
            })
            .collect();

        let tip_hash = self.rpc.block_summary(tip_height).await?.hash;
        index
            .apply(
                &deltas,
                &events,
                cachet_index::Checkpoint {
                    tip_height,
                    tip_hash,
                },
            )
            .await
            .map_err(map_index_error)
    }

    /// The asset id our issuer key produces for a description — known
    /// before any issuance (ZIP 227 derivation). Errors on descriptions the
    /// domain layer would reject.
    pub fn asset_id_for_description(&self, description: &str) -> Result<AssetId, ChainError> {
        if description.is_empty() {
            return Err(ChainError::Rejected {
                reason: "asset description must not be empty".to_owned(),
            });
        }
        let asset = self.asset_for_desc_hash(Self::desc_hash(description));
        Ok(AssetId::from_bytes(asset.to_bytes()))
    }

    /// The asset an issuance under `description` creates for our issuer key
    /// (ZIP 227: derived from the validating key and the description hash).
    fn asset_for_desc_hash(&self, asset_desc_hash: [u8; 32]) -> AssetBase {
        AssetBase::custom(&OrchardAssetId::new_v0(
            &self.keys.issuance_validating_key(),
            &asset_desc_hash,
        ))
    }

    fn desc_hash(description: &str) -> [u8; 32] {
        compute_asset_desc_hash(
            &NonEmpty::from_slice(description.as_bytes())
                .expect("domain guarantees a non-empty description"),
        )
    }

    /// Build one issuance transaction minting every item in the batch: a
    /// single issuance bundle, one IssueAction per item, one authorizing
    /// signature (standard ZIP 227 batching). CPU-heavy (Halo2 proving for
    /// the mandatory Orchard action) — call inside `spawn_blocking`.
    fn build_issue_transaction(
        keys: &IssuerKeys,
        target_height: u32,
        items: &[BatchIssueItem],
    ) -> Result<Transaction, ChainError> {
        let build_error = |stage: &str| {
            let stage = stage.to_owned();
            move |error: String| ChainError::Rejected {
                reason: format!("issuance transaction {stage} failed: {error}"),
            }
        };
        let (first, rest) = items.split_first().expect("batch is validated non-empty");

        let mut builder = Builder::new(
            REGTEST_NETWORK,
            target_height.into(),
            BuildConfig::Standard {
                sapling_anchor: None,
                // Issuance spends no Orchard notes; the empty-tree anchor is
                // valid for output-only bundles.
                orchard_anchor: Some(Anchor::empty_tree()),
            },
        );

        builder
            .init_issuance_bundle::<FeeError>(
                keys.issuance_key(),
                first.desc_hash,
                Some(IssueInfo {
                    recipient: keys.default_address(),
                    value: NoteValue::from_raw(first.amount),
                }),
                first.first_issuance,
            )
            .map_err(|error| build_error("issuance bundle")(format!("{error:?}")))?;

        for item in rest {
            builder
                .add_recipient::<FeeError>(
                    item.desc_hash,
                    keys.default_address(),
                    NoteValue::from_raw(item.amount),
                    item.first_issuance,
                )
                .map_err(|error| build_error("issuance action")(format!("{error:?}")))?;
        }

        for item in items.iter().filter(|item| item.finalize) {
            builder
                .finalize_asset::<FeeError>(&item.desc_hash)
                .map_err(|error| build_error("finalization")(format!("{error:?}")))?;
        }

        // The v6 builder requires at least one Orchard action to derive rho;
        // a zero-value ZEC output is the reference workaround (tx_tool does
        // the same — custom assets cannot pad output-only bundles).
        builder
            .add_orchard_output::<FeeError>(
                Some(keys.orchard_ovk()),
                keys.default_address(),
                Zatoshis::ZERO,
                AssetBase::zatoshi(),
                MemoBytes::empty(),
            )
            .map_err(|error| build_error("padding output")(format!("{error:?}")))?;

        // Zero fee: the regtest accepts it and the issuer wallet holds no
        // ZEC inputs to pay one (mirrors the tx_tool's non-standard rule).
        let fee_rule = FeeRule::non_standard(Zatoshis::ZERO, 20, 150, 34, 0)
            .expect("static fee-rule parameters are valid");
        let prover =
            LocalTxProver::with_default_location().ok_or_else(|| ChainError::Unavailable {
                reason: "Zcash Sapling parameters not found; run the fetch-params step in \
                         docs/SETUP.md"
                    .to_owned(),
            })?;

        let tx = builder
            .build(
                &TransparentSigningSet::new(),
                &[],
                &[],
                OsRng,
                &prover,
                &prover,
                &fee_rule,
                |asset_base| {
                    items
                        .iter()
                        .any(|item| item.first_issuance && asset_base == &item.asset)
                },
            )
            .map_err(|error| build_error("build")(format!("{error:?}")))?
            .into_transaction();
        Ok(tx)
    }

    /// Mine a block containing `transaction` and confirm it landed.
    ///
    /// On a shared network (the public ZSA testnet) another producer can
    /// win the same height, orphaning our block — so tip advancement alone
    /// is not proof of inclusion; the transaction itself is checked last.
    async fn mine(&self, transaction: Transaction) -> Result<(), ChainError> {
        let mut display_txid = *transaction.txid().as_ref();
        display_txid.reverse();
        let display_txid = hex::encode(display_txid);

        let template = self.rpc.block_template().await?;
        let block_height = template.height;
        let block_hex = block::assemble_block_hex(template, vec![transaction])?;

        let verdict = self.rpc.submit_block(block_hex).await?;
        if let Some(text) = &verdict {
            tracing::debug!(verdict = %text, "submitblock returned a verdict string");
        }

        // Zebra validates submitted blocks asynchronously, and its
        // `getblockchaininfo.blocks` lags behind the best tip — the reliable
        // acceptance signal (used by the tx_tool as well) is the next block
        // template targeting a greater height.
        let mut advanced = false;
        for _ in 0..40 {
            let next_height = self.rpc.block_template().await?.height;
            if next_height > block_height {
                advanced = true;
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(250)).await;
        }
        if !advanced {
            return Err(ChainError::Rejected {
                reason: format!(
                    "block at height {block_height} was not accepted within 10s{}",
                    verdict
                        .map(|reason| format!(" (node said: {reason})"))
                        .unwrap_or_default()
                ),
            });
        }

        // The chain moved — but did it move with OUR block? Confirm the
        // node knows the transaction (chain or mempool).
        match self.rpc.raw_transaction(&display_txid).await {
            Ok(_) => Ok(()),
            Err(_) => Err(ChainError::Rejected {
                reason: format!(
                    "transaction {display_txid} did not land: a competing block likely won \
                     height {block_height}; retry the operation"
                ),
            }),
        }
    }

    /// Lock the wallet cache, bring it to the chain tip incrementally, and
    /// return the guard. Rebuilds from scratch when the chain was reset or
    /// reorged under the cache (routine on the ephemeral regtest).
    async fn synced_wallet(
        &self,
    ) -> Result<tokio::sync::MutexGuard<'_, Option<WalletCache>>, ChainError> {
        let mut guard = self.wallet_cache.lock().await;
        let tip = self.chain_info_inner().await?.tip_height;

        // Validate the cached position against the live chain.
        let valid = match guard.as_ref() {
            Some(cache) if cache.tip_height == 0 => true,
            Some(cache) if cache.tip_height <= tip => {
                self.rpc.block_summary(cache.tip_height).await?.hash == cache.tip_hash
            }
            Some(_) => false, // chain shrank: definite reset
            None => false,
        };
        if !valid {
            *guard = Some(WalletCache {
                wallet: HotWallet::new(&self.keys),
                tip_height: self.scan_start_height.saturating_sub(1),
                tip_hash: String::new(),
            });
        }

        let cache = guard.as_mut().expect("wallet cache initialized above");
        if cache.tip_height < tip {
            let from = cache.tip_height + 1;
            scan::for_each_transaction_in(&self.rpc, from, tip, |_, tx| {
                cache.wallet.process_transaction(tx)
            })
            .await?;
            cache.tip_height = tip;
            cache.tip_hash = self.rpc.block_summary(tip).await?.hash;
        }
        Ok(guard)
    }

    /// Resolve a domain recipient to an Orchard address.
    fn resolve_recipient(
        &self,
        wallet: &HotWallet,
        recipient: &Recipient,
    ) -> Result<Address, ChainError> {
        match recipient {
            Recipient::Internal { account } => {
                wallet
                    .account_address(*account)
                    .ok_or_else(|| ChainError::InvalidRecipient {
                        reason: format!(
                            "internal account {account} is not tracked (0..{TRACKED_ACCOUNTS})"
                        ),
                    })
            }
            Recipient::External { address } => parse_orchard_address(address),
        }
    }

    /// Build a v6 transaction spending `inputs`, sending `amount` of `asset`
    /// to `recipient`, returning change to `change_address`. When `burn` is
    /// true the amount is destroyed instead of sent. CPU-heavy — call
    /// inside `spawn_blocking`.
    #[allow(clippy::too_many_arguments)]
    fn build_spend_transaction(
        keys: &IssuerKeys,
        target_height: u32,
        anchor: Anchor,
        inputs: Vec<(orchard::keys::SpendingKey, Note, MerklePath)>,
        total_inputs: u64,
        amount: u64,
        asset: AssetBase,
        recipient: Option<Address>,
        change_address: Address,
    ) -> Result<Transaction, ChainError> {
        let stage_error = |stage: &str, error: String| ChainError::Rejected {
            reason: format!("spend transaction {stage} failed: {error}"),
        };

        let mut builder = Builder::new(
            REGTEST_NETWORK,
            target_height.into(),
            BuildConfig::Standard {
                sapling_anchor: None,
                orchard_anchor: Some(anchor),
            },
        );

        let mut spend_auth_keys: Vec<SpendAuthorizingKey> = Vec::new();
        for (spending_key, note, merkle_path) in inputs {
            builder
                .add_orchard_spend::<FeeError>((&spending_key).into(), note, merkle_path)
                .map_err(|error| stage_error("spend", format!("{error:?}")))?;
            spend_auth_keys.push(SpendAuthorizingKey::from(&spending_key));
        }

        match recipient {
            Some(recipient) => {
                builder
                    .add_orchard_output::<FeeError>(
                        Some(keys.orchard_ovk()),
                        recipient,
                        Zatoshis::from_u64(amount).expect("validated amount"),
                        asset,
                        MemoBytes::empty(),
                    )
                    .map_err(|error| stage_error("output", format!("{error:?}")))?;
            }
            None => {
                builder
                    .add_burn::<FeeError>(amount, asset)
                    .map_err(|error| stage_error("burn", format!("{error:?}")))?;
            }
        }

        let change = total_inputs - amount;
        if change > 0 {
            builder
                .add_orchard_output::<FeeError>(
                    Some(keys.orchard_ovk()),
                    change_address,
                    Zatoshis::from_u64(change).expect("validated change"),
                    asset,
                    MemoBytes::empty(),
                )
                .map_err(|error| stage_error("change output", format!("{error:?}")))?;
        }

        let fee_rule = FeeRule::non_standard(Zatoshis::ZERO, 20, 150, 34, 0)
            .expect("static fee-rule parameters are valid");
        let prover =
            LocalTxProver::with_default_location().ok_or_else(|| ChainError::Unavailable {
                reason: "Zcash Sapling parameters not found; run the fetch-params step in \
                         docs/SETUP.md"
                    .to_owned(),
            })?;

        let tx = builder
            .build(
                &TransparentSigningSet::new(),
                &[],
                &spend_auth_keys,
                OsRng,
                &prover,
                &prover,
                &fee_rule,
                |_| false,
            )
            .map_err(|error| stage_error("build", format!("{error:?}")))?
            .into_transaction();
        Ok(tx)
    }

    /// Shared transfer/burn path: rescan, select, build, mine.
    async fn spend(
        &self,
        asset_id: AssetId,
        amount: u64,
        recipient: Option<&Recipient>,
    ) -> Result<TxId, ChainError> {
        let asset = Option::<AssetBase>::from(AssetBase::from_bytes(asset_id.as_bytes()))
            .ok_or(ChainError::UnknownAsset(asset_id))?;

        let guard = self.synced_wallet().await?;
        let cache = guard.as_ref().expect("wallet cache synced");
        let recipient_address = recipient
            .map(|recipient| self.resolve_recipient(&cache.wallet, recipient))
            .transpose()?;
        let SelectedInputs { inputs, total } = cache.wallet.select_inputs(0, asset, amount)?;
        let anchor = cache.wallet.anchor()?;
        drop(guard);
        let change_address = self.keys.default_address();

        let target_height = self.rpc.block_template().await?.height;
        let keys = self.keys.clone();
        let transaction = tokio::task::spawn_blocking(move || {
            Self::build_spend_transaction(
                &keys,
                target_height,
                anchor,
                inputs,
                total,
                amount,
                asset,
                recipient_address,
                change_address,
            )
        })
        .await
        .map_err(|error| ChainError::Unavailable {
            reason: format!("spend build task failed: {error}"),
        })??;

        let mut txid = *transaction.txid().as_ref();
        txid.reverse();
        self.mine(transaction).await?;
        Ok(TxId::from_bytes(txid))
    }

    async fn chain_info_inner(&self) -> Result<ChainInfo, ChainError> {
        // The block template targets tip + 1 and, unlike
        // `getblockchaininfo.blocks`, tracks the best tip without lag —
        // scans must see just-mined blocks immediately.
        let next_height = self.rpc.block_template().await?.height;
        Ok(ChainInfo {
            network: self.network_label.clone(),
            tip_height: u64::from(next_height.saturating_sub(1)),
        })
    }
}

#[async_trait]
impl ChainBackend for OrchardZsaBackend {
    async fn chain_info(&self) -> Result<ChainInfo, ChainError> {
        self.chain_info_inner().await
    }

    async fn issue(&self, request: IssuanceRequest) -> Result<IssuanceReceipt, ChainError> {
        let mut receipts = self.issue_batch(vec![request]).await?;
        Ok(receipts.remove(0))
    }

    async fn issue_batch(
        &self,
        requests: Vec<IssuanceRequest>,
    ) -> Result<Vec<IssuanceReceipt>, ChainError> {
        cachet_domain::asset::validate_issuance_batch(&requests).map_err(|error| {
            ChainError::Rejected {
                reason: error.to_string(),
            }
        })?;

        // Preflight every item against current chain state: distinguishes
        // first issuance from reissuance, and rejects the whole batch on a
        // finalized asset instead of a node-level rejection (the bundle is
        // one transaction — all or nothing).
        let info = self.chain_info_inner().await?;
        let mut items = Vec::with_capacity(requests.len());
        for request in &requests {
            let desc_hash = Self::desc_hash(request.description.as_str());
            let asset = self.asset_for_desc_hash(desc_hash);
            let scanned =
                scan::scan_asset(&self.rpc, self.scan_start_height, info.tip_height, asset).await?;
            if scanned.finalized {
                return Err(ChainError::AssetFinalized(AssetId::from_bytes(
                    asset.to_bytes(),
                )));
            }
            items.push(BatchIssueItem {
                desc_hash,
                amount: request.amount,
                finalize: request.finalize,
                first_issuance: !scanned.seen,
                asset,
            });
        }

        let target_height = self.rpc.block_template().await?.height;
        let keys = self.keys.clone();
        let (transaction, items) = tokio::task::spawn_blocking(move || {
            Self::build_issue_transaction(&keys, target_height, &items)
                .map(|transaction| (transaction, items))
        })
        .await
        .map_err(|error| ChainError::Unavailable {
            reason: format!("issuance build task failed: {error}"),
        })??;

        // Store txid bytes in big-endian display order so the API's hex
        // matches what explorers and the tx_tool logs show.
        let mut txid = *transaction.txid().as_ref();
        txid.reverse();
        self.mine(transaction).await?;
        let txid = TxId::from_bytes(txid);

        // Journal the descriptions (issuer-local; the chain only stores
        // hashes). Best-effort: a journal failure must not fail issuance.
        if let Some(index) = &self.index {
            for (request, item) in requests.iter().zip(&items) {
                if let Err(error) = index
                    .record_description(
                        AssetId::from_bytes(item.asset.to_bytes()),
                        request.description.as_str(),
                    )
                    .await
                {
                    tracing::warn!(%error, "failed to journal asset description");
                }
            }
        }

        for item in &items {
            tracing::info!(
                asset = %hex::encode(item.asset.to_bytes()),
                amount = item.amount,
                finalize = item.finalize,
                first_issuance = item.first_issuance,
                "issued asset on {}",
                self.network_label
            );
        }
        Ok(items
            .iter()
            .map(|item| IssuanceReceipt {
                txid,
                asset_id: AssetId::from_bytes(item.asset.to_bytes()),
            })
            .collect())
    }

    async fn relay(&self, tx_bytes: Vec<u8>) -> Result<crate::RelayReceipt, ChainError> {
        use zcash_protocol::consensus::BranchId;

        let transaction =
            Transaction::read(tx_bytes.as_slice(), BranchId::Nu7).map_err(|error| {
                ChainError::Rejected {
                    reason: format!("not a valid v6 transaction: {error}"),
                }
            })?;
        // ZSA relay only: a transaction must carry an issuance bundle or an
        // Orchard bundle (shielded transfer/burn). General broadcast is out
        // of scope for a public instance.
        if transaction.issue_bundle().is_none() && transaction.orchard_bundle().is_none() {
            return Err(ChainError::Rejected {
                reason: "only issuance and shielded transfer/burn transactions are relayed"
                    .to_owned(),
            });
        }

        // Public facts for the receipt: the asset ids the issuance bundle
        // mints (derived exactly as the scanner derives them).
        let issued_assets = transaction
            .issue_bundle()
            .map(|bundle| {
                bundle
                    .actions()
                    .iter()
                    .map(|action| {
                        let asset = AssetBase::custom(&OrchardAssetId::new_v0(
                            bundle.ik(),
                            action.asset_desc_hash(),
                        ));
                        AssetId::from_bytes(asset.to_bytes())
                    })
                    .collect()
            })
            .unwrap_or_default();

        let mut txid = *transaction.txid().as_ref();
        txid.reverse();

        // One relay at a time: concurrent mines race for the template.
        let _guard = self.relay_lock.lock().await;
        self.mine(transaction).await?;
        tracing::info!(txid = %hex::encode(txid), "relayed a browser-built transaction");
        Ok(crate::RelayReceipt {
            txid: TxId::from_bytes(txid),
            issued_assets,
        })
    }

    async fn raw_transactions(
        &self,
        start_height: u64,
        limit: u64,
    ) -> Result<RawBlocks, ChainError> {
        // Bounded pages: browser wallets iterate until the tip.
        let limit = limit.clamp(1, 100);
        let tip_height = self.chain_info_inner().await?.tip_height;

        // Chain reset under us (routine on regtest): drop the whole cache.
        {
            let cache = self.block_cache.read().await;
            if cache.max_height > tip_height {
                drop(cache);
                let mut cache = self.block_cache.write().await;
                if cache.max_height > tip_height {
                    tracing::info!("chain reset detected; clearing the block page cache");
                    *cache = BlockCache::default();
                }
            }
        }

        let cache_cutoff = tip_height.saturating_sub(REORG_MARGIN);
        let mut blocks = Vec::new();
        let mut height = start_height.max(1);
        while height <= tip_height && (blocks.len() as u64) < limit {
            let cached = if height <= cache_cutoff {
                self.block_cache.read().await.blocks.get(&height).cloned()
            } else {
                None
            };
            let txs = match cached {
                Some(txs) => txs,
                None => {
                    let summary = self.rpc.block_summary(height).await?;
                    let mut txs = Vec::with_capacity(summary.tx_ids.len());
                    for txid in &summary.tx_ids {
                        txs.push(self.rpc.raw_transaction(txid).await?);
                    }
                    if height <= cache_cutoff {
                        let mut cache = self.block_cache.write().await;
                        cache.blocks.insert(height, txs.clone());
                        cache.max_height = cache.max_height.max(height);
                    }
                    txs
                }
            };
            blocks.push(RawBlock { height, txs });
            height += 1;
        }
        Ok(RawBlocks { tip_height, blocks })
    }

    async fn resolve_description(
        &self,
        asset_id: AssetId,
        description: &str,
    ) -> Result<(), ChainError> {
        if description.is_empty() {
            return Err(ChainError::Rejected {
                reason: "description must not be empty".to_owned(),
            });
        }
        let Some(index) = &self.index else {
            return Err(ChainError::Unavailable {
                reason: "description resolution requires the registry index; connect Postgres"
                    .to_owned(),
            });
        };
        self.sync_index(index).await?;

        let map_index_error = |error: cachet_index::IndexError| ChainError::Unavailable {
            reason: format!("asset index: {error}"),
        };
        // Without an indexed issuance we don't know the asset's on-chain
        // commitment, so there is nothing to verify against.
        let expected = index
            .asset_desc_hash(asset_id)
            .await
            .map_err(map_index_error)?
            .ok_or(ChainError::UnknownAsset(asset_id))?;
        if Self::desc_hash(description) != expected {
            return Err(ChainError::Rejected {
                reason: "description does not hash to the on-chain commitment (ZIP 227)".to_owned(),
            });
        }
        index
            .record_description(asset_id, description)
            .await
            .map_err(map_index_error)?;
        tracing::info!(asset = %asset_id, "description resolved by preimage verification");
        Ok(())
    }

    async fn asset_state(&self, asset_id: AssetId) -> Result<AssetSummary, ChainError> {
        // Not every 32-byte string is a valid Pallas point; treat undecodable
        // ids as unknown assets rather than validation errors.
        let asset = Option::<AssetBase>::from(AssetBase::from_bytes(asset_id.as_bytes()))
            .ok_or(ChainError::UnknownAsset(asset_id))?;

        // Served from the index when available: a full chain scan per
        // lookup is prohibitive against the remote public testnet.
        if let Some(index) = &self.index {
            self.sync_index(index).await?;
            return match index.get_asset(asset_id).await {
                Ok(Some(summary)) => Ok(summary),
                Ok(None) => Err(ChainError::UnknownAsset(asset_id)),
                Err(error) => Err(ChainError::Unavailable {
                    reason: format!("asset index: {error}"),
                }),
            };
        }

        // Scan fallback: authoritative, description unknown (the chain
        // carries only the description hash).
        let info = self.chain_info_inner().await?;
        let scanned =
            scan::scan_asset(&self.rpc, self.scan_start_height, info.tip_height, asset).await?;
        if !scanned.seen {
            return Err(ChainError::UnknownAsset(asset_id));
        }
        Ok(AssetSummary {
            asset_id,
            description: None,
            issuer: scanned.issuer_ik.map(hex::encode),
            total_supply: scanned.total_supply(),
            finalized: scanned.finalized,
        })
    }

    async fn list_assets(&self) -> Result<Vec<AssetSummary>, ChainError> {
        if let Some(index) = &self.index {
            self.sync_index(index).await?;
            return index.list().await.map_err(|error| ChainError::Unavailable {
                reason: format!("asset index: {error}"),
            });
        }

        // Scan-only fallback: authoritative, descriptions unknown (the
        // chain carries only description hashes).
        let info = self.chain_info_inner().await?;
        let mut assets =
            scan::scan_all_assets(&self.rpc, self.scan_start_height, info.tip_height).await?;
        assets.reverse(); // newest first
        Ok(assets
            .into_iter()
            .map(|(asset_id, state)| AssetSummary {
                asset_id: AssetId::from_bytes(asset_id),
                description: None,
                issuer: state.issuer_ik.map(hex::encode),
                total_supply: state.total_supply(),
                finalized: state.finalized,
            })
            .collect())
    }

    async fn collections(&self) -> Result<Vec<cachet_domain::CollectionSummary>, ChainError> {
        if let Some(index) = &self.index {
            self.sync_index(index).await?;
            return index
                .collections()
                .await
                .map_err(|error| ChainError::Unavailable {
                    reason: format!("asset index: {error}"),
                });
        }

        // Scan-only fallback: group the fold by issuer, largest first.
        let info = self.chain_info_inner().await?;
        let assets =
            scan::scan_all_assets(&self.rpc, self.scan_start_height, info.tip_height).await?;
        let mut by_issuer: std::collections::BTreeMap<String, cachet_domain::CollectionSummary> =
            Default::default();
        for (_, state) in assets {
            let Some(issuer) = state.issuer_ik.map(hex::encode) else {
                continue; // burn-only sighting: issuer unknown
            };
            let entry =
                by_issuer
                    .entry(issuer.clone())
                    .or_insert(cachet_domain::CollectionSummary {
                        issuer,
                        asset_count: 0,
                        total_supply: 0,
                        finalized_count: 0,
                    });
            entry.asset_count += 1;
            entry.total_supply += state.total_supply();
            entry.finalized_count += u64::from(state.finalized);
        }
        let mut collections: Vec<_> = by_issuer.into_values().collect();
        collections.sort_by_key(|collection| std::cmp::Reverse(collection.asset_count));
        Ok(collections)
    }

    async fn wallet_balances(&self) -> Result<Vec<AccountBalances>, ChainError> {
        let guard = self.synced_wallet().await?;
        let cache = guard.as_ref().expect("wallet cache synced");
        Ok(cache
            .wallet
            .balances_by_account()
            .into_iter()
            .map(|(account, holdings)| AccountBalances {
                account,
                holdings: holdings
                    .into_iter()
                    .map(|(asset_id, amount)| Holding {
                        asset_id: AssetId::from_bytes(asset_id),
                        amount,
                    })
                    .collect(),
            })
            .collect())
    }

    async fn asset_events(&self, asset_id: AssetId) -> Result<Vec<AssetEvent>, ChainError> {
        if let Some(index) = &self.index {
            self.sync_index(index).await?;
            return index
                .events(asset_id)
                .await
                .map_err(|error| ChainError::Unavailable {
                    reason: format!("asset index: {error}"),
                });
        }

        // Scan fallback: fold the chain and keep this asset's events.
        let info = self.chain_info_inner().await?;
        let mut fold = scan::AssetFold::default();
        scan::for_each_transaction_in(
            &self.rpc,
            self.scan_start_height,
            info.tip_height,
            |height, tx| {
                fold.fold(height, tx);
                Ok(())
            },
        )
        .await?;
        Ok(fold
            .take_events()
            .into_iter()
            .filter(|event| event.asset_id == *asset_id.as_bytes())
            .map(|event| AssetEvent {
                asset_id,
                height: event.height,
                txid: TxId::from_bytes(event.txid),
                kind: event.kind,
                amount: event.amount,
            })
            .collect())
    }

    async fn transfer(&self, request: TransferRequest) -> Result<TxId, ChainError> {
        let txid = self
            .spend(request.asset_id, request.amount, Some(&request.recipient))
            .await?;
        tracing::info!(
            asset = %request.asset_id,
            amount = request.amount,
            "transferred asset on {}",
            self.network_label
        );
        Ok(txid)
    }

    async fn burn(&self, request: BurnRequest) -> Result<TxId, ChainError> {
        let txid = self.spend(request.asset_id, request.amount, None).await?;
        tracing::info!(
            asset = %request.asset_id,
            amount = request.amount,
            "burned asset units on {}",
            self.network_label
        );
        Ok(txid)
    }
}

/// Decode a recipient string into an Orchard address.
///
/// Accepts a unified address carrying an Orchard receiver (the standard
/// interchange format on ZSA networks) on any network — the node is the
/// authority on network validity, and regtest/testnet HRPs vary across the
/// ZSA deployments.
fn parse_orchard_address(input: &str) -> Result<Address, ChainError> {
    use zcash_address::unified::{Container, Encoding, Receiver};

    let invalid = |reason: String| ChainError::InvalidRecipient { reason };

    let (_network, unified) = zcash_address::unified::Address::decode(input)
        .map_err(|error| invalid(format!("not a unified address: {error}")))?;

    let orchard_receiver = unified
        .items()
        .into_iter()
        .find_map(|receiver| match receiver {
            Receiver::Orchard(bytes) => Some(bytes),
            _ => None,
        })
        .ok_or_else(|| invalid("unified address has no Orchard receiver".to_owned()))?;

    Option::<Address>::from(Address::from_raw_address_bytes(&orchard_receiver))
        .ok_or_else(|| invalid("invalid Orchard receiver bytes".to_owned()))
}
