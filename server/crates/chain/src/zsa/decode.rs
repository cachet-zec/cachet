//! Read the public ZSA content out of one parsed transaction.
//!
//! Only what the protocol publishes: the issuance bundle (ZIP 227) and the
//! burn list (ZIP 226). Issue notes' recipients are public on chain too,
//! but deliberately left out: they would make this page a tool for linking
//! issuers to addresses (PRIVACY.md P8), and nothing here needs them.

use cachet_domain::{
    AssetId, DecodedBurn, DecodedIssuance, DecodedIssueAction, DecodedTransaction, TxId,
};
use orchard::note::{AssetBase, AssetId as OrchardAssetId};
use zcash_primitives::transaction::{OrchardBundle, Transaction};

/// Decode `tx`, mined at `height` (`None` in the mempool), whose format
/// version the node reported as `version`.
pub fn decode(tx: &Transaction, height: Option<u64>, version: u32) -> DecodedTransaction {
    let mut txid = *tx.txid().as_ref();
    txid.reverse(); // display order, matching the API convention

    let issuance = tx.issue_bundle().map(|bundle| {
        let actions = bundle
            .actions()
            .iter()
            .map(|action| {
                let asset = AssetBase::custom(&OrchardAssetId::new_v0(
                    bundle.ik(),
                    action.asset_desc_hash(),
                ));
                DecodedIssueAction {
                    asset_id: AssetId::from_bytes(asset.to_bytes()),
                    asset_desc_hash: Some(hex::encode(action.asset_desc_hash())),
                    notes: action.notes().len() as u32,
                    amount: action
                        .notes()
                        .iter()
                        .map(|note| note.value().inner())
                        .fold(0u64, u64::saturating_add),
                    finalize: action.is_finalized(),
                    reference_note: action.get_reference_note().is_some(),
                }
            })
            .collect();
        DecodedIssuance {
            issuer: hex::encode(bundle.ik().encode()),
            actions,
        }
    });

    let (orchard_actions, burns) = match tx.orchard_bundle() {
        Some(OrchardBundle::OrchardVanilla(bundle)) => (bundle.actions().len() as u32, Vec::new()),
        Some(OrchardBundle::OrchardZSA(bundle)) => (
            bundle.actions().len() as u32,
            bundle
                .burn()
                .iter()
                .map(|(asset, value)| DecodedBurn {
                    asset_id: AssetId::from_bytes(asset.to_bytes()),
                    amount: value.inner(),
                })
                .collect(),
        ),
        None => (0, Vec::new()),
    };

    let (transparent_inputs, transparent_outputs) = tx
        .transparent_bundle()
        .map(|bundle| (bundle.vin.len() as u32, bundle.vout.len() as u32))
        .unwrap_or_default();
    let (sapling_spends, sapling_outputs) = tx
        .sapling_bundle()
        .map(|bundle| {
            (
                bundle.shielded_spends().len() as u32,
                bundle.shielded_outputs().len() as u32,
            )
        })
        .unwrap_or_default();

    DecodedTransaction {
        txid: TxId::from_bytes(txid),
        height,
        version,
        issuance,
        burns,
        orchard_actions,
        transparent_inputs,
        transparent_outputs,
        sapling_spends,
        sapling_outputs,
    }
}
