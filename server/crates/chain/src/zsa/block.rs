//! Regtest block assembly: turn a `getblocktemplate` response plus our
//! transactions into a serialized block Zebra accepts.
//!
//! Ported from `zcash_tx_tool` (`components/transactions.rs` and
//! `components/block_commitment.rs`, MIT) with the wallet coupling removed.
//! The commitment math follows [ZIP-244]; proof-of-work is disabled on the
//! QEDIT regtest, so nonce and solution are placeholders.
//!
//! [ZIP-244]: https://zips.z.cash/zip-0244

use sha2::{Digest, Sha256};
use zcash_encoding::Vector;
use zcash_primitives::block::{BlockHash, BlockHeader, BlockHeaderData};
use zcash_primitives::transaction::Transaction;
use zcash_protocol::consensus::BranchId;

use crate::ChainError;
use crate::zsa::rpc::BlockTemplate;

/// Placeholder auth digest for pre-v5 transactions (ZIP-244).
const AUTH_COMMITMENT_PLACEHOLDER: [u8; 32] = [0xFFu8; 32];

/// Assemble and serialize a block containing the template's coinbase plus
/// `transactions`, ready for `submitblock`.
pub fn assemble_block_hex(
    template: BlockTemplate,
    transactions: Vec<Transaction>,
) -> Result<String, ChainError> {
    let coinbase_bytes = hex::decode(&template.coinbase_txn.data).map_err(invalid_template)?;
    let coinbase =
        Transaction::read(coinbase_bytes.as_slice(), BranchId::Nu7).map_err(invalid_template)?;

    let mut txs = vec![coinbase];
    txs.extend(transactions);

    let merkle_root = if txs.len() == 1 {
        // Only the coinbase: the template's precomputed root is exact.
        decode_hash_display_order(&template.default_roots.merkle_root)?
    } else {
        merkle_root(txs.iter().map(|tx| *tx.txid().as_ref()))
    };

    let auth_data_root = auth_data_root(txs.iter().map(|tx| {
        if tx.version().has_orchard() || tx.version().has_orchard_zsa() {
            <[u8; 32]>::try_from(tx.auth_commitment().as_bytes())
                .expect("auth commitment is 32 bytes")
        } else {
            AUTH_COMMITMENT_PLACEHOLDER
        }
    }));

    let chain_history_root = decode_hash_display_order(&template.default_roots.chain_history_root)?;
    let block_commitments = block_commitment_from_parts(chain_history_root, auth_data_root);

    let header = BlockHeader::from_data(BlockHeaderData {
        version: template.version as i32,
        prev_block: BlockHash(decode_hash_display_order(&template.previous_block_hash)?),
        merkle_root,
        final_sapling_root: block_commitments,
        time: template.cur_time,
        bits: u32::from_str_radix(&template.bits, 16).map_err(invalid_template)?,
        nonce: [2; 32],                 // PoW is disabled on the QEDIT regtest
        solution: Vec::from([0; 1344]), // idem
    })
    .map_err(invalid_template)?;

    let mut bytes = Vec::new();
    header.write(&mut bytes).map_err(invalid_template)?;
    Vector::write(&mut bytes, txs.as_slice(), |writer, tx| tx.write(writer))
        .map_err(invalid_template)?;
    Ok(hex::encode(bytes))
}

fn invalid_template(error: impl std::fmt::Display) -> ChainError {
    ChainError::Unavailable {
        reason: format!("could not assemble block from node template: {error}"),
    }
}

/// Hashes arrive from the RPC in big-endian display order; headers want
/// internal byte order.
fn decode_hash_display_order(hex_hash: &str) -> Result<[u8; 32], ChainError> {
    let mut bytes: [u8; 32] = hex::decode(hex_hash)
        .map_err(invalid_template)?
        .try_into()
        .map_err(|_| invalid_template("hash is not 32 bytes"))?;
    bytes.reverse();
    Ok(bytes)
}

/// Double-SHA256 Merkle root over txids (Bitcoin-style, pre-ZIP-244 layout
/// kept by Zcash for the transaction Merkle tree).
fn merkle_root(txids: impl Iterator<Item = [u8; 32]>) -> [u8; 32] {
    let mut layer: Vec<[u8; 32]> = txids.collect();
    while layer.len() > 1 {
        layer = layer
            .chunks(2)
            .map(|pair| match pair {
                [left, right] => double_sha256_pair(left, right),
                [only] => double_sha256_pair(only, only),
                _ => unreachable!("chunks(2)"),
            })
            .collect();
    }
    layer[0]
}

fn double_sha256_pair(left: &[u8; 32], right: &[u8; 32]) -> [u8; 32] {
    let first = Sha256::new_with_prefix(left).chain_update(right).finalize();
    let second = Sha256::digest(first);
    second.into()
}

/// ZIP-244 `hashAuthDataRoot`: BLAKE2b-256 tree personalized with
/// "ZcashAuthDatHash", padded to a power of two with null leaves.
fn auth_data_root(commitments: impl Iterator<Item = [u8; 32]>) -> [u8; 32] {
    let mut layer: Vec<[u8; 32]> = commitments.collect();
    let padding = layer.len().next_power_of_two() - layer.len();
    layer.extend(std::iter::repeat_n([0u8; 32], padding));

    while layer.len() > 1 {
        layer = layer
            .chunks(2)
            .map(|pair| match pair {
                [left, right] => blake2b_auth_pair(left, right),
                _ => unreachable!("layer length is a power of two"),
            })
            .collect();
    }
    layer[0]
}

fn blake2b_auth_pair(left: &[u8; 32], right: &[u8; 32]) -> [u8; 32] {
    blake2b_simd::Params::new()
        .hash_length(32)
        .personal(b"ZcashAuthDatHash")
        .to_state()
        .update(left)
        .update(right)
        .finalize()
        .as_bytes()
        .try_into()
        .expect("32-byte hash")
}

/// ZIP-244 `hashBlockCommitments` from the chain history root (previous
/// block) and this block's auth data root.
fn block_commitment_from_parts(chain_history_root: [u8; 32], auth_data_root: [u8; 32]) -> [u8; 32] {
    blake2b_simd::Params::new()
        .hash_length(32)
        .personal(b"ZcashBlockCommit")
        .to_state()
        .update(&chain_history_root)
        .update(&auth_data_root)
        .update(&[0u8; 32])
        .finalize()
        .as_bytes()
        .try_into()
        .expect("32-byte hash")
}
