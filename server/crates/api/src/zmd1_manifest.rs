//! ZMD-1 full-form manifest resolution: fetch the manifest a foreign
//! (ZecBit-convention) asset committed to on chain, verify it against the
//! on-chain content hash, and serve it verified.
//!
//! Neutral-infrastructure rationale: a ZMD-1 full-form descriptor commits
//! the chain (transitively, through the asset id) to BLAKE2b-256 of the
//! manifest bytes, exactly as Cachet's envelope commits to its bundle. So
//! the registry can display foreign metadata with the same "cannot be
//! lied to" guarantee — a matching preimage is definitionally correct.
//!
//! Privacy: the SERVER fetches from the IPFS gateway, never the visitor's
//! browser (a gateway request would reveal which asset they are viewing,
//! and the console makes no third-party requests at runtime). Verified
//! manifests are content-addressed and therefore immutable: they are
//! cached for the life of the process.
//!
//! Abuse posture: text only, bounded size, bounded time. The manifest's
//! image stays a link the visitor may choose to follow; this instance
//! never proxies or embeds third-party images.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

/// Manifests are small JSON documents; anything bigger is refused.
const MAX_MANIFEST_BYTES: usize = 64 * 1024;
/// Upper bound on gateway fetch time.
const FETCH_TIMEOUT: Duration = Duration::from_secs(8);
/// Verified manifests kept in memory (content-addressed, immutable).
const CACHE_CAP: usize = 512;

/// Default public gateway; operators override with CACHET_IPFS_GATEWAY.
pub fn gateway_from_env() -> String {
    std::env::var("CACHET_IPFS_GATEWAY")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "https://ipfs.io".to_owned())
        .trim_end_matches('/')
        .to_owned()
}

/// BLAKE2b-256 of the manifest bytes, lowercase hex (the ZMD-1 content
/// hash: plain, unkeyed, no personalization).
pub fn manifest_content_hash(bytes: &[u8]) -> String {
    let hash = blake2b_simd::Params::new().hash_length(32).hash(bytes);
    hex::encode(hash.as_bytes())
}

/// Check manifest bytes against the descriptor's content hash.
pub fn verify_manifest(bytes: &[u8], expected_hash_hex: &str) -> bool {
    manifest_content_hash(bytes) == expected_hash_hex
}

#[derive(Debug, thiserror::Error)]
pub enum ManifestError {
    #[error("the IPFS gateway could not serve the manifest: {0}")]
    Unavailable(String),
    #[error("manifest exceeds the {MAX_MANIFEST_BYTES}-byte bound")]
    TooLarge,
    #[error("manifest bytes do not hash to the on-chain commitment")]
    HashMismatch,
    #[error("manifest is not valid UTF-8 text")]
    NotText,
}

/// Process-wide cache of verified manifests, keyed by content hash (the
/// strongest possible key: the bytes ARE the identity).
static VERIFIED: Mutex<Option<HashMap<String, String>>> = Mutex::new(None);

fn cache_get(content_hash: &str) -> Option<String> {
    VERIFIED
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .as_ref()
        .and_then(|map| map.get(content_hash).cloned())
}

fn cache_put(content_hash: String, manifest: String) {
    let mut guard = VERIFIED
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let map = guard.get_or_insert_with(HashMap::new);
    if map.len() >= CACHE_CAP {
        return; // full: still correct, just uncached
    }
    map.insert(content_hash, manifest);
}

/// Fetch `cid` from the gateway and verify it against `content_hash`.
/// Returns the verified manifest text.
pub async fn fetch_verified(
    gateway: &str,
    cid: &str,
    content_hash: &str,
) -> Result<String, ManifestError> {
    if let Some(manifest) = cache_get(content_hash) {
        return Ok(manifest);
    }

    let url = format!("{gateway}/ipfs/{cid}");
    let client = reqwest::Client::builder()
        .timeout(FETCH_TIMEOUT)
        // No redirect following: a gateway (or a MITM) must not be able to
        // bounce this operator-side request at an internal address (SSRF).
        // The only legitimate target is the configured gateway.
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|error| ManifestError::Unavailable(error.to_string()))?;
    let mut response = client
        .get(&url)
        .send()
        .await
        .map_err(|error| ManifestError::Unavailable(error.to_string()))?;
    if !response.status().is_success() {
        return Err(ManifestError::Unavailable(format!(
            "gateway answered {}",
            response.status()
        )));
    }
    // A Content-Length can be absent (chunked) or lie, so it is only an
    // early-out, never the real bound: read the body chunk by chunk and
    // stop the moment it exceeds the cap, rather than buffering an
    // unbounded stream into memory first.
    if let Some(length) = response.content_length() {
        if length as usize > MAX_MANIFEST_BYTES {
            return Err(ManifestError::TooLarge);
        }
    }
    let mut bytes: Vec<u8> = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| ManifestError::Unavailable(error.to_string()))?
    {
        if bytes.len() + chunk.len() > MAX_MANIFEST_BYTES {
            return Err(ManifestError::TooLarge);
        }
        bytes.extend_from_slice(&chunk);
    }
    if !verify_manifest(&bytes, content_hash) {
        return Err(ManifestError::HashMismatch);
    }
    let manifest = String::from_utf8(bytes.to_vec()).map_err(|_| ManifestError::NotText)?;
    cache_put(content_hash.to_owned(), manifest.clone());
    Ok(manifest)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn content_hash_is_plain_blake2b_256() {
        // Independently computable: BLAKE2b with 32-byte output, no key,
        // no personalization, hex-encoded.
        let hash = manifest_content_hash(b"{\"name\":\"Test #1\"}");
        assert_eq!(hash.len(), 64);
        assert!(verify_manifest(b"{\"name\":\"Test #1\"}", &hash));
        assert!(!verify_manifest(b"{\"name\":\"Test #2\"}", &hash));
    }

    #[test]
    fn cache_round_trip() {
        let hash = "ab".repeat(32);
        assert!(cache_get(&hash).is_none());
        cache_put(hash.clone(), "{\"cached\":true}".to_owned());
        assert_eq!(cache_get(&hash).as_deref(), Some("{\"cached\":true}"));
    }
}
