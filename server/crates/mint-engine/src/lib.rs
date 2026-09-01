//! Browser-side issuance for Cachet.
//!
//! Everything that touches key material happens HERE, inside the user's
//! browser: seed generation, ZIP-32 derivation, transaction building,
//! Halo2 proving and BIP-340 signing. The server only ever sees the final
//! signed bytes, which it relays to the chain — it can refuse to relay,
//! it can never spend, reissue or impersonate.
//!
//! Derivation mirrors `cachet-chain`'s issuer wallet (same paths, same
//! regtest coin type as the public ZSA testnet), so an asset minted in the
//! browser from a given phrase is byte-identical to one the server-side
//! signer would have produced.

use bip0039::Mnemonic;
use nonempty::NonEmpty;
use orchard::issuance::auth::{IssueAuthKey, IssueValidatingKey, ZSASchnorr};
use orchard::issuance::{IssueInfo, compute_asset_desc_hash};
use orchard::keys::{FullViewingKey, OutgoingViewingKey, Scope, SpendingKey};
use orchard::note::{AssetBase, AssetId as OrchardAssetId};
use orchard::value::NoteValue;
use orchard::{Address, Anchor};
use serde::Serialize;
use wasm_bindgen::prelude::*;
use zcash_primitives::transaction::builder::{BuildConfig, Builder};
use zcash_primitives::transaction::fees::zip317::{FeeError, FeeRule};
use zcash_protocol::consensus::REGTEST_NETWORK;
use zcash_protocol::constants;
use zcash_protocol::memo::MemoBytes;
use zcash_protocol::value::Zatoshis;
use zcash_transparent::builder::TransparentSigningSet;
use zip32::AccountId;

// Threaded builds expose `initThreadPool` to JS: the worker calls it with
// `navigator.hardwareConcurrency` before proving, and rayon fans the
// Halo2 work out over shared-memory wasm threads.
#[cfg(all(feature = "threads", target_arch = "wasm32"))]
pub use wasm_bindgen_rayon::init_thread_pool;

/// Build (and cache, process-wide) the Orchard proving key so the next
/// `build_issuance_tx` skips its most expensive step. The worker calls
/// this off the critical path, while the user is still filling the form;
/// the vendored proving-key cache (vendor/librustzcash/README.md) keeps
/// the key for every later mint in the session.
#[wasm_bindgen]
pub fn prepare_proving() {
    zcash_primitives::transaction::builder::prepare_orchard_zsa_proving_key();
}

/// Derived issuer identity (mirror of `cachet-chain`'s `IssuerKeys`).
struct Keys {
    seed: [u8; 64],
}

impl Keys {
    fn from_phrase(phrase: &str) -> Result<Self, JsError> {
        let mnemonic = <Mnemonic>::from_phrase(phrase)
            .map_err(|_| JsError::new("invalid BIP-39 seed phrase"))?;
        Ok(Self {
            seed: mnemonic.to_seed(""),
        })
    }

    fn issuance_key(&self) -> IssueAuthKey<ZSASchnorr> {
        IssueAuthKey::from_zip32_seed(self.seed.as_slice(), constants::regtest::COIN_TYPE, 0)
            .expect("issuance key derivation from a valid 64-byte seed cannot fail")
    }

    fn issuance_validating_key(&self) -> IssueValidatingKey<ZSASchnorr> {
        IssueValidatingKey::from(&self.issuance_key())
    }

    fn spending_key(&self) -> SpendingKey {
        SpendingKey::from_zip32_seed(
            self.seed.as_slice(),
            constants::regtest::COIN_TYPE,
            AccountId::ZERO,
        )
        .expect("spending key derivation from a valid 64-byte seed cannot fail")
    }

    fn default_address(&self) -> Address {
        FullViewingKey::from(&self.spending_key()).address_at(0u32, Scope::External)
    }

    fn orchard_ovk(&self) -> OutgoingViewingKey {
        FullViewingKey::from(&self.spending_key()).to_ovk(Scope::External)
    }

    fn asset_for(&self, description: &str) -> Result<AssetBase, JsError> {
        let hash = desc_hash(description)?;
        Ok(AssetBase::custom(&OrchardAssetId::new_v0(
            &self.issuance_validating_key(),
            &hash,
        )))
    }
}

fn desc_hash(description: &str) -> Result<[u8; 32], JsError> {
    Ok(compute_asset_desc_hash(
        &NonEmpty::from_slice(description.as_bytes())
            .ok_or_else(|| JsError::new("description must not be empty"))?,
    ))
}

/// The transaction we build carries no Sapling components, so the Sapling
/// provers required by the builder's signature are never invoked. These
/// stubs make that explicit — reaching them is a bug.
struct NoSapling;

impl sapling_crypto::prover::SpendProver for NoSapling {
    type Proof = sapling_crypto::bundle::GrothProofBytes;

    fn prepare_circuit(
        _: sapling_crypto::ProofGenerationKey,
        _: sapling_crypto::Diversifier,
        _: sapling_crypto::Rseed,
        _: sapling_crypto::value::NoteValue,
        _: jubjub::Fr,
        _: sapling_crypto::value::ValueCommitTrapdoor,
        _: bls12_381::Scalar,
        _: sapling_crypto::MerklePath,
    ) -> Option<sapling_crypto::circuit::Spend> {
        unimplemented!("no sapling components in issuance transactions")
    }

    fn create_proof<R: rand::RngCore>(
        &self,
        _: sapling_crypto::circuit::Spend,
        _: &mut R,
    ) -> Self::Proof {
        unimplemented!("no sapling components in issuance transactions")
    }

    fn encode_proof(proof: Self::Proof) -> sapling_crypto::bundle::GrothProofBytes {
        proof
    }
}

impl sapling_crypto::prover::OutputProver for NoSapling {
    type Proof = sapling_crypto::bundle::GrothProofBytes;

    fn prepare_circuit(
        _: &sapling_crypto::keys::EphemeralSecretKey,
        _: sapling_crypto::PaymentAddress,
        _: jubjub::Fr,
        _: sapling_crypto::value::NoteValue,
        _: sapling_crypto::value::ValueCommitTrapdoor,
    ) -> sapling_crypto::circuit::Output {
        unimplemented!("no sapling components in issuance transactions")
    }

    fn create_proof<R: rand::RngCore>(
        &self,
        _: sapling_crypto::circuit::Output,
        _: &mut R,
    ) -> Self::Proof {
        unimplemented!("no sapling components in issuance transactions")
    }

    fn encode_proof(proof: Self::Proof) -> sapling_crypto::bundle::GrothProofBytes {
        proof
    }
}

/// Generate a fresh 24-word BIP-39 seed phrase. Called in the browser;
/// the phrase is displayed to the user and never leaves the page.
#[wasm_bindgen]
pub fn generate_seed_phrase() -> String {
    <Mnemonic>::generate(bip0039::Count::Words24).into_phrase()
}

#[derive(Serialize)]
struct IssuerInfo {
    /// Issuance validating key, ZIP 227 canonical encoding, hex.
    issuer: String,
    /// The asset id `description` would mint under this issuer.
    asset_id: String,
}

/// Derive the issuer identity a phrase produces, and the asset id a given
/// description would mint under it (ZIP 227: identity is derived, never
/// assigned).
#[wasm_bindgen]
pub fn issuer_info(seed_phrase: &str, description: &str) -> Result<JsValue, JsError> {
    let keys = Keys::from_phrase(seed_phrase)?;
    let info = IssuerInfo {
        issuer: hex::encode(keys.issuance_validating_key().encode()),
        asset_id: hex::encode(keys.asset_for(description)?.to_bytes()),
    };
    Ok(serde_wasm_bindgen::to_value(&info)?)
}

#[derive(Serialize)]
struct BuiltTx {
    /// The complete signed v6 transaction, hex-encoded, ready to relay.
    tx_hex: String,
    /// Transaction id, display byte order.
    txid: String,
    /// The minted asset's id.
    asset_id: String,
}

/// Build, prove and sign a complete issuance transaction in the browser.
///
/// Heavy: constructs the Halo2 proving key and proves the mandatory
/// Orchard action (~30-60s single-threaded). Run inside a Web Worker.
///
/// `first_issuance` and `target_height` come from the public chain API —
/// they are public facts, not secrets.
#[wasm_bindgen]
pub fn build_issuance_tx(
    seed_phrase: &str,
    description: &str,
    amount: u64,
    finalize: bool,
    first_issuance: bool,
    target_height: u32,
) -> Result<JsValue, JsError> {
    let keys = Keys::from_phrase(seed_phrase)?;
    let asset_desc_hash = desc_hash(description)?;
    let asset = keys.asset_for(description)?;

    let build_error = |stage: &str, error: String| {
        JsError::new(&format!("issuance transaction {stage} failed: {error}"))
    };

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
            asset_desc_hash,
            Some(IssueInfo {
                recipient: keys.default_address(),
                value: NoteValue::from_raw(amount),
            }),
            first_issuance,
        )
        .map_err(|e| build_error("issuance bundle", format!("{e:?}")))?;

    if finalize {
        builder
            .finalize_asset::<FeeError>(&asset_desc_hash)
            .map_err(|e| build_error("finalization", format!("{e:?}")))?;
    }

    // The v6 builder requires at least one Orchard action to derive rho; a
    // zero-value ZEC output is the reference workaround.
    builder
        .add_orchard_output::<FeeError>(
            Some(keys.orchard_ovk()),
            keys.default_address(),
            Zatoshis::ZERO,
            AssetBase::zatoshi(),
            MemoBytes::empty(),
        )
        .map_err(|e| build_error("padding output", format!("{e:?}")))?;

    // Zero fee: the public testnet accepts it, and a fresh browser issuer
    // holds no ZEC to pay one.
    let fee_rule = FeeRule::non_standard(Zatoshis::ZERO, 20, 150, 34, 0)
        .expect("static fee-rule parameters are valid");

    let tx = builder
        .build(
            &TransparentSigningSet::new(),
            &[],
            &[],
            rand::rngs::OsRng,
            &NoSapling,
            &NoSapling,
            &fee_rule,
            |asset_base| first_issuance && asset_base == &asset,
        )
        .map_err(|e| build_error("build", format!("{e:?}")))?
        .into_transaction();

    let mut tx_bytes = Vec::new();
    tx.write(&mut tx_bytes)
        .map_err(|e| build_error("serialization", e.to_string()))?;

    let mut txid = *tx.txid().as_ref();
    txid.reverse(); // display order, matching the API convention

    Ok(serde_wasm_bindgen::to_value(&BuiltTx {
        tx_hex: hex::encode(tx_bytes),
        txid: hex::encode(txid),
        asset_id: hex::encode(asset.to_bytes()),
    })?)
}

// ---------------------------------------------------------------------------
// Browser wallet: scan the public chain locally, spend what you hold.
//
// The page fetches raw blocks from the registry (public data, identical
// for every caller) and feeds them here; trial decryption, nullifier
// tracking and Merkle witnesses all happen inside the wasm module, so the
// server never learns which notes belong to this browser (PRIVACY.md).
// State lives in the worker's module instance and dies with the page.

use cachet_notes::HotWallet;
use zcash_protocol::consensus::BranchId;

struct BrowserWallet {
    /// Account-0 address bytes: identifies which seed this state belongs to.
    owner: [u8; 43],
    wallet: HotWallet,
    scanned_height: u64,
}

static WALLET: std::sync::Mutex<Option<BrowserWallet>> = std::sync::Mutex::new(None);

fn wallet_guard() -> std::sync::MutexGuard<'static, Option<BrowserWallet>> {
    WALLET
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Encode an Orchard address as a unified address (the format the console
/// and API use everywhere).
fn encode_unified(address: Address) -> Result<String, JsError> {
    use zcash_address::unified::{Encoding, Receiver};
    let unified = zcash_address::unified::Address::try_from_items(vec![Receiver::Orchard(
        address.to_raw_address_bytes(),
    )])
    .map_err(|error| JsError::new(&format!("could not encode address: {error}")))?;
    Ok(unified.encode(&zcash_protocol::consensus::NetworkType::Regtest))
}

/// Decode a unified address down to its Orchard receiver.
fn decode_unified(input: &str) -> Result<Address, JsError> {
    use zcash_address::unified::{Container, Encoding, Receiver};
    let (_network, unified) = zcash_address::unified::Address::decode(input.trim())
        .map_err(|error| JsError::new(&format!("not a unified address: {error}")))?;
    let orchard_receiver = unified
        .items()
        .into_iter()
        .find_map(|receiver| match receiver {
            Receiver::Orchard(bytes) => Some(bytes),
            _ => None,
        })
        .ok_or_else(|| JsError::new("unified address has no Orchard receiver"))?;
    Option::<Address>::from(Address::from_raw_address_bytes(&orchard_receiver))
        .ok_or_else(|| JsError::new("invalid Orchard receiver bytes"))
}

#[derive(Serialize)]
struct HoldingOut {
    asset_id: String,
    /// Decimal string: u64 would surface as BigInt in JS.
    amount: String,
}

#[derive(Serialize)]
struct WalletState {
    /// This seed's account-0 receiving address (unified encoding), so the
    /// user can be paid.
    address: String,
    scanned_height: u32,
    holdings: Vec<HoldingOut>,
}

fn wallet_state(entry: &BrowserWallet, address: Address) -> Result<JsValue, JsError> {
    let holdings = entry
        .wallet
        .balances_by_account()
        .into_iter()
        .find(|(account, _)| *account == 0)
        .map(|(_, holdings)| holdings)
        .unwrap_or_default()
        .into_iter()
        .map(|(asset, amount)| HoldingOut {
            asset_id: hex::encode(asset),
            amount: amount.to_string(),
        })
        .collect();
    Ok(serde_wasm_bindgen::to_value(&WalletState {
        address: encode_unified(address)?,
        scanned_height: u32::try_from(entry.scanned_height).unwrap_or(u32::MAX),
        holdings,
    })?)
}

/// Reset the in-module wallet to a fresh state for this seed. Returns the
/// wallet state (empty, scanned_height 0).
#[wasm_bindgen]
pub fn wallet_reset(seed_phrase: &str) -> Result<JsValue, JsError> {
    let keys = Keys::from_phrase(seed_phrase)?;
    let address = keys.default_address();
    let entry = BrowserWallet {
        owner: address.to_raw_address_bytes(),
        wallet: HotWallet::from_spending_keys([(0, keys.spending_key())]),
        scanned_height: 0,
    };
    let state = wallet_state(&entry, address)?;
    *wallet_guard() = Some(entry);
    Ok(state)
}

#[derive(serde::Deserialize)]
struct BlockIn {
    height: u64,
    txs: Vec<String>,
}

/// Feed a page of raw blocks (from `GET /api/v1/chain/transactions`) into
/// the wallet, in consensus order. Blocks must be contiguous and start at
/// `scanned_height + 1` — the note commitment tree is order-sensitive.
/// Returns the updated wallet state.
#[wasm_bindgen]
pub fn wallet_scan(seed_phrase: &str, blocks: JsValue) -> Result<JsValue, JsError> {
    let keys = Keys::from_phrase(seed_phrase)?;
    let address = keys.default_address();
    let blocks: Vec<BlockIn> = serde_wasm_bindgen::from_value(blocks)?;

    let mut guard = wallet_guard();
    match guard.as_ref() {
        Some(entry) if entry.owner == address.to_raw_address_bytes() => {}
        _ => {
            *guard = Some(BrowserWallet {
                owner: address.to_raw_address_bytes(),
                wallet: HotWallet::from_spending_keys([(0, keys.spending_key())]),
                scanned_height: 0,
            });
        }
    }

    // Applying a block is all-or-nothing. The note commitment tree is
    // append-only and order-sensitive, so a failure PART-WAY through a
    // block would leave commitments in the tree while the height stayed
    // put — and the next scan, re-feeding that same block, would append
    // them a second time and silently corrupt the tree (wrong witnesses,
    // doomed spends). Two defenses:
    //   1. Decode every tx of a block BEFORE mutating anything, so a lying
    //      server's malformed hex (the realistic failure) is rejected with
    //      the tree untouched.
    //   2. If a decoded tx still fails to process mid-block, discard the
    //      whole wallet so the corrupt partial tree can never be reused;
    //      the next scan rebuilds cleanly from height 0.
    let entry = guard
        .as_mut()
        .expect("wallet present after the block above");
    let scan_result: Result<(), String> = (|| {
        for block in blocks {
            if block.height != entry.scanned_height + 1 {
                return Err(format!(
                    "blocks must be contiguous: expected height {}, got {}",
                    entry.scanned_height + 1,
                    block.height
                ));
            }
            // Phase 1: decode all — no mutation yet.
            let mut txs = Vec::with_capacity(block.txs.len());
            for tx_hex in &block.txs {
                let bytes =
                    hex::decode(tx_hex).map_err(|error| format!("invalid tx hex: {error}"))?;
                let tx = zcash_primitives::transaction::Transaction::read(
                    bytes.as_slice(),
                    BranchId::Nu7,
                )
                .map_err(|error| format!("could not parse tx: {error}"))?;
                txs.push(tx);
            }
            // Phase 2: apply all. A failure here may leave the tree
            // partially mutated — the wallet is discarded below.
            for tx in &txs {
                entry
                    .wallet
                    .process_transaction(tx)
                    .map_err(|error| format!("scan failed: {error}"))?;
            }
            entry.scanned_height = block.height;
        }
        Ok(())
    })();

    match scan_result {
        Ok(()) => wallet_state(entry, address),
        Err(message) => {
            // Drop the possibly-corrupt wallet; the next scan rebuilds
            // cleanly from height 0.
            *guard = None;
            Err(JsError::new(&message))
        }
    }
}

/// Build, prove and sign a transfer (recipient given) or a burn
/// (recipient null) of `amount` units of `asset_id`, spending notes the
/// scanned wallet owns. Change returns to the wallet's own address.
///
/// Heavy: Halo2 proving. Run inside the Web Worker, ideally after
/// `prepare_proving` has warmed the proving key.
#[wasm_bindgen]
pub fn build_spend_tx(
    seed_phrase: &str,
    asset_id: &str,
    amount: u64,
    recipient: Option<String>,
    target_height: u32,
) -> Result<JsValue, JsError> {
    if amount == 0 {
        return Err(JsError::new("amount must be positive"));
    }
    let keys = Keys::from_phrase(seed_phrase)?;
    let own_address = keys.default_address();

    let asset_bytes: [u8; 32] = hex::decode(asset_id)
        .ok()
        .and_then(|bytes| bytes.try_into().ok())
        .ok_or_else(|| JsError::new("asset id must be 32 bytes of hex"))?;
    let asset = Option::<AssetBase>::from(AssetBase::from_bytes(&asset_bytes))
        .ok_or_else(|| JsError::new("invalid asset id"))?;

    let recipient_address = recipient.as_deref().map(decode_unified).transpose()?;

    let build_error = |stage: &str, error: String| {
        JsError::new(&format!("spend transaction {stage} failed: {error}"))
    };

    // Select inputs and the anchor under the lock, then release it before
    // the long proving phase.
    let (inputs, total_inputs, anchor) = {
        let guard = wallet_guard();
        let entry = guard
            .as_ref()
            .filter(|entry| entry.owner == own_address.to_raw_address_bytes())
            .ok_or_else(|| JsError::new("wallet not scanned: scan the chain first"))?;
        let selected = entry
            .wallet
            .select_inputs(0, asset, amount)
            .map_err(|error| JsError::new(&format!("{error}")))?;
        let anchor = entry
            .wallet
            .anchor()
            .map_err(|error| JsError::new(&format!("{error}")))?;
        (selected.inputs, selected.total, anchor)
    };

    let mut builder = Builder::new(
        REGTEST_NETWORK,
        target_height.into(),
        BuildConfig::Standard {
            sapling_anchor: None,
            orchard_anchor: Some(anchor),
        },
    );

    let mut spend_auth_keys: Vec<orchard::keys::SpendAuthorizingKey> = Vec::new();
    for (spending_key, note, merkle_path) in inputs {
        builder
            .add_orchard_spend::<FeeError>((&spending_key).into(), note, merkle_path)
            .map_err(|error| build_error("spend", format!("{error:?}")))?;
        spend_auth_keys.push(orchard::keys::SpendAuthorizingKey::from(&spending_key));
    }

    match recipient_address {
        Some(recipient) => {
            builder
                .add_orchard_output::<FeeError>(
                    Some(keys.orchard_ovk()),
                    recipient,
                    Zatoshis::from_u64(amount).expect("nonzero validated amount"),
                    asset,
                    MemoBytes::empty(),
                )
                .map_err(|error| build_error("output", format!("{error:?}")))?;
        }
        None => {
            builder
                .add_burn::<FeeError>(amount, asset)
                .map_err(|error| build_error("burn", format!("{error:?}")))?;
        }
    }

    let change = total_inputs - amount;
    if change > 0 {
        builder
            .add_orchard_output::<FeeError>(
                Some(keys.orchard_ovk()),
                own_address,
                Zatoshis::from_u64(change).expect("validated change"),
                asset,
                MemoBytes::empty(),
            )
            .map_err(|error| build_error("change output", format!("{error:?}")))?;
    }

    let fee_rule = FeeRule::non_standard(Zatoshis::ZERO, 20, 150, 34, 0)
        .expect("static fee-rule parameters are valid");

    let tx = builder
        .build(
            &TransparentSigningSet::new(),
            &[],
            &spend_auth_keys,
            rand::rngs::OsRng,
            &NoSapling,
            &NoSapling,
            &fee_rule,
            |_| false,
        )
        .map_err(|error| build_error("build", format!("{error:?}")))?
        .into_transaction();

    let mut tx_bytes = Vec::new();
    tx.write(&mut tx_bytes)
        .map_err(|error| build_error("serialization", error.to_string()))?;

    let mut txid = *tx.txid().as_ref();
    txid.reverse();

    Ok(serde_wasm_bindgen::to_value(&BuiltTx {
        tx_hex: hex::encode(tx_bytes),
        txid: hex::encode(txid),
        asset_id: asset_id.to_owned(),
    })?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seed_round_trip_and_identity_derivation() {
        let phrase = generate_seed_phrase();
        assert_eq!(phrase.split_whitespace().count(), 24);
        let keys = Keys::from_phrase(&phrase).unwrap();
        let asset_a = keys.asset_for("Ticket A").unwrap();
        let asset_b = keys.asset_for("Ticket B").unwrap();
        assert_ne!(asset_a.to_bytes(), asset_b.to_bytes());
        // Same phrase, same description → same asset id (derived identity).
        let again = Keys::from_phrase(&phrase).unwrap();
        assert_eq!(
            again.asset_for("Ticket A").unwrap().to_bytes(),
            asset_a.to_bytes()
        );
    }
}
