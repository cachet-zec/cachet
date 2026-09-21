//! Issuer key material derived from a BIP-39 seed phrase.
//!
//! Derivation mirrors `zcash_tx_tool`'s wallet exactly (same paths, same
//! regtest coin type), so an asset issued by Cachet from a given phrase has
//! the same asset id the tx_tool would produce — useful for cross-checking
//! against the reference scenarios.
//!
//! Testnet/regtest only (see docs/PRIVACY.md P3): this in-process signer is
//! a milestone-C convenience. Client-side signing replaces it before any
//! mainnet story.

use bip0039::Mnemonic;
use orchard::Address;
use orchard::issuance::auth::{IssueAuthKey, IssueValidatingKey, ZSASchnorr};
use orchard::keys::{FullViewingKey, OutgoingViewingKey, Scope, SpendingKey};
use zcash_protocol::constants;
use zip32::AccountId;

use crate::ChainError;

/// Deterministic issuer identity: issuance authority plus the Orchard
/// account 0 used as the default recipient of issued notes.
#[derive(Clone)]
pub struct IssuerKeys {
    seed: [u8; 64],
}

/// Generate a fresh 24-word BIP-39 seed phrase (for testnet issuers; the
/// tx_tool demo phrase is public and must never be used on shared chains).
pub fn generate_seed_phrase() -> String {
    <Mnemonic>::generate(bip0039::Count::Words24).into_phrase()
}

impl IssuerKeys {
    pub fn from_seed_phrase(seed_phrase: &str) -> Result<Self, ChainError> {
        let mnemonic = <Mnemonic>::from_phrase(seed_phrase).map_err(|_| ChainError::Rejected {
            reason: "invalid BIP-39 seed phrase in issuer configuration".to_owned(),
        })?;
        Ok(Self {
            seed: mnemonic.to_seed(""),
        })
    }

    /// ZIP-32-derived issuance authorizing key (ZSA Schnorr scheme).
    pub fn issuance_key(&self) -> IssueAuthKey<ZSASchnorr> {
        IssueAuthKey::from_zip32_seed(self.seed.as_slice(), constants::regtest::COIN_TYPE, 0)
            .expect("issuance key derivation from a valid 64-byte seed cannot fail")
    }

    pub fn issuance_validating_key(&self) -> IssueValidatingKey<ZSASchnorr> {
        IssueValidatingKey::from(&self.issuance_key())
    }

    /// ZIP-32 spending key for a wallet account.
    pub fn account_spending_key(&self, account: u32) -> SpendingKey {
        SpendingKey::from_zip32_seed(
            self.seed.as_slice(),
            constants::regtest::COIN_TYPE,
            AccountId::try_from(account).expect("small account indices are always valid"),
        )
        .expect("spending key derivation from a valid 64-byte seed cannot fail")
    }

    /// Shielded address of a wallet account (external scope, diversifier 0).
    pub fn account_address(&self, account: u32) -> Address {
        FullViewingKey::from(&self.account_spending_key(account)).address_at(0u32, Scope::External)
    }

    /// The wallet's receiving address: account 0, diversifier 0.
    pub fn default_address(&self) -> Address {
        self.account_address(0)
    }

    /// Where issued units land: public on chain, so never the address the
    /// wallet hands out (see `cachet_notes::ISSUANCE_DIVERSIFIER`).
    pub fn issuance_address(&self) -> Address {
        FullViewingKey::from(&self.account_spending_key(0))
            .address_at(cachet_notes::ISSUANCE_DIVERSIFIER, Scope::External)
    }

    pub fn orchard_ovk(&self) -> OutgoingViewingKey {
        FullViewingKey::from(&self.account_spending_key(0)).to_ovk(Scope::External)
    }
}

impl std::fmt::Debug for IssuerKeys {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Never expose seed material, even in debug output.
        f.debug_struct("IssuerKeys").finish_non_exhaustive()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Issued notes are public, so they must not land on the address the
    /// wallet hands out, yet must still belong to the same account.
    #[test]
    fn issuance_address_is_ours_but_not_the_receiving_address() {
        let keys = IssuerKeys::from_seed_phrase(&generate_seed_phrase()).expect("valid phrase");
        let viewing_key = FullViewingKey::from(&keys.account_spending_key(0));

        assert_ne!(keys.issuance_address(), keys.default_address());
        assert_eq!(
            viewing_key.scope_for_address(&keys.issuance_address()),
            Some(Scope::External)
        );

        let stranger = IssuerKeys::from_seed_phrase(&generate_seed_phrase()).expect("valid phrase");
        assert_eq!(
            viewing_key.scope_for_address(&stranger.issuance_address()),
            None
        );
    }
}
