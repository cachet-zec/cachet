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
use orchard::keys::{
    FullViewingKey, IncomingViewingKey, PreparedIncomingViewingKey, Scope, SpendingKey,
};
use orchard::note::AssetBase;
use orchard::primitives::OrchardDomain;
use orchard::tree::{MerkleHashOrchard, MerklePath};
use orchard::{Address, Anchor, Note};
use zcash_note_encryption::try_note_decryption;
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
    // Derived once: each derivation is a Sinsemilla commitment, and a scan
    // needs them for every transaction of the chain.
    ivk_external: IncomingViewingKey,
    ivk_internal: IncomingViewingKey,
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

/// Diversifier index of the address an issuer mints to.
///
/// An issuance bundle writes each issued note's recipient in clear. Minting
/// to the default address (index 0) would publish, next to the issuer key,
/// the very address people hand out to be paid. Diversified addresses of one
/// key cannot be linked without its viewing key, so a dedicated index keeps
/// the two apart. The wallet finds the notes either way.
pub const ISSUANCE_DIVERSIFIER: u32 = 1;

pub struct HotWallet {
    accounts: Vec<Account>,
    /// The accounts' external viewing keys, prepared for trial decryption,
    /// in account order.
    prepared: Vec<PreparedIncomingViewingKey>,
    /// Accounts that only ever receive from this wallet's own spends (a
    /// browser wallet's swap slots), in account order: tried on a
    /// transaction only when it spends one of our notes.
    own_spends_only: Vec<bool>,
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
                let ivk_external = full_viewing_key.to_ivk(Scope::External);
                Account {
                    index,
                    spending_key,
                    address: full_viewing_key.address_at(0u32, Scope::External),
                    ivk_internal: full_viewing_key.to_ivk(Scope::Internal),
                    ivk_external,
                    full_viewing_key,
                }
            })
            .collect::<Vec<Account>>();
        let prepared = accounts
            .iter()
            .map(|account| PreparedIncomingViewingKey::new(&account.ivk_external))
            .collect();
        let own_spends_only = vec![false; accounts.len()];
        Self {
            accounts,
            prepared,
            own_spends_only,
            tree: BridgeTree::new(MAX_CHECKPOINTS),
            notes: Vec::new(),
        }
    }

    /// Say which accounts receive only what this wallet sends them itself,
    /// such as one-off swap slots funded from the main account. A scan then
    /// tries their keys only on transactions that spend one of our notes,
    /// instead of on every action of the chain, and never on issuance. A
    /// note sent to such an account by anybody else is not found.
    pub fn receiving_only_from_own_spends(mut self, accounts: &[u32]) -> Self {
        for (flag, account) in self.own_spends_only.iter_mut().zip(&self.accounts) {
            *flag = accounts.contains(&account.index);
        }
        self
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
            // The first account whose external key decrypts an action owns
            // it, as `Bundle::decrypt_outputs_with_keys` would say, with
            // the keys prepared once for the whole scan.
            macro_rules! trial_decrypt {
                ($bundle:expr) => {{
                    orchard_action_count = $bundle.actions().len();
                    let spends_ours = self
                        .mark_spends($bundle.actions().iter().map(|a| a.nullifier().to_bytes()));
                    for (action_idx, action) in $bundle.actions().iter().enumerate() {
                        let domain = OrchardDomain::for_action(action);
                        if let Some((slot, note)) = self
                            .prepared
                            .iter()
                            .zip(&self.own_spends_only)
                            .enumerate()
                            .filter(|(_, (_, own_only))| spends_ours || !**own_only)
                            .find_map(|(slot, (ivk, _))| {
                                try_note_decryption(&domain, ivk, action)
                                    .map(|(note, _, _)| (slot, note))
                            })
                        {
                            received.push((action_idx, note, slot));
                        }
                    }
                }};
            }
            match bundle {
                OrchardBundle::OrchardVanilla(bundle) => trial_decrypt!(bundle),
                OrchardBundle::OrchardZSA(bundle) => trial_decrypt!(bundle),
            }
        }

        // 2. Notes issued to us: issuance notes are plaintext, matched by
        //    key, so any diversified address of an account counts (issuers
        //    mint to a dedicated one, see `ISSUANCE_DIVERSIFIER`). Reference
        //    notes go to the protocol's reference recipient and match no key.
        if let Some(issue_bundle) = tx.issue_bundle() {
            for (issue_idx, note) in issue_bundle
                .actions()
                .iter()
                .flat_map(|action| action.notes())
                .enumerate()
            {
                // `FullViewingKey::scope_for_address`, with the keys derived
                // once instead of twice per note and account.
                // Accounts fed only by our own spends never receive issuance.
                let recipient = note.recipient();
                if let Some(slot) = self.accounts.iter().zip(&self.own_spends_only).position(
                    |(account, own_only)| {
                        !own_only
                            && (account.ivk_external.diversifier_index(&recipient).is_some()
                                || account.ivk_internal.diversifier_index(&recipient).is_some())
                    },
                ) {
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

    /// Mark our notes these nullifiers spend; true if there was one.
    fn mark_spends(&mut self, nullifiers: impl Iterator<Item = [u8; 32]>) -> bool {
        let mut any = false;
        for nullifier in nullifiers {
            if let Some(owned) = self
                .notes
                .iter_mut()
                .find(|note| note.nullifier == nullifier)
            {
                owned.spent = true;
                any = true;
            }
        }
        any
    }

    /// Close a block: the tree state after it stays available as an anchor
    /// for the last `MAX_CHECKPOINTS` blocks. Call once per block, after
    /// its transactions, in height order. A swap needs it: both parties
    /// must witness their notes against the SAME anchor, and the other
    /// party's anchor is rarely this wallet's current one.
    pub fn checkpoint(&mut self, height: u32) {
        self.tree.checkpoint(height);
    }

    /// How many checkpoints back `anchor` sits (0: the current state).
    fn checkpoint_depth(&self, anchor: &Anchor) -> Option<usize> {
        (0..=MAX_CHECKPOINTS).find(|&depth| {
            self.tree
                .root(depth)
                .is_some_and(|root| Anchor::from(root) == *anchor)
        })
    }

    /// Whether this wallet can witness its notes against `anchor`.
    pub fn knows_anchor(&self, anchor: &Anchor) -> bool {
        self.checkpoint_depth(anchor).is_some()
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
        self.select_inputs_at_depth(account, asset, amount, 0)
    }

    /// Every unspent note of `account`, each with its path at the current
    /// anchor (a swap offer hands one over whole).
    pub fn unspent_notes(&self, account: u32) -> Result<Vec<(Note, MerklePath)>, NotesError> {
        self.notes
            .iter()
            .filter(|owned| !owned.spent && self.accounts[owned.account_slot].index == account)
            .map(|owned| {
                let witness = self.tree.witness(owned.position, 0).map_err(|error| {
                    NotesError::Tree(format!(
                        "could not witness note at {:?}: {error:?}",
                        owned.position
                    ))
                })?;
                let path = MerklePath::from_parts(
                    u64::from(owned.position) as u32,
                    witness
                        .try_into()
                        .map_err(|_| NotesError::Tree("witness has unexpected depth".to_owned()))?,
                );
                Ok((owned.note, path))
            })
            .collect()
    }

    /// Like `select_inputs`, with every path witnessed against `anchor`
    /// (the current state or one of the last `MAX_CHECKPOINTS` blocks).
    pub fn select_inputs_at(
        &self,
        account: u32,
        asset: AssetBase,
        amount: u64,
        anchor: &Anchor,
    ) -> Result<SelectedInputs, NotesError> {
        let depth = self.checkpoint_depth(anchor).ok_or_else(|| {
            NotesError::Tree("this wallet has not seen that anchor in its recent blocks".to_owned())
        })?;
        self.select_inputs_at_depth(account, asset, amount, depth)
    }

    fn select_inputs_at_depth(
        &self,
        account: u32,
        asset: AssetBase,
        amount: u64,
        depth: usize,
    ) -> Result<SelectedInputs, NotesError> {
        let mut inputs = Vec::new();
        let mut total = 0u64;

        for owned in self.notes.iter().filter(|owned| {
            !owned.spent
                && owned.note.asset() == asset
                && self.accounts[owned.account_slot].index == account
        }) {
            let witness = self.tree.witness(owned.position, depth).map_err(|error| {
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
