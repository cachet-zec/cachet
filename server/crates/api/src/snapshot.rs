//! Signed registry snapshots: a deterministic export of everything the
//! registry knows, wrapped in a detached Ed25519 signature so a mirror
//! can serve it offline and any client can verify it came from this
//! operator without trusting the mirror.
//!
//! Determinism is the load-bearing property: the payload contains no
//! timestamp and its assets are sorted, so the same chain state always
//! produces byte-identical payloads — mirrors can deduplicate and clients
//! can compare snapshots from independent mirrors. Verification:
//!   1. base64-decode `payload`, check sha256(payload) == `sha256`,
//!   2. verify `signature` over ("cachet-snapshot-v1" || sha256 bytes)
//!      with `public_key` (Ed25519).
//!
//! Moderation carries through honestly: withheld descriptions are simply
//! absent, exactly as they are from the live API — a snapshot can
//! withhold, it can never lie (the chain facts remain complete).

use base64::Engine as _;
use ed25519_dalek::{Signer, SigningKey};
use serde::Serialize;
use sha2::{Digest, Sha256};
use utoipa::ToSchema;

/// Domain separation for the snapshot signature.
const SIGNATURE_DOMAIN: &[u8] = b"cachet-snapshot-v1";

/// One asset in the snapshot payload: exact public chain facts plus the
/// resolved description when this instance serves one.
#[derive(Debug, Serialize)]
pub struct SnapshotAsset {
    pub asset_id: String,
    /// Issuance validating key, ZIP 227 canonical encoding, hex.
    pub issuer: Option<String>,
    pub total_supply: u64,
    pub finalized: bool,
    pub description: Option<String>,
}

/// The signed payload. Serialized once, deterministically; the signature
/// covers those exact bytes.
#[derive(Debug, Serialize)]
pub struct SnapshotPayload {
    /// Payload format version.
    pub version: u32,
    /// Network label, e.g. `regtest` / `zsa-testnet`.
    pub network: String,
    /// Chain tip the snapshot reflects.
    pub tip_height: u64,
    /// Every asset observed on the chain, sorted by asset id.
    pub assets: Vec<SnapshotAsset>,
}

/// The wire envelope: payload bytes plus a detached signature. Mirrors
/// store and serve this JSON as-is.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct SnapshotResponse {
    /// Base64 of the canonical payload JSON (see `SnapshotPayload`).
    pub payload: String,
    /// Hex SHA-256 of the decoded payload bytes.
    pub sha256: String,
    /// Hex Ed25519 signature over ("cachet-snapshot-v1" || sha256 bytes).
    pub signature: String,
    /// Hex Ed25519 public key of the signing operator.
    pub public_key: String,
    /// Convenience mirrors of payload facts (unsigned; trust the payload).
    pub tip_height: u64,
    pub asset_count: u64,
}

/// Parse the operator signing key from its 32-byte hex seed.
pub fn signing_key_from_hex(hex_seed: &str) -> Result<SigningKey, String> {
    let bytes: [u8; 32] = hex::decode(hex_seed.trim())
        .map_err(|error| format!("snapshot key is not hex: {error}"))?
        .try_into()
        .map_err(|_| "snapshot key must be exactly 32 bytes of hex".to_owned())?;
    Ok(SigningKey::from_bytes(&bytes))
}

/// Serialize, hash and sign a payload into the wire envelope.
pub fn seal(payload: &SnapshotPayload, key: &SigningKey) -> SnapshotResponse {
    let bytes = serde_json::to_vec(payload).expect("snapshot payload serializes");
    let sha256: [u8; 32] = Sha256::digest(&bytes).into();
    let mut message = Vec::with_capacity(SIGNATURE_DOMAIN.len() + sha256.len());
    message.extend_from_slice(SIGNATURE_DOMAIN);
    message.extend_from_slice(&sha256);
    let signature = key.sign(&message);
    SnapshotResponse {
        payload: base64::engine::general_purpose::STANDARD.encode(&bytes),
        sha256: hex::encode(sha256),
        signature: hex::encode(signature.to_bytes()),
        public_key: hex::encode(key.verifying_key().to_bytes()),
        tip_height: payload.tip_height,
        asset_count: payload.assets.len() as u64,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Verifier, VerifyingKey};

    fn payload() -> SnapshotPayload {
        SnapshotPayload {
            version: 1,
            network: "regtest".to_owned(),
            tip_height: 42,
            assets: vec![SnapshotAsset {
                asset_id: "aa".repeat(32),
                issuer: Some("00".repeat(33)),
                total_supply: 7,
                finalized: true,
                description: Some("{\"v\":1,\"name\":\"T\"}".to_owned()),
            }],
        }
    }

    #[test]
    fn seal_then_verify_round_trip() {
        let key = signing_key_from_hex(&"11".repeat(32)).unwrap();
        let sealed = seal(&payload(), &key);

        // The documented verification procedure, from the wire fields only.
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(&sealed.payload)
            .unwrap();
        let sha256: [u8; 32] = Sha256::digest(&bytes).into();
        assert_eq!(hex::encode(sha256), sealed.sha256);

        let public = VerifyingKey::from_bytes(
            &<[u8; 32]>::try_from(hex::decode(&sealed.public_key).unwrap()).unwrap(),
        )
        .unwrap();
        let signature = ed25519_dalek::Signature::from_bytes(
            &<[u8; 64]>::try_from(hex::decode(&sealed.signature).unwrap()).unwrap(),
        );
        let mut message = SIGNATURE_DOMAIN.to_vec();
        message.extend_from_slice(&sha256);
        public
            .verify(&message, &signature)
            .expect("signature verifies");

        // Determinism: same payload, same bytes, same signature.
        let again = seal(&payload(), &key);
        assert_eq!(again.sha256, sealed.sha256);
        assert_eq!(again.signature, sealed.signature);
    }

    #[test]
    fn tampered_payload_fails_verification() {
        let key = signing_key_from_hex(&"11".repeat(32)).unwrap();
        let sealed = seal(&payload(), &key);
        let mut tampered = payload();
        tampered.assets[0].total_supply = 9_999;
        let bytes = serde_json::to_vec(&tampered).unwrap();
        let sha256: [u8; 32] = Sha256::digest(&bytes).into();
        assert_ne!(hex::encode(sha256), sealed.sha256, "hash must change");
    }
}
