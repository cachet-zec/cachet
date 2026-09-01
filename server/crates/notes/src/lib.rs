//! Minimal in-memory Orchard note tracking, shared between the server's
//! hot wallet (cachet-chain) and the browser mint engine (compiled to
//! WebAssembly): trial decryption of Orchard outputs, plaintext issuance
//! notes, nullifier tracking, and a bridge tree that can witness owned
//! notes for spending. No I/O and no key derivation here — callers feed
//! parsed transactions in consensus order and provide spending keys.
//!
//! Correctness hinges on one invariant: note commitments must enter the
//! tree in exactly the consensus order — for each transaction, every
//! Orchard action's `cmx` first, then every issuance note's commitment,
//! transactions in block order, blocks in height order.

use bridgetree::BridgeTree;
use incrementalmerkletree::Position;
use orchard::keys::{FullViewingKey, IncomingViewingKey, Scope, SpendingKey};
use orchard::note::AssetBase;
use orchard::tree::{MerkleHashOrchard, MerklePath};
use orchard::{Address, Anchor, Note};
use zcash_primitives::transaction::{OrchardBundle, Transaction};

const TREE_DEPTH: u8 = 32;
const MAX_CHECKPOINTS: usize = 100;

#[derive(Debug, thiserror::Error)]
pub enum NotesError {
    #[error("commitment tree unavailable: {0}")]
    Tree(String),
    #[error("insufficient funds: needed {needed}, available {available}")]
    InsufficientFunds { needed: u64, available: u64 },
}

struct Account {
    index: u32,
    spending_key: SpendingKey,
    full_viewing_key: FullViewingKey,
    address: Address,
}

/// A note we can spend, with everything needed to build the spend.
struct OwnedNote {
    note: Note,
    account_slot: usize,
    position: Position,
    nullifier: [u8; 32],
    spent: bool,
}

/// An asset (raw id bytes) and a spendable amount of it.
pub type AssetAmount = ([u8; 32], u64);

/// Inputs selected for a spend: the notes plus their auth material.
pub struct SelectedInputs {
    pub inputs: Vec<(SpendingKey, Note, MerklePath)>,
    pub total: u64,
}

pub struct HotWallet {
    accounts: Vec<Account>,
    tree: BridgeTree<MerkleHashOrchard, u32, TREE_DEPTH>,
    notes: Vec<OwnedNote>,
}

impl HotWallet {
    /// Track the given accounts (ZIP-32 account index + spending key).
    pub fn from_spending_keys(keys: impl IntoIterator<Item = (u32, SpendingKey)>) -> Self {
        let accounts = keys
            .into_iter()
            .map(|(index, spending_key)| {
                let full_viewing_key = FullViewingKey::from(&spending_key);
                Account {
                    index,
                    spending_key,
                    address: full_viewing_key.address_at(0u32, Scope::External),
                    full_viewing_key,
                }
            })
            .collect();
        Self {
            accounts,
            tree: BridgeTree::new(MAX_CHECKPOINTS),
            notes: Vec::new(),
        }
    }

    pub fn account_address(&self, account: u32) -> Option<Address> {
        self.accounts
            .iter()
            .find(|candidate| candidate.index == account)
            .map(|account| account.address)
    }

    /// Process one transaction, in consensus order. Must be called for every
    /// transaction of every block from activation to the tip.
    pub fn process_transaction(&mut self, tx: &Transaction) -> Result<(), NotesError> {
        // 1. Notes sent to us through the Orchard bundle (trial decryption),
        //    and spends of our notes (nullifier match).
        let mut received: Vec<(usize, Note, usize)> = Vec::new(); // (commitment index, note, account slot)
        let mut orchard_action_count = 0;

        if let Some(bundle) = tx.orchard_bundle() {
            let ivks: Vec<IncomingViewingKey> = self
                .accounts
                .iter()
                .map(|account| account.full_viewing_key.to_ivk(Scope::External))
                .collect();

            match bundle {
                OrchardBundle::OrchardVanilla(bundle) => {
                    orchard_action_count = bundle.actions().len();
                    for (action_idx, ivk, note, _recipient, _memo) in
                        bundle.decrypt_outputs_with_keys(&ivks)
                    {
                        if let Some(slot) = ivks.iter().position(|known| *known == ivk) {
                            received.push((action_idx, note, slot));
                        }
                    }
                    self.mark_spends(bundle.actions().iter().map(|a| a.nullifier().to_bytes()));
                }
                OrchardBundle::OrchardZSA(bundle) => {
                    orchard_action_count = bundle.actions().len();
                    for (action_idx, ivk, note, _recipient, _memo) in
                        bundle.decrypt_outputs_with_keys(&ivks)
                    {
                        if let Some(slot) = ivks.iter().position(|known| *known == ivk) {
                            received.push((action_idx, note, slot));
                        }
                    }
                    self.mark_spends(bundle.actions().iter().map(|a| a.nullifier().to_bytes()));
                }
            }
        }

        // 2. Notes issued to us: issuance notes are plaintext, matched by
        //    recipient address. Reference notes go to the protocol's
        //    reference recipient and are skipped naturally.
        if let Some(issue_bundle) = tx.issue_bundle() {
            for (issue_idx, note) in issue_bundle
                .actions()
                .iter()
                .flat_map(|action| action.notes())
                .enumerate()
            {
                if let Some(slot) = self
                    .accounts
                    .iter()
                    .position(|account| account.address == note.recipient())
                {
                    received.push((orchard_action_count + issue_idx, *note, slot));
                }
            }
        }

        // 3. Append every commitment in consensus order; mark ours to keep
        //    witnesses.
        let mut commitments: Vec<MerkleHashOrchard> = Vec::new();
        if let Some(bundle) = tx.orchard_bundle() {
            match bundle {
                OrchardBundle::OrchardVanilla(bundle) => {
                    commitments.extend(
                        bundle
                            .actions()
                            .iter()
                            .map(|a| MerkleHashOrchard::from_cmx(a.cmx())),
                    );
                }
                OrchardBundle::OrchardZSA(bundle) => {
                    commitments.extend(
                        bundle
                            .actions()
                            .iter()
                            .map(|a| MerkleHashOrchard::from_cmx(a.cmx())),
                    );
                }
            }
        }
        if let Some(issue_bundle) = tx.issue_bundle() {
            commitments.extend(
                issue_bundle
                    .actions()
                    .iter()
                    .flat_map(|action| action.notes())
                    .map(|note| MerkleHashOrchard::from_cmx(&note.commitment().into())),
            );
        }

        for (commitment_idx, commitment) in commitments.into_iter().enumerate() {
            if !self.tree.append(commitment) {
                return Err(NotesError::Tree("note commitment tree is full".to_owned()));
            }
            if let Some((_, note, slot)) =
                received.iter().find(|(idx, _, _)| *idx == commitment_idx)
            {
                let position = self.tree.mark().expect("tree is non-empty after append");
                let account = &self.accounts[*slot];
                self.notes.push(OwnedNote {
                    nullifier: note.nullifier(&account.full_viewing_key).to_bytes(),
                    note: *note,
                    account_slot: *slot,
                    position,
                    spent: false,
                });
            }
        }
        Ok(())
    }

    fn mark_spends(&mut self, nullifiers: impl Iterator<Item = [u8; 32]>) {
        for nullifier in nullifiers {
            if let Some(owned) = self
                .notes
                .iter_mut()
                .find(|note| note.nullifier == nullifier)
            {
                owned.spent = true;
            }
        }
    }

    /// Anchor of the current tree state, valid for spends of any marked note.
    pub fn anchor(&self) -> Result<Anchor, NotesError> {
        self.tree.root(0).map(Anchor::from).ok_or_else(|| {
            NotesError::Tree("commitment tree has no root at checkpoint depth 0".to_owned())
        })
    }

    /// All spendable holdings grouped per account, nonzero only, assets in
    /// stable byte order.
    pub fn balances_by_account(&self) -> Vec<(u32, Vec<AssetAmount>)> {
        let mut per_account: std::collections::BTreeMap<
            u32,
            std::collections::BTreeMap<[u8; 32], u64>,
        > = Default::default();
        for owned in self.notes.iter().filter(|owned| !owned.spent) {
            let account = self.accounts[owned.account_slot].index;
            *per_account
                .entry(account)
                .or_default()
                .entry(owned.note.asset().to_bytes())
                .or_insert(0) += owned.note.value().inner();
        }
        per_account
            .into_iter()
            .map(|(account, holdings)| {
                // Zero-value entries are padding notes (the zatoshi dummy
                // output every issuance carries), not holdings.
                (
                    account,
                    holdings
                        .into_iter()
                        .filter(|(_, amount)| *amount > 0)
                        .collect(),
                )
            })
            .filter(|(_, holdings): &(u32, Vec<AssetAmount>)| !holdings.is_empty())
            .collect()
    }

    /// Spendable balance of `asset` for `account`.
    pub fn balance(&self, account: u32, asset: AssetBase) -> u64 {
        self.notes
            .iter()
            .filter(|owned| {
                !owned.spent
                    && owned.note.asset() == asset
                    && self.accounts[owned.account_slot].index == account
            })
            .map(|owned| owned.note.value().inner())
            .sum()
    }

    /// Select unspent notes of `asset` from `account` covering `amount`.
    pub fn select_inputs(
        &self,
        account: u32,
        asset: AssetBase,
        amount: u64,
    ) -> Result<SelectedInputs, NotesError> {
        let mut inputs = Vec::new();
        let mut total = 0u64;

        for owned in self.notes.iter().filter(|owned| {
            !owned.spent
                && owned.note.asset() == asset
                && self.accounts[owned.account_slot].index == account
        }) {
            let witness = self.tree.witness(owned.position, 0).map_err(|error| {
                NotesError::Tree(format!(
                    "could not witness note at {:?}: {error:?}",
                    owned.position
                ))
            })?;
            let merkle_path = MerklePath::from_parts(
                u64::from(owned.position) as u32,
                witness
                    .try_into()
                    .map_err(|_| NotesError::Tree("witness has unexpected depth".to_owned()))?,
            );
            inputs.push((
                self.accounts[owned.account_slot].spending_key,
                owned.note,
                merkle_path,
            ));
            total += owned.note.value().inner();
            if total >= amount {
                break;
            }
        }

        if total < amount {
            return Err(NotesError::InsufficientFunds {
                needed: amount,
                available: self.balance(account, asset),
            });
        }
        Ok(SelectedInputs { inputs, total })
    }
}
