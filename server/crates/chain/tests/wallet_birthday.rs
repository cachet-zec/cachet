//! A wallet born after a block starts from the tree a node reports after
//! it, instead of reading the chain from its first block.

use incrementalmerkletree::frontier::CommitmentTree;
use orchard::tree::MerkleHashOrchard;

fn key() -> orchard::keys::SpendingKey {
    orchard::keys::SpendingKey::from_zip32_seed(&[7u8; 64], 1, zip32::AccountId::ZERO).unwrap()
}

fn tree_with(leaves: u8) -> (Vec<u8>, [u8; 32]) {
    let mut tree = CommitmentTree::<MerkleHashOrchard, 32>::empty();
    for leaf in 0..leaves {
        let mut bytes = [0u8; 32];
        bytes[0] = leaf + 1;
        let cmx = orchard::note::ExtractedNoteCommitment::from_bytes(&bytes).unwrap();
        tree.append(MerkleHashOrchard::from_cmx(&cmx)).unwrap();
    }
    let mut encoded = Vec::new();
    zcash_primitives::merkle_tree::write_commitment_tree(&tree, &mut encoded).unwrap();
    (encoded, orchard::Anchor::from(tree.root()).to_bytes())
}

#[test]
fn a_wallet_born_after_a_block_stands_on_that_blocks_root() {
    for leaves in [0, 1, 5] {
        let (state, root) = tree_with(leaves);
        let wallet = cachet_notes::HotWallet::from_spending_keys([(0, key())])
            .starting_after(42, &state, Some(root))
            .unwrap();
        assert_eq!(wallet.anchor().unwrap().to_bytes(), root, "{leaves} leaves");
        assert!(wallet.knows_anchor(&orchard::Anchor::from_bytes(root).unwrap()));
    }
}

#[test]
fn a_tree_state_that_does_not_match_its_root_is_refused() {
    let (state, _) = tree_with(3);
    assert!(
        cachet_notes::HotWallet::from_spending_keys([(0, key())])
            .starting_after(42, &state, Some([9; 32]))
            .is_err()
    );
    assert!(
        cachet_notes::HotWallet::from_spending_keys([(0, key())])
            .starting_after(42, b"not a tree", None)
            .is_err()
    );
}
