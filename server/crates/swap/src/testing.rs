//! Fixtures for tests of this crate and of its users (feature `testing`):
//! real keys, real ZSA asset bases, notes in a real commitment tree, and a
//! valid offer, with no chain.

use bridgetree::BridgeTree;
use nonempty::NonEmpty;
use orchard::issuance::auth::{IssueValidatingKey, ZSASchnorr};
use orchard::issuance::compute_asset_desc_hash;
use orchard::keys::{FullViewingKey, Scope, SpendingKey};
use orchard::note::{AssetBase, AssetId, ExtractedNoteCommitment, RandomSeed, Rho};
use orchard::tree::{MerkleHashOrchard, MerklePath};
use orchard::value::NoteValue;
use orchard::{Address, Anchor, Note};
use rand::RngCore;
use rand::rngs::OsRng;

use crate::{Offer, make_offer};

/// A key that really issues on the public ZSA testnet (any valid one does).
pub const ISSUER: &str = "00de18a231dd5ea64deb652ab2826dfd8cdc3c261b097f92c2ad5e0defefbaae78";

pub fn asset(name: &str) -> AssetBase {
    let ik = IssueValidatingKey::<ZSASchnorr>::decode(&hex::decode(ISSUER).unwrap()).unwrap();
    let desc_hash = compute_asset_desc_hash(&NonEmpty::from_slice(name.as_bytes()).unwrap());
    AssetBase::custom(&AssetId::new_v0(&ik, &desc_hash))
}

pub fn key() -> SpendingKey {
    loop {
        let mut bytes = [0u8; 32];
        OsRng.fill_bytes(&mut bytes);
        if let Some(key) = Option::from(SpendingKey::from_bytes(bytes)) {
            return key;
        }
    }
}

pub fn address(key: &SpendingKey) -> Address {
    FullViewingKey::from(key).address_at(0u32, Scope::External)
}

/// A note as an issuance would create it: any valid rho and seed will do.
pub fn note(to: Address, value: u64, asset: AssetBase) -> Note {
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
pub fn tree_with(notes: &[Note]) -> (Anchor, Vec<MerklePath>) {
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

pub struct Setup {
    pub gold: AssetBase,
    pub silver: AssetBase,
    pub maker_swap_key: SpendingKey,
    pub maker_main_key: SpendingKey,
    pub taker_key: SpendingKey,
    pub offer: Offer,
    pub taker_inputs: Vec<(SpendingKey, Note, MerklePath)>,
}

/// The maker offers 5 GOLD for 30 SILVER; the taker holds 40 SILVER.
pub fn setup() -> Setup {
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
