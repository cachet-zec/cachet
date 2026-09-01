//! Deterministic in-memory [`ChainBackend`] used by API tests and local
//! development without a node. Not a simulation of consensus — just enough
//! bookkeeping to exercise the issuance flow end to end.

use std::collections::HashMap;
use std::sync::Mutex;

use async_trait::async_trait;
use cachet_domain::{
    AccountBalances, AssetEvent, AssetEventKind, AssetId, AssetState, AssetSummary, BurnRequest,
    CollectionSummary, Holding, IssuanceReceipt, IssuanceRequest, Recipient, TransferRequest, TxId,
};

/// The fake chain has one issuer; this stands in for its ZIP 227 encoded
/// issuance validating key (33 bytes of zeros, hex).
fn memory_issuer() -> String {
    "00".repeat(33)
}

use crate::{ChainBackend, ChainError, ChainInfo};

/// The wallet's own holdings are modelled as `Recipient::Internal { 0 }`,
/// mirroring the real backend where account 0 receives issued notes.
fn recipient_key(recipient: &Recipient) -> String {
    match recipient {
        Recipient::Internal { account } => format!("internal:{account}"),
        Recipient::External { address } => format!("external:{address}"),
    }
}

/// In-memory chain state: assets keyed by id, per-recipient balances, plus
/// a block-height counter that advances on every accepted transaction.
#[derive(Debug, Default)]
struct State {
    assets: HashMap<AssetId, AssetState>,
    /// Description journal + creation order, newest last.
    created: Vec<(AssetId, String)>,
    /// The REAL ZIP 227 description hash per asset (personalized
    /// BLAKE2b-256), so description resolution exercises the true
    /// verification path even against this fake chain.
    desc_hashes: HashMap<AssetId, [u8; 32]>,
    balances: HashMap<(AssetId, String), u64>,
    events: Vec<AssetEvent>,
    height: u64,
    tx_counter: u64,
}

/// See module docs. Asset ids and txids are derived deterministically so
/// tests can assert on stable values.
#[derive(Debug, Default)]
pub struct InMemoryChain {
    state: Mutex<State>,
}

impl InMemoryChain {
    pub fn new() -> Self {
        Self::default()
    }

    /// Derive a stable pseudo asset id from the description. The real
    /// backend derives it from the issuer key and description per ZIP 227;
    /// here only determinism matters.
    fn derive_asset_id(description: &str) -> AssetId {
        let mut bytes = [0u8; 32];
        for (i, b) in description.bytes().enumerate() {
            bytes[i % 32] = bytes[i % 32].wrapping_add(b).rotate_left(3);
        }
        AssetId::from_bytes(bytes)
    }

    fn derive_tx_id(counter: u64) -> TxId {
        let mut bytes = [0u8; 32];
        bytes[..8].copy_from_slice(&counter.to_be_bytes());
        TxId::from_bytes(bytes)
    }

    /// ZIP 227 assetDescHash — the real personalized BLAKE2b-256, shared
    /// with the OrchardZSA backend.
    fn real_desc_hash(description: &str) -> [u8; 32] {
        orchard::issuance::compute_asset_desc_hash(
            &nonempty::NonEmpty::from_slice(description.as_bytes())
                .expect("domain guarantees a non-empty description"),
        )
    }

    /// Apply one issuance action to the state (shared by single and batch
    /// issuance; both are one transaction).
    fn apply_issue(
        state: &mut State,
        request: &IssuanceRequest,
        txid: TxId,
    ) -> Result<AssetId, ChainError> {
        let asset_id = Self::derive_asset_id(request.description.as_str());
        if !state.assets.contains_key(&asset_id) {
            state
                .created
                .push((asset_id, request.description.as_str().to_owned()));
            state
                .desc_hashes
                .insert(asset_id, Self::real_desc_hash(request.description.as_str()));
        }
        let entry = state.assets.entry(asset_id).or_insert(AssetState {
            asset_id,
            total_supply: 0,
            finalized: false,
        });

        if entry.finalized {
            return Err(ChainError::AssetFinalized(asset_id));
        }
        entry.total_supply += request.amount;
        entry.finalized = request.finalize;

        let issuer = recipient_key(&Recipient::Internal { account: 0 });
        *state.balances.entry((asset_id, issuer)).or_insert(0) += request.amount;

        let height = state.height;
        state.events.push(AssetEvent {
            asset_id,
            height,
            txid,
            kind: AssetEventKind::Issuance,
            amount: request.amount,
        });
        if request.finalize {
            state.events.push(AssetEvent {
                asset_id,
                height,
                txid,
                kind: AssetEventKind::Finalization,
                amount: 0,
            });
        }
        Ok(asset_id)
    }
}

#[async_trait]
impl ChainBackend for InMemoryChain {
    async fn chain_info(&self) -> Result<ChainInfo, ChainError> {
        let state = self.state.lock().expect("in-memory chain lock poisoned");
        Ok(ChainInfo {
            network: "in-memory".to_owned(),
            tip_height: state.height,
        })
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
        let mut state = self.state.lock().expect("in-memory chain lock poisoned");

        // Reject the whole batch up front: one transaction is atomic, so a
        // finalized asset anywhere must fail everything with no side effect.
        for request in &requests {
            let asset_id = Self::derive_asset_id(request.description.as_str());
            if state.assets.get(&asset_id).is_some_and(|a| a.finalized) {
                return Err(ChainError::AssetFinalized(asset_id));
            }
        }

        state.height += 1;
        state.tx_counter += 1;
        let txid = Self::derive_tx_id(state.tx_counter);

        let mut receipts = Vec::with_capacity(requests.len());
        for request in &requests {
            let asset_id = Self::apply_issue(&mut state, request, txid)?;
            receipts.push(IssuanceReceipt { txid, asset_id });
        }
        Ok(receipts)
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
        let mut state = self.state.lock().expect("in-memory chain lock poisoned");
        let expected = *state
            .desc_hashes
            .get(&asset_id)
            .ok_or(ChainError::UnknownAsset(asset_id))?;
        if Self::real_desc_hash(description) != expected {
            return Err(ChainError::Rejected {
                reason: "description does not hash to the on-chain commitment (ZIP 227)".to_owned(),
            });
        }
        if !state.created.iter().any(|(id, _)| *id == asset_id) {
            state.created.push((asset_id, description.to_owned()));
        }
        Ok(())
    }

    async fn asset_state(&self, asset_id: AssetId) -> Result<AssetSummary, ChainError> {
        let state = self.state.lock().expect("in-memory chain lock poisoned");
        let asset = state
            .assets
            .get(&asset_id)
            .ok_or(ChainError::UnknownAsset(asset_id))?;
        let description = state
            .created
            .iter()
            .find(|(id, _)| *id == asset_id)
            .map(|(_, description)| description.clone());
        Ok(AssetSummary {
            asset_id,
            description,
            issuer: Some(memory_issuer()),
            total_supply: asset.total_supply,
            finalized: asset.finalized,
        })
    }

    async fn list_assets(&self) -> Result<Vec<AssetSummary>, ChainError> {
        let state = self.state.lock().expect("in-memory chain lock poisoned");
        Ok(state
            .created
            .iter()
            .rev()
            .filter_map(|(asset_id, description)| {
                state.assets.get(asset_id).map(|asset| AssetSummary {
                    asset_id: *asset_id,
                    description: Some(description.clone()),
                    issuer: Some(memory_issuer()),
                    total_supply: asset.total_supply,
                    finalized: asset.finalized,
                })
            })
            .collect())
    }

    async fn collections(&self) -> Result<Vec<CollectionSummary>, ChainError> {
        let state = self.state.lock().expect("in-memory chain lock poisoned");
        if state.assets.is_empty() {
            return Ok(Vec::new());
        }
        Ok(vec![CollectionSummary {
            issuer: memory_issuer(),
            asset_count: state.assets.len() as u64,
            total_supply: state.assets.values().map(|a| a.total_supply).sum(),
            finalized_count: state.assets.values().filter(|a| a.finalized).count() as u64,
        }])
    }

    async fn transfer(&self, request: TransferRequest) -> Result<TxId, ChainError> {
        let mut state = self.state.lock().expect("in-memory chain lock poisoned");
        if !state.assets.contains_key(&request.asset_id) {
            return Err(ChainError::UnknownAsset(request.asset_id));
        }

        let issuer = recipient_key(&Recipient::Internal { account: 0 });
        let available = *state
            .balances
            .get(&(request.asset_id, issuer.clone()))
            .unwrap_or(&0);
        if available < request.amount {
            return Err(ChainError::InsufficientFunds {
                needed: request.amount,
                available,
            });
        }

        *state
            .balances
            .get_mut(&(request.asset_id, issuer))
            .expect("checked above") -= request.amount;
        let target = recipient_key(&request.recipient);
        *state
            .balances
            .entry((request.asset_id, target))
            .or_insert(0) += request.amount;

        state.height += 1;
        state.tx_counter += 1;
        Ok(Self::derive_tx_id(state.tx_counter))
    }

    async fn burn(&self, request: BurnRequest) -> Result<TxId, ChainError> {
        let mut state = self.state.lock().expect("in-memory chain lock poisoned");
        let issuer = recipient_key(&Recipient::Internal { account: 0 });
        let available = *state
            .balances
            .get(&(request.asset_id, issuer.clone()))
            .unwrap_or(&0);

        let Some(asset) = state.assets.get_mut(&request.asset_id) else {
            return Err(ChainError::UnknownAsset(request.asset_id));
        };
        if available < request.amount {
            return Err(ChainError::InsufficientFunds {
                needed: request.amount,
                available,
            });
        }

        asset.total_supply -= request.amount;
        *state
            .balances
            .get_mut(&(request.asset_id, issuer))
            .expect("checked above") -= request.amount;

        state.height += 1;
        state.tx_counter += 1;
        let txid = Self::derive_tx_id(state.tx_counter);
        let height = state.height;
        state.events.push(AssetEvent {
            asset_id: request.asset_id,
            height,
            txid,
            kind: AssetEventKind::Burn,
            amount: request.amount,
        });
        Ok(txid)
    }

    async fn wallet_balances(&self) -> Result<Vec<AccountBalances>, ChainError> {
        let state = self.state.lock().expect("in-memory chain lock poisoned");
        let mut per_account: std::collections::BTreeMap<u32, Vec<Holding>> = Default::default();
        for ((asset_id, holder), amount) in &state.balances {
            if *amount == 0 {
                continue;
            }
            if let Some(account) = holder
                .strip_prefix("internal:")
                .and_then(|value| value.parse::<u32>().ok())
            {
                per_account.entry(account).or_default().push(Holding {
                    asset_id: *asset_id,
                    amount: *amount,
                });
            }
        }
        Ok(per_account
            .into_iter()
            .map(|(account, mut holdings)| {
                holdings.sort_by_key(|holding| holding.asset_id);
                AccountBalances { account, holdings }
            })
            .collect())
    }

    async fn asset_events(&self, asset_id: AssetId) -> Result<Vec<AssetEvent>, ChainError> {
        let state = self.state.lock().expect("in-memory chain lock poisoned");
        Ok(state
            .events
            .iter()
            .filter(|event| event.asset_id == asset_id)
            .cloned()
            .collect())
    }

    async fn relay(&self, _tx_bytes: Vec<u8>) -> Result<crate::RelayReceipt, ChainError> {
        Err(ChainError::Rejected {
            reason: "relaying signed transactions requires the OrchardZSA backend".to_owned(),
        })
    }

    async fn raw_transactions(
        &self,
        _start_height: u64,
        _limit: u64,
    ) -> Result<crate::RawBlocks, ChainError> {
        Err(ChainError::Unavailable {
            reason: "raw transactions require the OrchardZSA backend".to_owned(),
        })
    }
}

#[cfg(test)]
mod tests {
    use cachet_domain::AssetDescription;

    use super::*;

    fn request(description: &str, amount: u64, finalize: bool) -> IssuanceRequest {
        IssuanceRequest::new(
            AssetDescription::new(description).unwrap(),
            amount,
            finalize,
        )
        .unwrap()
    }

    #[tokio::test]
    async fn issue_then_read_state() {
        let chain = InMemoryChain::new();
        chain.issue(request("Gold", 100, false)).await.unwrap();
        chain.issue(request("Gold", 50, false)).await.unwrap();

        let id = InMemoryChain::derive_asset_id("Gold");
        let state = chain.asset_state(id).await.unwrap();
        assert_eq!(state.total_supply, 150);
        assert!(!state.finalized);
    }

    #[tokio::test]
    async fn finalization_blocks_further_issuance() {
        let chain = InMemoryChain::new();
        chain.issue(request("Ticket", 10, true)).await.unwrap();

        let err = chain.issue(request("Ticket", 1, false)).await.unwrap_err();
        assert!(matches!(err, ChainError::AssetFinalized(_)));
    }

    #[tokio::test]
    async fn unknown_asset_is_an_error() {
        let chain = InMemoryChain::new();
        let missing = AssetId::from_bytes([9; 32]);
        assert!(matches!(
            chain.asset_state(missing).await.unwrap_err(),
            ChainError::UnknownAsset(_)
        ));
    }
}
