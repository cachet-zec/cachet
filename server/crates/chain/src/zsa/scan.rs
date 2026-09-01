//! Chain scanning: derive an asset's state by walking the blocks.
//!
//! Milestone-C implementation: a full scan per query. Correct and honest for
//! regtest-scale chains; the Postgres-backed incremental index replaces the
//! full walk in a later milestone (PRIVACY.md P4 keeps it reconstructible).

use orchard::note::{AssetBase, AssetId as OrchardAssetId};
use zcash_primitives::transaction::{OrchardBundle, Transaction};
use zcash_protocol::consensus::BranchId;

use crate::ChainError;
use crate::zsa::rpc::NodeRpc;

/// Accumulated on-chain facts about one asset.
#[derive(Debug, Default, Clone, Copy)]
pub struct ScannedAsset {
    pub seen: bool,
    pub issued: u64,
    pub burned: u64,
    pub finalized: bool,
    /// ZIP 227 assetDescHash, once an issuance for the asset was folded
    /// (burn-only sightings don't carry it).
    pub desc_hash: Option<[u8; 32]>,
    /// The issuance validating key, ZIP 227 canonical encoding (algorithm
    /// byte + 32-byte BIP-340 x-only key), once an issuance was folded.
    pub issuer_ik: Option<[u8; 33]>,
}

impl ScannedAsset {
    pub fn total_supply(&self) -> u64 {
        self.issued.saturating_sub(self.burned)
    }
}

/// Fetch and parse every transaction in `from_height..=to_height`, in
/// consensus order, feeding each to `visit`.
///
/// Blocks before NU7 activation (regtest: height 1) cannot contain v6
/// transactions, and the genesis coinbase predates the ZSA protocol, so
/// callers start at height 1 (or the first unindexed height). Every tx
/// parses under the NU7 branch (v6 and earlier formats alike).
pub async fn for_each_transaction_in<F>(
    rpc: &NodeRpc,
    from_height: u64,
    to_height: u64,
    mut visit: F,
) -> Result<(), ChainError>
where
    F: FnMut(u64, &Transaction) -> Result<(), ChainError>,
{
    for height in from_height..=to_height {
        let block = rpc.block_summary(height).await?;
        for txid in &block.tx_ids {
            let raw = rpc.raw_transaction(txid).await?;
            let bytes = hex::decode(&raw).map_err(|error| ChainError::Unavailable {
                reason: format!("node returned invalid tx hex for {txid}: {error}"),
            })?;
            let tx = Transaction::read(bytes.as_slice(), BranchId::Nu7).map_err(|error| {
                ChainError::Unavailable {
                    reason: format!("could not parse tx {txid}: {error}"),
                }
            })?;
            visit(height, &tx)?;
        }
    }
    Ok(())
}

/// Walk `from_height..=tip` and fold issuance and burns for `asset`.
pub async fn scan_asset(
    rpc: &NodeRpc,
    from_height: u64,
    tip_height: u64,
    asset: AssetBase,
) -> Result<ScannedAsset, ChainError> {
    let mut state = ScannedAsset::default();
    for_each_transaction_in(rpc, from_height, tip_height, |_, tx| {
        fold_transaction(&mut state, tx, asset);
        Ok(())
    })
    .await?;
    Ok(state)
}

/// One public event captured while folding (see `AssetEventKind`).
#[derive(Debug, Clone)]
pub struct FoldedEvent {
    pub asset_id: [u8; 32],
    pub height: u64,
    /// Txid in display byte order.
    pub txid: [u8; 32],
    pub kind: cachet_domain::AssetEventKind,
    pub amount: u64,
}

/// Accumulator for a scan over *all* assets, preserving first-seen order
/// and capturing public events.
#[derive(Debug, Default)]
pub struct AssetFold {
    order: Vec<[u8; 32]>,
    by_id: std::collections::HashMap<[u8; 32], ScannedAsset>,
    events: Vec<FoldedEvent>,
}

impl AssetFold {
    /// Fold one transaction into the accumulator.
    pub fn fold(&mut self, height: u64, tx: &Transaction) {
        let mut txid = *tx.txid().as_ref();
        txid.reverse(); // display order, matching the API convention

        if let Some(issue_bundle) = tx.issue_bundle() {
            let issuer_ik: Option<[u8; 33]> = issue_bundle.ik().encode().try_into().ok();
            for action in issue_bundle.actions() {
                let action_asset = AssetBase::custom(&OrchardAssetId::new_v0(
                    issue_bundle.ik(),
                    action.asset_desc_hash(),
                ));
                let key = action_asset.to_bytes();
                if !self.by_id.contains_key(&key) {
                    self.order.push(key);
                }
                let entry = self.by_id.entry(key).or_default();
                entry.seen = true;
                entry.desc_hash = Some(*action.asset_desc_hash());
                entry.issuer_ik = issuer_ik;
                let issued_here: u64 = action.notes().iter().map(|note| note.value().inner()).sum();
                entry.issued = entry.issued.saturating_add(issued_here);
                if issued_here > 0 {
                    self.events.push(FoldedEvent {
                        asset_id: key,
                        height,
                        txid,
                        kind: cachet_domain::AssetEventKind::Issuance,
                        amount: issued_here,
                    });
                }
                if action.is_finalized() {
                    entry.finalized = true;
                    self.events.push(FoldedEvent {
                        asset_id: key,
                        height,
                        txid,
                        kind: cachet_domain::AssetEventKind::Finalization,
                        amount: 0,
                    });
                }
            }
        }

        if let Some(OrchardBundle::OrchardZSA(bundle)) = tx.orchard_bundle() {
            for (burned_asset, value) in bundle.burn() {
                let key = burned_asset.to_bytes();
                if !self.by_id.contains_key(&key) {
                    self.order.push(key);
                }
                let entry = self.by_id.entry(key).or_default();
                entry.seen = true;
                entry.burned = entry.burned.saturating_add(value.inner());
                self.events.push(FoldedEvent {
                    asset_id: key,
                    height,
                    txid,
                    kind: cachet_domain::AssetEventKind::Burn,
                    amount: value.inner(),
                });
            }
        }
    }

    /// The public events captured so far, in chain order.
    pub fn take_events(&mut self) -> Vec<FoldedEvent> {
        std::mem::take(&mut self.events)
    }

    /// Assets in first-seen order (oldest first), with their folded state.
    pub fn into_ordered(self) -> Vec<([u8; 32], ScannedAsset)> {
        let AssetFold { order, by_id, .. } = self;
        order
            .into_iter()
            .filter_map(|key| by_id.get(&key).map(|state| (key, *state)))
            .collect()
    }
}

/// Walk `from_height..=tip` and fold every asset (issuances and burns).
pub async fn scan_all_assets(
    rpc: &NodeRpc,
    from_height: u64,
    tip_height: u64,
) -> Result<Vec<([u8; 32], ScannedAsset)>, ChainError> {
    let mut fold = AssetFold::default();
    for_each_transaction_in(rpc, from_height, tip_height, |height, tx| {
        fold.fold(height, tx);
        Ok(())
    })
    .await?;
    Ok(fold.into_ordered())
}

fn fold_transaction(state: &mut ScannedAsset, tx: &Transaction, asset: AssetBase) {
    if let Some(issue_bundle) = tx.issue_bundle() {
        for action in issue_bundle.actions() {
            // Derive the action's asset from the bundle's issuer key and the
            // action's description hash — this also covers finalization-only
            // actions, which carry no notes.
            let action_asset = AssetBase::custom(&OrchardAssetId::new_v0(
                issue_bundle.ik(),
                action.asset_desc_hash(),
            ));
            if action_asset != asset {
                continue;
            }
            state.seen = true;
            if action.is_finalized() {
                state.finalized = true;
            }
            for note in action.notes() {
                state.issued = state.issued.saturating_add(note.value().inner());
            }
        }
    }

    if let Some(OrchardBundle::OrchardZSA(bundle)) = tx.orchard_bundle() {
        for (burned_asset, value) in bundle.burn() {
            if *burned_asset == asset {
                state.seen = true;
                state.burned = state.burned.saturating_add(value.inner());
            }
        }
    }
}
