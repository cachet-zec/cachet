//! An atomic two-party ZSA swap: the maker gives units of one asset, the
//! taker gives units of another, in ONE OrchardZSA bundle. One proof covers
//! every action and one binding signature the whole bundle, so the swap
//! lands whole or not at all: there is no step where one side has paid and
//! the other has not.
//!
//! # Protocol (three messages)
//!
//! 1. **Offer** (maker → taker). The maker moved exactly the units it gives
//!    to a one-off swap account and publishes that account's full viewing
//!    key, the note, its Merkle path and anchor, what it wants, and where it
//!    wants to be paid. A viewing key shows everything its account holds,
//!    which is why the account holds that one note and nothing else.
//! 2. **Take** (taker → maker). The taker builds the bundle against the
//!    offer's anchor: the maker's note and its own notes as spends, the
//!    wanted units to the maker, the given units and its change to itself.
//!    It proves the bundle, signs its own spends, and sends the transaction
//!    with a placeholder where the maker's signature goes, plus the
//!    randomizer `alpha` of the maker's spend.
//! 3. **Countersignature** (maker → taker). The maker recomputes the
//!    sighash from the transaction itself, checks that the action it is
//!    asked to sign spends its offered note with `rk = ak + alpha`, and
//!    that the outputs it can decrypt pay it what it asked for. Only then
//!    does it sign. The taker appends the signature and the transaction is
//!    complete.
//!
//! The sighash commits to every action, output and value balance, and to no
//! signature or proof, so the maker signs exactly the transaction it read,
//! and the taker can change nothing afterwards without voiding it. The
//! taker signs nothing the maker can alter either: its signatures cover the
//! same sighash.
//!
//! Needs the vendored orchard's signing-parts patch (`alpha` is otherwise
//! private to whoever built the bundle).

use std::ops::Deref;

use ff::PrimeField;
use orchard::builder::{Builder, BundleType, InProgress, PartiallyAuthorized};
use orchard::bundle::Authorized as OrchardAuthorized;
use orchard::circuit::Proof;
use orchard::flavor::OrchardZSA;
use orchard::keys::{
    FullViewingKey, IncomingViewingKey, OutgoingViewingKey, SpendAuthorizingKey,
    SpendValidatingKey, SpendingKey,
};
use orchard::note::{AssetBase, ExtractedNoteCommitment, RandomSeed, Rho};
use orchard::primitives::redpallas::{Signature, SpendAuth};
use orchard::sighash_kind::{OrchardSighashKind, OrchardSpendAuthSig};
use orchard::tree::{MerkleHashOrchard, MerklePath};
use orchard::value::NoteValue;
use orchard::{Address, Anchor, Bundle, Note};
use pasta_curves::pallas;
use rand::{CryptoRng, RngCore};
use serde::{Deserialize, Serialize};
use zcash_primitives::transaction::builder::orchard_zsa_proving_key;
use zcash_primitives::transaction::sighash::{SignableInput, signature_hash};
use zcash_primitives::transaction::txid::TxIdDigester;
use zcash_primitives::transaction::{
    Authorized, OrchardBundle, Transaction, TransactionData, TxVersion, Unauthorized,
};
use zcash_protocol::consensus::{BlockHeight, BranchId};
use zcash_protocol::value::{ZatBalance, Zatoshis};

/// Wire format version of every message below.
pub const VERSION: u8 = 1;

/// Blocks a swap transaction stays valid for, like any built transaction.
const EXPIRY_DELTA: u32 = 40;

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum SwapError {
    #[error("malformed message: {0}")]
    Malformed(&'static str),
    #[error("unsupported message version {0}")]
    Version(u8),
    #[error("the offer does not hold together: {0}")]
    BadOffer(&'static str),
    #[error("not enough to pay: need {needed}, have {available}")]
    InsufficientFunds { needed: u64, available: u64 },
    #[error("refused to sign: {0}")]
    Refused(&'static str),
    #[error("building the swap failed: {0}")]
    Build(String),
}

/// A note, field by field, hex where binary.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NoteWire {
    pub recipient: String,
    pub value: u64,
    pub asset: String,
    pub rho: String,
    pub rseed: String,
}

/// A Merkle path: the leaf position and the 32 sibling hashes, leaf first.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PathWire {
    pub position: u32,
    pub auth_path: Vec<String>,
}

/// Message 1: what the maker gives, what it wants, and the note that pays.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Offer {
    pub version: u8,
    pub give_asset: String,
    pub give_amount: u64,
    pub want_asset: String,
    pub want_amount: u64,
    /// Full viewing key of the one-off account holding `note`.
    pub maker_fvk: String,
    pub note: NoteWire,
    pub path: PathWire,
    /// The root `path` leads to; the whole swap is built against it.
    pub anchor: String,
    /// Raw Orchard address (43 bytes) the maker is paid at.
    pub maker_receive: String,
}

/// Message 2: the transaction, complete but for the maker's signature.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Take {
    pub version: u8,
    /// The serialized transaction, a placeholder in the maker's signature.
    pub tx: String,
    /// Index of the action spending the maker's note.
    pub maker_action: u32,
    /// The randomizer of that action's spend authorization key.
    pub alpha: String,
}

/// Message 3: the maker's spend authorization signature.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Countersignature {
    pub version: u8,
    pub signature: String,
}

/// The taker's half-finished swap, kept in memory between messages 2 and 3.
pub struct PendingSwap {
    bundle: Bundle<InProgress<Proof, PartiallyAuthorized>, ZatBalance, OrchardZSA>,
    expiry_height: BlockHeight,
}

// --- encoding -------------------------------------------------------------

fn bytes<const N: usize>(text: &str, what: &'static str) -> Result<[u8; N], SwapError> {
    hex::decode(text)
        .ok()
        .and_then(|raw| raw.try_into().ok())
        .ok_or(SwapError::Malformed(what))
}

fn asset_from(text: &str) -> Result<AssetBase, SwapError> {
    Option::from(AssetBase::from_bytes(&bytes(text, "asset id")?))
        .ok_or(SwapError::Malformed("asset id"))
}

fn address_from(text: &str) -> Result<Address, SwapError> {
    Option::from(Address::from_raw_address_bytes(&bytes(text, "address")?))
        .ok_or(SwapError::Malformed("address"))
}

pub fn note_to_wire(note: &Note) -> NoteWire {
    NoteWire {
        recipient: hex::encode(note.recipient().to_raw_address_bytes()),
        value: note.value().inner(),
        asset: hex::encode(note.asset().to_bytes()),
        rho: hex::encode(note.rho().to_bytes()),
        rseed: hex::encode(note.rseed().as_bytes()),
    }
}

fn note_from(wire: &NoteWire) -> Result<Note, SwapError> {
    let rho: Rho = Option::from(Rho::from_bytes(&bytes(&wire.rho, "rho")?))
        .ok_or(SwapError::Malformed("rho"))?;
    let rseed: RandomSeed =
        Option::from(RandomSeed::from_bytes(bytes(&wire.rseed, "rseed")?, &rho))
            .ok_or(SwapError::Malformed("rseed"))?;
    Option::from(Note::from_parts(
        address_from(&wire.recipient)?,
        NoteValue::from_raw(wire.value),
        asset_from(&wire.asset)?,
        rho,
        rseed,
    ))
    .ok_or(SwapError::Malformed("note"))
}

pub fn path_to_wire(path: &MerklePath) -> PathWire {
    PathWire {
        position: path.position(),
        auth_path: path
            .auth_path()
            .iter()
            .map(|hash| hex::encode(hash.to_bytes()))
            .collect(),
    }
}

fn path_from(wire: &PathWire) -> Result<MerklePath, SwapError> {
    let hashes = wire
        .auth_path
        .iter()
        .map(|text| {
            Option::from(MerkleHashOrchard::from_bytes(&bytes(text, "path hash")?))
                .ok_or(SwapError::Malformed("path hash"))
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok(MerklePath::from_parts(
        wire.position,
        hashes
            .try_into()
            .map_err(|_| SwapError::Malformed("path length"))?,
    ))
}

fn fvk_from(text: &str) -> Result<FullViewingKey, SwapError> {
    FullViewingKey::from_bytes(&bytes(text, "viewing key")?)
        .ok_or(SwapError::Malformed("viewing key"))
}

fn alpha_from(text: &str) -> Result<pallas::Scalar, SwapError> {
    Option::from(pallas::Scalar::from_repr(bytes(text, "alpha")?))
        .ok_or(SwapError::Malformed("alpha"))
}

/// An offer's content, decoded and checked to hold together.
struct OfferParts {
    give: AssetBase,
    want: AssetBase,
    fvk: FullViewingKey,
    note: Note,
    path: MerklePath,
    anchor: Anchor,
    maker_receive: Address,
}

fn decode_offer(offer: &Offer) -> Result<OfferParts, SwapError> {
    if offer.version != VERSION {
        return Err(SwapError::Version(offer.version));
    }
    let parts = OfferParts {
        give: asset_from(&offer.give_asset)?,
        want: asset_from(&offer.want_asset)?,
        fvk: fvk_from(&offer.maker_fvk)?,
        note: note_from(&offer.note)?,
        path: path_from(&offer.path)?,
        anchor: Option::from(Anchor::from_bytes(bytes(&offer.anchor, "anchor")?))
            .ok_or(SwapError::Malformed("anchor"))?,
        maker_receive: address_from(&offer.maker_receive)?,
    };
    if parts.give == parts.want {
        return Err(SwapError::BadOffer("it gives and wants the same asset"));
    }
    if offer.give_amount == 0 || offer.want_amount == 0 {
        return Err(SwapError::BadOffer("an amount is zero"));
    }
    if parts.note.asset() != parts.give || parts.note.value().inner() != offer.give_amount {
        return Err(SwapError::BadOffer("the note is not the units it gives"));
    }
    if parts
        .fvk
        .scope_for_address(&parts.note.recipient())
        .is_none()
    {
        return Err(SwapError::BadOffer("the viewing key does not own the note"));
    }
    let cmx = ExtractedNoteCommitment::from(parts.note.commitment());
    if parts.path.root(cmx) != parts.anchor {
        return Err(SwapError::BadOffer("the path does not lead to the anchor"));
    }
    Ok(parts)
}

// --- message 1 --------------------------------------------------------------

/// The maker's offer: `note` (in the one-off account `swap_fvk` owns, at
/// `path` under `anchor`) for `want_amount` of `want`, paid to
/// `maker_receive`.
pub fn make_offer(
    note: &Note,
    path: &MerklePath,
    anchor: Anchor,
    swap_fvk: &FullViewingKey,
    want: AssetBase,
    want_amount: u64,
    maker_receive: Address,
) -> Result<Offer, SwapError> {
    let offer = Offer {
        version: VERSION,
        give_asset: hex::encode(note.asset().to_bytes()),
        give_amount: note.value().inner(),
        want_asset: hex::encode(want.to_bytes()),
        want_amount,
        maker_fvk: hex::encode(swap_fvk.to_bytes()),
        note: note_to_wire(note),
        path: path_to_wire(path),
        anchor: hex::encode(anchor.to_bytes()),
        maker_receive: hex::encode(maker_receive.to_raw_address_bytes()),
    };
    // Whatever the maker publishes, a taker will check: check it first.
    decode_offer(&offer)?;
    Ok(offer)
}

/// Authorization of a parsed swap transaction, for computing its sighash.
/// librustzcash computes sighashes over unauthorized builder state or over
/// transparent data that can be signed; a received transaction is neither.
/// The shielded sighash reads no transparent authorization, and a swap
/// carries no transparent bundle (`countersign` checks), so the transparent
/// side here is effects-only and everything else is the parsed data's own.
struct Received;

impl zcash_primitives::transaction::Authorization for Received {
    type TransparentAuth = zcash_transparent::bundle::EffectsOnly;
    type SaplingAuth = sapling_crypto::bundle::Authorized;
    type OrchardAuth = OrchardAuthorized;
    type IssueAuth = orchard::issuance::Signed;
}

// --- message 2 --------------------------------------------------------------

/// The transaction the parts describe; `orchard` is the only bundle.
fn transaction_data<A: zcash_primitives::transaction::Authorization>(
    orchard: Bundle<A::OrchardAuth, ZatBalance, OrchardZSA>,
    expiry_height: BlockHeight,
) -> TransactionData<A> {
    TransactionData::from_parts(
        TxVersion::suggested_for_branch(BranchId::Nu7),
        BranchId::Nu7,
        0,
        expiry_height,
        Zatoshis::ZERO,
        None,
        None,
        None,
        Some(OrchardBundle::OrchardZSA(orchard)),
        None,
    )
}

/// The taker's side: spend `inputs` (all of `want`, witnessed against the
/// offer's anchor) and the maker's note, pay the maker, take the given
/// units and the change at `receive`. Proves, signs the taker's spends,
/// and returns message 2 with what message 3 will complete.
pub fn take(
    offer: &Offer,
    inputs: &[(SpendingKey, Note, MerklePath)],
    receive: Address,
    ovk: OutgoingViewingKey,
    target_height: BlockHeight,
    mut rng: impl RngCore + CryptoRng,
) -> Result<(Take, PendingSwap), SwapError> {
    let parts = decode_offer(offer)?;
    let available: u64 = inputs
        .iter()
        .filter(|(_, note, _)| note.asset() == parts.want)
        .map(|(_, note, _)| note.value().inner())
        .sum();
    if inputs.iter().any(|(_, note, _)| note.asset() != parts.want) {
        return Err(SwapError::Build(
            "an input is not the asset the maker wants".into(),
        ));
    }
    if available < offer.want_amount {
        return Err(SwapError::InsufficientFunds {
            needed: offer.want_amount,
            available,
        });
    }

    let build = |error: String| SwapError::Build(error);
    let mut builder = Builder::new(BundleType::DEFAULT_ZSA, parts.anchor);
    builder
        .add_spend(parts.fvk.clone(), parts.note, parts.path.clone())
        .map_err(|error| build(format!("maker's spend: {error:?}")))?;
    for (key, note, path) in inputs {
        builder
            .add_spend(FullViewingKey::from(key), *note, path.clone())
            .map_err(|error| build(format!("taker's spend: {error:?}")))?;
    }
    builder
        .add_output(
            Some(ovk.clone()),
            parts.maker_receive,
            NoteValue::from_raw(offer.want_amount),
            parts.want,
            [0; 512],
        )
        .map_err(|error| build(format!("maker's payment: {error:?}")))?;
    builder
        .add_output(
            Some(ovk.clone()),
            receive,
            NoteValue::from_raw(offer.give_amount),
            parts.give,
            [0; 512],
        )
        .map_err(|error| build(format!("taker's payment: {error:?}")))?;
    let change = available - offer.want_amount;
    if change > 0 {
        builder
            .add_output(
                Some(ovk),
                receive,
                NoteValue::from_raw(change),
                parts.want,
                [0; 512],
            )
            .map_err(|error| build(format!("taker's change: {error:?}")))?;
    }
    let (unproven, _) = builder
        .build::<ZatBalance, OrchardZSA>(&mut rng)
        .map_err(|error| build(format!("{error:?}")))?
        .ok_or_else(|| build("the bundle came out empty".into()))?;

    // The sighash commits to the effects only: computing it before the
    // proof and the signatures exist is how librustzcash's builder does it.
    let expiry_height = target_height + EXPIRY_DELTA;
    let unauthorized: TransactionData<Unauthorized> =
        transaction_data(unproven.clone(), expiry_height);
    let sighash: [u8; 32] = *signature_hash(
        &unauthorized,
        &SignableInput::Shielded,
        &unauthorized.digest(TxIdDigester),
    )
    .as_ref();

    let mut bundle = unproven
        .create_proof(orchard_zsa_proving_key(), &mut rng)
        .map_err(|error| build(format!("proof: {error:?}")))?
        .prepare(&mut rng, sighash);
    for (key, _, _) in inputs {
        bundle = bundle.sign(&mut rng, &SpendAuthorizingKey::from(key));
    }

    // Exactly one action is left unsigned, and it is the maker's.
    let maker_ak = SpendValidatingKey::from(parts.fvk.clone());
    let unsigned: Vec<(usize, pallas::Scalar, bool)> = bundle
        .unsigned_parts()
        .iter()
        .enumerate()
        .filter_map(|(index, parts)| {
            parts
                .as_ref()
                .map(|parts| (index, parts.alpha(), *parts.ak() == maker_ak))
        })
        .collect();
    let [(maker_action, alpha, true)] = unsigned[..] else {
        return Err(build(
            "the maker's spend is not the one action left to sign".into(),
        ));
    };

    let placeholder = OrchardSpendAuthSig::new(
        OrchardSighashKind::AllEffecting,
        Signature::<SpendAuth>::from([0; 64]),
    );
    let readable = transaction_data::<Authorized>(
        bundle.with_placeholder_signatures(&placeholder),
        expiry_height,
    )
    .freeze()
    .map_err(|error| build(format!("serialization: {error}")))?;
    let mut tx = Vec::new();
    readable
        .write(&mut tx)
        .map_err(|error| build(format!("serialization: {error}")))?;

    Ok((
        Take {
            version: VERSION,
            tx: hex::encode(tx),
            maker_action: maker_action as u32,
            alpha: hex::encode(alpha.to_repr()),
        },
        PendingSwap {
            bundle,
            expiry_height,
        },
    ))
}

// --- message 3 --------------------------------------------------------------

/// The maker's side: read the transaction it is asked to complete, check
/// it spends exactly the offered note and pays `receive_ivk`'s address what
/// the offer asks, and only then sign. `swap_key` is the one-off account's
/// spending key.
pub fn countersign(
    offer: &Offer,
    swap_key: &SpendingKey,
    receive_ivk: &IncomingViewingKey,
    take: &Take,
    mut rng: impl RngCore + CryptoRng,
) -> Result<Countersignature, SwapError> {
    let parts = decode_offer(offer)?;
    if take.version != VERSION {
        return Err(SwapError::Version(take.version));
    }
    let swap_fvk = FullViewingKey::from(swap_key);
    if swap_fvk.to_bytes() != parts.fvk.to_bytes() {
        return Err(SwapError::Refused("this key did not make the offer"));
    }

    let raw = hex::decode(&take.tx).map_err(|_| SwapError::Malformed("transaction hex"))?;
    let tx = Transaction::read(raw.as_slice(), BranchId::Nu7)
        .map_err(|_| SwapError::Malformed("transaction"))?;
    let data: &TransactionData<Authorized> = tx.deref();
    if data.transparent_bundle().is_some()
        || data.sapling_bundle().is_some()
        || data.issue_bundle().is_some()
    {
        return Err(SwapError::Refused(
            "a swap carries nothing but its Orchard bundle",
        ));
    }
    let Some(OrchardBundle::OrchardZSA(bundle)) = data.orchard_bundle() else {
        return Err(SwapError::Refused("no OrchardZSA bundle"));
    };
    if !bundle.burn().is_empty() {
        return Err(SwapError::Refused("a swap burns nothing"));
    }
    if *bundle.anchor() != parts.anchor {
        return Err(SwapError::Refused("not built against the offer's anchor"));
    }

    // The action to sign spends the offered note, under this key.
    let action = bundle
        .actions()
        .get(take.maker_action as usize)
        .ok_or(SwapError::Refused("no such action"))?;
    if *action.nullifier() != parts.note.nullifier(&swap_fvk) {
        return Err(SwapError::Refused(
            "that action does not spend the offered note",
        ));
    }
    let alpha = alpha_from(&take.alpha)?;
    let expected_rk = SpendValidatingKey::from(swap_fvk).randomize(&alpha);
    if <[u8; 32]>::from(&expected_rk) != <[u8; 32]>::from(action.rk()) {
        return Err(SwapError::Refused("alpha does not match that action's key"));
    }

    // The payment, from what this wallet can decrypt.
    let want = parts.want;
    let paid: u64 = bundle
        .decrypt_outputs_with_keys(std::slice::from_ref(receive_ivk))
        .into_iter()
        .filter(|(_, _, note, recipient, _)| {
            note.asset() == want && *recipient == parts.maker_receive
        })
        .map(|(_, _, note, _, _)| note.value().inner())
        .sum();
    if paid < offer.want_amount {
        return Err(SwapError::Refused("it does not pay what the offer asks"));
    }

    // Recompute the sighash over a rebuild of the parsed transaction. The
    // rebuild has the fixed header every swap uses, so a transaction with
    // any other header is refused rather than signed under the wrong hash.
    let expected = transaction_data::<Received>(bundle.clone(), data.expiry_height());
    if data.version() != expected.version()
        || data.consensus_branch_id() != expected.consensus_branch_id()
        || data.lock_time() != expected.lock_time()
        || data.zip233_amount() != expected.zip233_amount()
    {
        return Err(SwapError::Refused("not a swap transaction header"));
    }
    let sighash = signature_hash(
        &expected,
        &SignableInput::Shielded,
        &expected.digest(TxIdDigester),
    );
    if expected.digest(TxIdDigester).header_digest != data.digest(TxIdDigester).header_digest {
        return Err(SwapError::Refused("not a swap transaction header"));
    }
    let signature = SpendAuthorizingKey::from(swap_key)
        .randomize(&alpha)
        .sign(&mut rng, sighash.as_ref());
    Ok(Countersignature {
        version: VERSION,
        signature: hex::encode(<[u8; 64]>::from(&signature)),
    })
}

/// The taker's last step: add the maker's signature (refused unless it
/// verifies for the maker's action) and produce the transaction.
pub fn finish(
    pending: PendingSwap,
    countersignature: &Countersignature,
) -> Result<Transaction, SwapError> {
    if countersignature.version != VERSION {
        return Err(SwapError::Version(countersignature.version));
    }
    let signature = OrchardSpendAuthSig::new(
        OrchardSighashKind::AllEffecting,
        Signature::<SpendAuth>::from(bytes::<64>(&countersignature.signature, "signature")?),
    );
    let bundle: Bundle<OrchardAuthorized, ZatBalance, OrchardZSA> = pending
        .bundle
        .append_signatures(&[signature])
        .map_err(|_| SwapError::Refused("the signature is not the maker's for this transaction"))?
        .finalize()
        .map_err(|error| SwapError::Build(format!("{error:?}")))?;
    transaction_data::<Authorized>(bundle, pending.expiry_height)
        .freeze()
        .map_err(|error| SwapError::Build(format!("serialization: {error}")))
}
