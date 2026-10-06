//! Recompute a ZSA asset id from public data, in the reader's browser.
//!
//! # Why this exists
//!
//! An asset page can already re-hash a metadata bundle and compare it with
//! the `sha256` carried in the on-chain description. That proves the bundle
//! matches the description - it does NOT prove the description is the one
//! the chain committed to. A registry serving a fabricated description with
//! a matching fabricated bundle would pass that check.
//!
//! ZIP 227 closes the gap, because an asset's identity is derived rather
//! than assigned:
//!
//! ```text
//! asset_id = AssetBase::custom(issuance_validating_key, BLAKE2b-256(description))
//! ```
//!
//! Both inputs are public. So a client holding an asset id - the one in the
//! URL it asked for - can recompute it from the issuer key and description
//! it was served and check they produce that same id. If they do, the
//! description is authentic by construction: no chain access, and no trust
//! in whoever served it.
//!
//! The same inputs also give the asset's other ZIP 227 names: the
//! description hash and the Asset Digest, the 64-byte form the ZIP suggests
//! wallets exchange (a QR code, for one). They are returned alongside
//! the id so a page never shows one it did not derive itself.
//!
//! This crate is the derivation, and nothing else.

use nonempty::NonEmpty;
use orchard::issuance::auth::{IssueValidatingKey, ZSASchnorr};
use orchard::issuance::compute_asset_desc_hash;
use orchard::note::{AssetBase, AssetId};
use wasm_bindgen::prelude::*;

/// ZIP 227 canonical encoding of an issuance validating key: one algorithm
/// byte followed by the 32-byte key.
const ISSUANCE_KEY_BYTES: usize = 33;

/// BLAKE2b personalization of the Asset Digest (ZIP 227, "Asset Digests").
const ASSET_DIGEST_PERSONALIZATION: &[u8; 16] = b"ZSA-Asset-Digest";

/// Version byte of a ZIP 227 Asset Identifier encoding.
const ASSET_ID_VERSION: u8 = 0;

/// What ZIP 227 derives from one issuer key and one description, as
/// lowercase hex.
#[wasm_bindgen(getter_with_clone)]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Identity {
    /// The Asset Base: the id the chain, the registry and the URLs use.
    pub asset_id: String,
    /// BLAKE2b-256 of the description, personalized "ZSA-AssetDescCRH".
    pub asset_desc_hash: String,
    /// BLAKE2b-512 of the encoded Asset Identifier, personalized
    /// "ZSA-Asset-Digest". The Asset Base is this digest hashed to the curve.
    pub asset_digest: String,
}

/// Derive the asset id that `issuance_key_hex` mints `description` under.
///
/// The pure core, kept separate from the `wasm_bindgen` wrapper so it can
/// be tested on the host: constructing a `JsError` off wasm32 panics.
pub fn derive(issuance_key_hex: &str, description: &str) -> Result<String, String> {
    identity(issuance_key_hex, description).map(|identity| identity.asset_id)
}

/// Derive every ZIP 227 name of the asset `issuance_key_hex` mints
/// `description` under.
pub fn identity(issuance_key_hex: &str, description: &str) -> Result<Identity, String> {
    let key_bytes =
        hex::decode(issuance_key_hex.trim()).map_err(|_| "issuance key is not valid hex")?;
    if key_bytes.len() != ISSUANCE_KEY_BYTES {
        return Err(format!(
            "issuance key must be {ISSUANCE_KEY_BYTES} bytes, got {}",
            key_bytes.len()
        ));
    }
    let key = IssueValidatingKey::<ZSASchnorr>::decode(&key_bytes)
        .map_err(|_| "issuance key is not a valid ZIP 227 encoding")?;

    // The chain hashes the description bytes; an empty description cannot
    // exist on chain, so it is refused rather than silently hashed.
    let bytes = NonEmpty::from_slice(description.as_bytes()).ok_or("description is empty")?;
    let desc_hash = compute_asset_desc_hash(&bytes);
    let asset = AssetBase::custom(&AssetId::new_v0(&key, &desc_hash));

    // orchard keeps its digest private, so it is recomputed here from the
    // same encoding: version byte, issuer (the key's ZIP 227 encoding), and
    // the description hash. The tests hash it to the curve and compare.
    let digest = blake2b_simd::Params::new()
        .hash_length(64)
        .personal(ASSET_DIGEST_PERSONALIZATION)
        .to_state()
        .update(&[ASSET_ID_VERSION])
        .update(&key.encode())
        .update(&desc_hash)
        .finalize();

    Ok(Identity {
        asset_id: hex::encode(asset.to_bytes()),
        asset_desc_hash: hex::encode(desc_hash),
        asset_digest: hex::encode(digest.as_bytes()),
    })
}

/// Derive the asset id, description hash and Asset Digest for the browser,
/// as lowercase hex.
///
/// `issuance_key_hex` is the 66-character ZIP 227 encoding served as an
/// asset's `issuer`. Every input comes off the wire, so malformed values
/// are errors rather than panics.
#[wasm_bindgen]
pub fn derive_identity(issuance_key_hex: &str, description: &str) -> Result<Identity, JsError> {
    identity(issuance_key_hex, description).map_err(|message| JsError::new(&message))
}

#[cfg(test)]
mod tests {
    use super::{derive, identity};
    use group::GroupEncoding;
    use pasta_curves::arithmetic::CurveExt;
    use pasta_curves::pallas;

    // A real asset on the public ZSA testnet, minted from the browser
    // studio and confirmed at height 520. If this derivation ever stops
    // matching the id the chain assigned, this test says so.
    const ISSUER: &str = "00de18a231dd5ea64deb652ab2826dfd8cdc3c261b097f92c2ad5e0defefbaae78";
    const DESCRIPTION: &str = concat!(
        r#"{"v":1,"name":"Minted From A Browser","#,
        r#""sha256":"7f9a9e42ba1127d50cea940c3b747d2803aa53dbf7ecda1645d58b0334a83b20"}"#
    );
    const ASSET_ID: &str = "3081f54e5e0bb0995dc2be069394b7d26307728c3090a287c8f09ba235cdb70e";

    // Another key that really issues on the same chain, so the
    // different-issuer case exercises a valid key rather than a rejected
    // encoding.
    const OTHER_ISSUER: &str = "009aa99143bb05394cdcaa3c383b295dbcf4251ac0e1a66667c94386cae62d6e82";

    #[test]
    fn derives_the_asset_id_the_chain_assigned() {
        assert_eq!(derive(ISSUER, DESCRIPTION).unwrap(), ASSET_ID);
    }

    #[test]
    fn the_digest_is_the_one_the_asset_id_hashes_from() {
        // ZIP 227: AssetBase = GroupHash("z.cash:OrchardZSA", AssetDigest).
        // Hashing our digest to the curve must land on the id the chain
        // assigned, or the digest shown to readers is not the asset's.
        let identity = identity(ISSUER, DESCRIPTION).unwrap();
        let digest = hex::decode(&identity.asset_digest).unwrap();
        assert_eq!(digest.len(), 64);
        let base = pallas::Point::hash_to_curve("z.cash:OrchardZSA")(&digest);
        assert_eq!(hex::encode(base.to_bytes()), ASSET_ID);
        assert_eq!(identity.asset_id, ASSET_ID);
        assert_eq!(identity.asset_desc_hash.len(), 64);
    }

    #[test]
    fn the_published_vectors_still_hold() {
        // packages/registry-spec/vectors is what other wallets check
        // themselves against: it must never drift from what this engine,
        // and so the asset page, derives.
        let file: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../packages/registry-spec/vectors/zip227-identity.json"
        ))
        .unwrap();
        let vectors = file["vectors"].as_array().unwrap();
        assert!(!vectors.is_empty());
        for vector in vectors {
            let field = |name: &str| vector[name].as_str().unwrap().to_owned();
            let derived = identity(&field("issuer"), &field("description")).unwrap();
            assert_eq!(derived.asset_desc_hash, field("asset_desc_hash"));
            assert_eq!(derived.asset_digest, field("asset_digest"));
            assert_eq!(derived.asset_id, field("asset_id"));
            let digest = hex::decode(&derived.asset_digest).unwrap();
            let base = pallas::Point::hash_to_curve("z.cash:OrchardZSA")(&digest);
            assert_eq!(hex::encode(base.to_bytes()), derived.asset_id);
        }
    }

    #[test]
    fn a_tampered_description_derives_a_different_id() {
        // The whole point: swapping the sealed name must not reproduce the
        // id, or the check would be worthless.
        let forged = DESCRIPTION.replace("Minted From A Browser", "Minted From A Browzer");
        assert_ne!(derive(ISSUER, &forged).unwrap(), ASSET_ID);
    }

    #[test]
    fn the_same_description_under_another_key_is_another_asset() {
        // Identity binds the description to its issuer: the same bytes
        // minted by someone else are a different asset entirely.
        assert_ne!(derive(OTHER_ISSUER, DESCRIPTION).unwrap(), ASSET_ID);
    }

    #[test]
    fn malformed_input_is_an_error_not_a_panic() {
        assert!(derive("not hex", DESCRIPTION).is_err());
        assert!(derive("00ff", DESCRIPTION).is_err());
        assert!(derive(ISSUER, "").is_err());
    }
}
