//! The whole protocol, natively and without a chain: two wallets, two
//! assets, both notes in one commitment tree, the three messages, then the
//! transaction checked the way a node checks it: the proof, every spend
//! signature and the binding signature, all against the sighash.

use std::ops::Deref;

use cachet_swap::testing::{address, key, note, setup};
use cachet_swap::{Countersignature, Offer, SwapError, countersign, finish, take, take_txid};
use orchard::circuit::VerifyingKey;
use orchard::flavor::OrchardZSA;
use orchard::keys::{FullViewingKey, Scope};
use orchard::note::AssetBase;
use rand::rngs::OsRng;
use zcash_primitives::transaction::OrchardBundle;
use zcash_protocol::consensus::BlockHeight;

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

    // The id was known from the take, before the maker signed.
    let mut txid = *tx.txid().as_ref();
    txid.reverse();
    assert_eq!(take_txid(&take_message).unwrap(), hex::encode(txid));

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

/// What a registry runs before holding an offer: a real take passes; a take
/// for another offer, or with the maker's randomizer altered, does not.
#[test]
fn a_registry_can_tell_a_real_take_from_a_fake_one() {
    let s = setup();
    let taker_fvk = FullViewingKey::from(&s.taker_key);
    let (take_message, _) = take(
        &s.offer,
        &s.taker_inputs,
        address(&s.taker_key),
        taker_fvk.to_ovk(Scope::External),
        BlockHeight::from_u32(100),
        OsRng,
    )
    .unwrap();
    assert_eq!(cachet_swap::check_take(&s.offer, &take_message), Ok(()));

    // Aimed at another offer: it spends a note that offer is not about.
    let other = setup();
    assert!(cachet_swap::check_take(&other.offer, &take_message).is_err());

    // The randomizer the maker would sign with no longer fits the action.
    let mut altered = take_message.clone();
    altered.alpha = hex::encode([1u8; 32]);
    assert!(cachet_swap::check_take(&s.offer, &altered).is_err());

    // Not a transaction at all.
    let mut junk = take_message;
    junk.tx = "00".to_owned();
    assert!(cachet_swap::check_take(&s.offer, &junk).is_err());
}
