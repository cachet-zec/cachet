//! The whole protocol, natively and without a chain: two wallets, two
//! assets, both notes in one commitment tree, the three messages, then the
//! transaction checked the way a node checks it: the proof, every spend
//! signature and the binding signature, all against the sighash.

use std::ops::Deref;

use bridgetree::BridgeTree;
use cachet_swap::{Countersignature, Offer, SwapError, countersign, finish, make_offer, take};
use nonempty::NonEmpty;
use orchard::circuit::VerifyingKey;
use orchard::flavor::OrchardZSA;
use orchard::issuance::auth::{IssueValidatingKey, ZSASchnorr};
use orchard::issuance::compute_asset_desc_hash;
use orchard::keys::{FullViewingKey, Scope, SpendingKey};
use orchard::note::{AssetBase, AssetId, ExtractedNoteCommitment, RandomSeed, Rho};
use orchard::tree::{MerkleHashOrchard, MerklePath};
use orchard::value::NoteValue;
use orchard::{Address, Anchor, Note};
use rand::RngCore;
use rand::rngs::OsRng;
use zcash_primitives::transaction::OrchardBundle;
use zcash_protocol::consensus::BlockHeight;

/// A key that really issues on the public ZSA testnet (any valid one does).
const ISSUER: &str = "00de18a231dd5ea64deb652ab2826dfd8cdc3c261b097f92c2ad5e0defefbaae78";

fn asset(name: &str) -> AssetBase {
    let ik = IssueValidatingKey::<ZSASchnorr>::decode(&hex::decode(ISSUER).unwrap()).unwrap();
    let desc_hash = compute_asset_desc_hash(&NonEmpty::from_slice(name.as_bytes()).unwrap());
    AssetBase::custom(&AssetId::new_v0(&ik, &desc_hash))
}

fn key() -> SpendingKey {
    loop {
        let mut bytes = [0u8; 32];
        OsRng.fill_bytes(&mut bytes);
        if let Some(key) = Option::from(SpendingKey::from_bytes(bytes)) {
            return key;
        }
    }
}

fn address(key: &SpendingKey) -> Address {
    FullViewingKey::from(key).address_at(0u32, Scope::External)
}

/// A note as an issuance would create it: any valid rho and seed will do.
fn note(to: Address, value: u64, asset: AssetBase) -> Note {
    loop {
        let mut rho = [0u8; 32];
        let mut rseed = [0u8; 32];
        OsRng.fill_bytes(&mut rho);
        OsRng.fill_bytes(&mut rseed);
        rho[31] &= 0x3f; // a canonical field element
        let Some(rho) = Option::<Rho>::from(Rho::from_bytes(&rho)) else {
            continue;
        };
        let Some(rseed) = Option::<RandomSeed>::from(RandomSeed::from_bytes(rseed, &rho)) else {
            continue;
        };
        if let Some(note) = Option::from(Note::from_parts(
            to,
            NoteValue::from_raw(value),
            asset,
            rho,
            rseed,
        )) {
            return note;
        }
    }
}

/// A commitment tree holding `notes` (and some strangers' notes between
/// them), with each note's path at the current anchor.
fn tree_with(notes: &[Note]) -> (Anchor, Vec<MerklePath>) {
    let mut tree: BridgeTree<MerkleHashOrchard, u32, 32> = BridgeTree::new(10);
    let stranger = address(&key());
    let mut positions = Vec::new();
    for note in notes {
        let filler = self::note(stranger, 1, AssetBase::zatoshi());
        tree.append(MerkleHashOrchard::from_cmx(&ExtractedNoteCommitment::from(
            filler.commitment(),
        )));
        tree.append(MerkleHashOrchard::from_cmx(&ExtractedNoteCommitment::from(
            note.commitment(),
        )));
        positions.push(tree.mark().unwrap());
    }
    let anchor = Anchor::from(tree.root(0).unwrap());
    let paths = positions
        .into_iter()
        .map(|position| {
            MerklePath::from_parts(
                u64::from(position) as u32,
                tree.witness(position, 0).unwrap().try_into().unwrap(),
            )
        })
        .collect();
    (anchor, paths)
}

struct Setup {
    gold: AssetBase,
    silver: AssetBase,
    maker_swap_key: SpendingKey,
    maker_main_key: SpendingKey,
    taker_key: SpendingKey,
    offer: Offer,
    taker_inputs: Vec<(SpendingKey, Note, MerklePath)>,
}

/// The maker offers 5 GOLD for 30 SILVER; the taker holds 40 SILVER.
fn setup() -> Setup {
    let gold = asset("GOLD");
    let silver = asset("SILVER");
    let maker_swap_key = key();
    let maker_main_key = key();
    let taker_key = key();
    let maker_note = note(address(&maker_swap_key), 5, gold);
    let taker_note = note(address(&taker_key), 40, silver);
    let (anchor, paths) = tree_with(&[maker_note, taker_note]);
    let offer = make_offer(
        &maker_note,
        &paths[0],
        anchor,
        &FullViewingKey::from(&maker_swap_key),
        silver,
        30,
        address(&maker_main_key),
    )
    .unwrap();
    Setup {
        gold,
        silver,
        maker_swap_key,
        maker_main_key,
        taker_key,
        offer,
        taker_inputs: vec![(taker_key, taker_note, paths[1].clone())],
    }
}

#[test]
fn a_swap_completes_and_verifies_like_a_node_would_check_it() {
    let s = setup();
    // The offer travels as text.
    let offer: Offer = serde_json::from_str(&serde_json::to_string(&s.offer).unwrap()).unwrap();

    let taker_fvk = FullViewingKey::from(&s.taker_key);
    let (take_message, pending) = take(
        &offer,
        &s.taker_inputs,
        address(&s.taker_key),
        taker_fvk.to_ovk(Scope::External),
        BlockHeight::from_u32(100),
        OsRng,
    )
    .unwrap();

    let maker_ivk = FullViewingKey::from(&s.maker_main_key).to_ivk(Scope::External);
    let signature =
        countersign(&offer, &s.maker_swap_key, &maker_ivk, &take_message, OsRng).unwrap();
    let tx = finish(pending, &signature).unwrap();

    // Checked as a node would: one sighash for everything.
    let data = tx.deref();
    let Some(OrchardBundle::OrchardZSA(bundle)) = data.orchard_bundle() else {
        panic!("a swap is an OrchardZSA bundle");
    };
    // ZIP 244: with no transparent input, the shielded signature digest IS
    // the txid digest. Checking against the txid checks the signatures
    // independently of the code that produced them.
    let sighash: [u8; 32] = *tx.txid().as_ref();
    bundle
        .verify_proof(&VerifyingKey::build::<OrchardZSA>())
        .expect("the proof verifies");
    for action in bundle.actions() {
        action
            .rk()
            .verify(&sighash, action.authorization().sig())
            .expect("every spend is signed for this transaction");
    }
    bundle
        .binding_validating_key()
        .verify(&sighash, bundle.authorization().binding_signature().sig())
        .expect("the binding signature balances every asset");
    assert!(bundle.burn().is_empty());
    assert_eq!(data.issue_bundle().map(|_| ()), None);

    // Each side decrypts what it was promised.
    let maker_gets: Vec<(AssetBase, u64)> = bundle
        .decrypt_outputs_with_keys(&[maker_ivk])
        .into_iter()
        .map(|(_, _, note, _, _)| (note.asset(), note.value().inner()))
        .collect();
    assert_eq!(maker_gets, vec![(s.silver, 30)]);
    let mut taker_gets: Vec<(AssetBase, u64)> = bundle
        .decrypt_outputs_with_keys(&[taker_fvk.to_ivk(Scope::External)])
        .into_iter()
        .map(|(_, _, note, _, _)| (note.asset(), note.value().inner()))
        .collect();
    taker_gets.sort_by_key(|(_, value)| *value);
    assert_eq!(taker_gets, vec![(s.gold, 5), (s.silver, 10)]);

    // And the serialized transaction reads back as itself.
    let mut bytes = Vec::new();
    tx.write(&mut bytes).unwrap();
    let again = zcash_primitives::transaction::Transaction::read(
        bytes.as_slice(),
        zcash_protocol::consensus::BranchId::Nu7,
    )
    .unwrap();
    assert_eq!(again.txid(), tx.txid());
}

#[test]
fn the_maker_refuses_a_take_that_underpays() {
    let s = setup();
    // The taker builds against a doctored copy asking for less.
    let mut cheaper = s.offer.clone();
    cheaper.want_amount = 20;
    let taker_fvk = FullViewingKey::from(&s.taker_key);
    let (take_message, _) = take(
        &cheaper,
        &s.taker_inputs,
        address(&s.taker_key),
        taker_fvk.to_ovk(Scope::External),
        BlockHeight::from_u32(100),
        OsRng,
    )
    .unwrap();
    let maker_ivk = FullViewingKey::from(&s.maker_main_key).to_ivk(Scope::External);
    assert_eq!(
        countersign(
            &s.offer,
            &s.maker_swap_key,
            &maker_ivk,
            &take_message,
            OsRng
        ),
        Err(SwapError::Refused("it does not pay what the offer asks"))
    );
}

#[test]
fn only_the_maker_can_complete_it() {
    let s = setup();
    let taker_fvk = FullViewingKey::from(&s.taker_key);
    let (take_message, pending) = take(
        &s.offer,
        &s.taker_inputs,
        address(&s.taker_key),
        taker_fvk.to_ovk(Scope::External),
        BlockHeight::from_u32(100),
        OsRng,
    )
    .unwrap();
    let maker_ivk = FullViewingKey::from(&s.maker_main_key).to_ivk(Scope::External);

    // Another key cannot countersign the offer...
    assert_eq!(
        countersign(&s.offer, &key(), &maker_ivk, &take_message, OsRng),
        Err(SwapError::Refused("this key did not make the offer"))
    );
    // ...and a signature from a key that is not the maker's is refused.
    let forged = Countersignature {
        version: 1,
        signature: hex::encode([7u8; 64]),
    };
    assert!(finish(pending, &forged).is_err());
}

#[test]
fn an_offer_that_does_not_hold_together_is_refused() {
    let s = setup();
    let mut wrong = s.offer.clone();
    wrong.give_amount = 6;
    let taker_fvk = FullViewingKey::from(&s.taker_key);
    let attempt = take(
        &wrong,
        &s.taker_inputs,
        address(&s.taker_key),
        taker_fvk.to_ovk(Scope::External),
        BlockHeight::from_u32(100),
        OsRng,
    );
    assert!(matches!(attempt, Err(SwapError::BadOffer(_))));
    // Not enough of the wanted asset.
    let poor = vec![(
        s.taker_key,
        note(address(&s.taker_key), 3, s.silver),
        s.taker_inputs[0].2.clone(),
    )];
    assert!(matches!(
        take(
            &s.offer,
            &poor,
            address(&s.taker_key),
            taker_fvk.to_ovk(Scope::External),
            BlockHeight::from_u32(100),
            OsRng,
        ),
        Err(SwapError::InsufficientFunds { .. })
    ));
}
