//! Server-side hot wallet: the shared note-tracking core (cachet-notes)
//! wired to the issuer's derived accounts, with cachet-notes errors mapped
//! into `ChainError`. Rebuilt from a full chain rescan on every mutating
//! request — no persistence by design, the chain is the source of truth.

pub use cachet_notes::{AssetAmount, SelectedInputs};
use cachet_notes::{HotWallet as NotesWallet, NotesError};
use orchard::note::AssetBase;
use orchard::{Address, Anchor};
use zcash_primitives::transaction::Transaction;

use crate::ChainError;
use crate::zsa::keys::IssuerKeys;

/// Accounts tracked by the hot wallet. Account 0 is the issuer/default
/// holder; the others exist so demos can transfer to `Recipient::Internal`.
pub const TRACKED_ACCOUNTS: u32 = 3;

fn map_error(error: NotesError) -> ChainError {
    match error {
        NotesError::Tree(reason) => ChainError::Unavailable { reason },
        NotesError::InsufficientFunds { needed, available } => {
            ChainError::InsufficientFunds { needed, available }
        }
    }
}

pub struct HotWallet {
    inner: NotesWallet,
}

impl HotWallet {
    pub fn new(keys: &IssuerKeys) -> Self {
        Self {
            inner: NotesWallet::from_spending_keys(
                (0..TRACKED_ACCOUNTS).map(|index| (index, keys.account_spending_key(index))),
            ),
        }
    }

    pub fn account_address(&self, account: u32) -> Option<Address> {
        self.inner.account_address(account)
    }

    /// Process one transaction, in consensus order. Must be called for every
    /// transaction of every block from activation to the tip.
    pub fn process_transaction(&mut self, tx: &Transaction) -> Result<(), ChainError> {
        self.inner.process_transaction(tx).map_err(map_error)
    }

    /// Anchor of the current tree state, valid for spends of any marked note.
    pub fn anchor(&self) -> Result<Anchor, ChainError> {
        self.inner.anchor().map_err(map_error)
    }

    /// All spendable holdings grouped per account, nonzero only, assets in
    /// stable byte order.
    pub fn balances_by_account(&self) -> Vec<(u32, Vec<AssetAmount>)> {
        self.inner.balances_by_account()
    }

    /// Select unspent notes of `asset` from `account` covering `amount`.
    pub fn select_inputs(
        &self,
        account: u32,
        asset: AssetBase,
        amount: u64,
    ) -> Result<SelectedInputs, ChainError> {
        self.inner
            .select_inputs(account, asset, amount)
            .map_err(map_error)
    }
}
