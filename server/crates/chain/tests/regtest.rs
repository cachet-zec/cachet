//! Integration tests against a live OrchardZSA regtest node.
//!
//! Ignored by default: they need the docker-compose stack up
//! (`docker compose -f infra/docker-compose.yml up -d`) **on a fresh chain**
//! and the Sapling parameters installed (docs/SETUP.md). Run with:
//!
//! ```bash
//! cargo test -p cachet-chain --test regtest -- --ignored --test-threads=1
//! ```

use cachet_chain::zsa::{OrchardZsaBackend, ZsaConfig};
use cachet_chain::{ChainBackend, ChainError};
use cachet_domain::{AssetDescription, BurnRequest, IssuanceRequest, Recipient, TransferRequest};

fn backend() -> OrchardZsaBackend {
    let node_url =
        std::env::var("CACHET_NODE_URL").unwrap_or_else(|_| "http://127.0.0.1:18232".to_owned());
    OrchardZsaBackend::new(ZsaConfig::regtest(node_url)).expect("valid regtest config")
}

fn unique_description(prefix: &str) -> AssetDescription {
    // Distinct per run so tests don't collide on a shared chain.
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("system clock after epoch")
        .subsec_nanos();
    AssetDescription::new(format!("CACHET-{prefix}-{nanos:08x}")).expect("valid description")
}

#[tokio::test]
#[ignore = "requires a running regtest node and Sapling params"]
async fn chain_info_reports_regtest() {
    let info = backend().chain_info().await.expect("node reachable");
    assert_eq!(info.network, "regtest");
}

#[tokio::test]
#[ignore = "requires a running regtest node and Sapling params"]
async fn issue_then_read_supply() {
    let backend = backend();
    let description = unique_description("SUPPLY");

    let request = IssuanceRequest::new(description.clone(), 1000, false).unwrap();
    let receipt = backend.issue(request).await.expect("issuance accepted");
    assert_eq!(receipt.txid.to_string().len(), 64);

    // The receipt's asset id must match the standalone derivation.
    let asset_id = backend
        .asset_id_for_description(description.as_str())
        .expect("derivable asset id");
    assert_eq!(receipt.asset_id, asset_id);

    // Reissue under the same description: supply accumulates.
    let request = IssuanceRequest::new(description.clone(), 500, false).unwrap();
    backend.issue(request).await.expect("reissuance accepted");

    let state = backend.asset_state(asset_id).await.expect("asset found");
    assert_eq!(state.total_supply, 1500);
    assert!(!state.finalized);
}

#[tokio::test]
#[ignore = "requires a running regtest node and Sapling params"]
async fn finalized_asset_rejects_reissue() {
    let backend = backend();
    let description = unique_description("FINAL");

    let request = IssuanceRequest::new(description.clone(), 10, true).unwrap();
    backend.issue(request).await.expect("issuance accepted");

    let request = IssuanceRequest::new(description.clone(), 1, false).unwrap();
    let error = backend.issue(request).await.expect_err("must be rejected");
    assert!(matches!(error, ChainError::AssetFinalized(_)));

    let asset_id = backend
        .asset_id_for_description(description.as_str())
        .expect("derivable asset id");
    let state = backend.asset_state(asset_id).await.expect("asset found");
    assert_eq!(state.total_supply, 10);
    assert!(state.finalized);
}

#[tokio::test]
#[ignore = "requires a running regtest node and Sapling params"]
async fn full_cycle_issue_transfer_burn() {
    let backend = backend();
    let description = unique_description("CYCLE");

    let request = IssuanceRequest::new(description.clone(), 1000, false).unwrap();
    let receipt = backend.issue(request).await.expect("issuance accepted");
    let asset_id = receipt.asset_id;

    // Transfer 300 to internal account 1 (spends the issuance note,
    // change back to account 0).
    let request = TransferRequest::new(asset_id, 300, Recipient::Internal { account: 1 }).unwrap();
    backend.transfer(request).await.expect("transfer accepted");

    // Burn 200 from account 0's change.
    let request = BurnRequest::new(asset_id, 200).unwrap();
    backend.burn(request).await.expect("burn accepted");

    // Supply reflects the burn but not the transfer.
    let state = backend.asset_state(asset_id).await.expect("asset found");
    assert_eq!(state.total_supply, 800);
    assert!(!state.finalized);

    // Spending more than account 0 holds (500 left) must fail cleanly.
    let request =
        TransferRequest::new(asset_id, 10_000, Recipient::Internal { account: 1 }).unwrap();
    let error = backend.transfer(request).await.expect_err("must fail");
    assert!(matches!(error, ChainError::InsufficientFunds { .. }));
}

#[tokio::test]
#[ignore = "requires a running regtest node and Sapling params"]
async fn listing_includes_issued_assets() {
    let backend = backend();
    let description = unique_description("LIST");

    let request = IssuanceRequest::new(description.clone(), 42, false).unwrap();
    let receipt = backend.issue(request).await.expect("issuance accepted");

    let assets = backend.list_assets().await.expect("listing works");
    let ours = assets
        .iter()
        .find(|summary| summary.asset_id == receipt.asset_id)
        .expect("issued asset appears in the listing");
    assert_eq!(ours.total_supply, 42);
    assert!(!ours.finalized);
}

#[tokio::test]
#[ignore = "requires a running regtest node and Sapling params"]
async fn unknown_asset_stays_unknown() {
    let backend = backend();
    let missing = "11".repeat(32).parse().unwrap();
    let error = backend.asset_state(missing).await.expect_err("not found");
    assert!(matches!(error, ChainError::UnknownAsset(_)));
}

#[tokio::test]
#[ignore = "requires a running regtest node and Sapling params"]
async fn batch_issuance_mints_distinct_assets_in_one_transaction() {
    let backend = backend();
    let descriptions: Vec<AssetDescription> = ["BATCH-A", "BATCH-B", "BATCH-C"]
        .iter()
        .map(|prefix| unique_description(prefix))
        .collect();

    let requests = vec![
        IssuanceRequest::new(descriptions[0].clone(), 1, true).unwrap(),
        IssuanceRequest::new(descriptions[1].clone(), 1, true).unwrap(),
        IssuanceRequest::new(descriptions[2].clone(), 100, false).unwrap(),
    ];
    let receipts = backend.issue_batch(requests).await.expect("batch accepted");
    assert_eq!(receipts.len(), 3);

    // One bundle, one transaction: every receipt shares the txid, and the
    // asset ids are pairwise distinct.
    assert!(receipts.iter().all(|r| r.txid == receipts[0].txid));
    assert_ne!(receipts[0].asset_id, receipts[1].asset_id);
    assert_ne!(receipts[1].asset_id, receipts[2].asset_id);

    // Chain state reflects each item's own amount and finalization.
    for (receipt, (supply, finalized)) in receipts.iter().zip([(1, true), (1, true), (100, false)])
    {
        let state = backend
            .asset_state(receipt.asset_id)
            .await
            .expect("asset found");
        assert_eq!(state.total_supply, supply);
        assert_eq!(state.finalized, finalized);
    }
}
