//! Content-addressed storage for metadata bundles.
//!
//! Bundles are keyed by the SHA-256 of their exact bytes — the same hash
//! the issuer commits on-chain inside the asset description. Integrity is
//! therefore verifiable by any reader; this store only provides
//! availability.

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;

use async_trait::async_trait;
use sha2::{Digest, Sha256};
use sqlx::Row;

use crate::{AssetIndex, HiddenEntry, IndexError, ModerationKind};

#[async_trait]
pub trait MetadataStore: Send + Sync {
    /// Store `bytes` and return their SHA-256 (idempotent by construction).
    async fn put(&self, bytes: Vec<u8>) -> Result<[u8; 32], IndexError>;

    /// Fetch the bytes for a hash, if present.
    async fn get(&self, sha256: [u8; 32]) -> Result<Option<Vec<u8>>, IndexError>;

    /// Whether the operator has hidden this bundle from distribution
    /// (availability-only moderation; the content itself is untouched).
    async fn is_hidden(&self, _sha256: [u8; 32]) -> Result<bool, IndexError> {
        Ok(false)
    }

    /// Issuance keys the operator has hidden: their assets leave every
    /// listing and answer 410. Default: none (moderation-less stores).
    async fn hidden_issuers(&self) -> Result<Vec<Vec<u8>>, IndexError> {
        Ok(Vec::new())
    }

    /// Operator moderation over the store: hide a key of the given kind.
    /// Exposed on the trait so the (token-gated, optional) admin surface
    /// can reach it without knowing the backend.
    async fn moderation_hide(
        &self,
        _kind: ModerationKind,
        _key: &[u8],
        _reason: Option<&str>,
    ) -> Result<(), IndexError> {
        Err(IndexError::OutOfRange(
            "this metadata store does not support moderation".into(),
        ))
    }

    /// Lift a moderation entry; returns whether one existed.
    async fn moderation_unhide(
        &self,
        _kind: ModerationKind,
        _key: &[u8],
    ) -> Result<bool, IndexError> {
        Ok(false)
    }

    /// Every moderation entry, for audit listings.
    async fn moderation_list(&self) -> Result<Vec<HiddenEntry>, IndexError> {
        Ok(Vec::new())
    }

    /// Delete a bundle's bytes outright; returns whether they existed.
    /// Withholding keeps bytes on disk, and for some content (illegal
    /// material) an operator must not keep them at all. The chain
    /// commitment is untouched: the asset still exists, its hash still
    /// names these bytes, this registry simply no longer has them.
    async fn delete(&self, _sha256: [u8; 32]) -> Result<bool, IndexError> {
        Err(IndexError::OutOfRange(
            "this metadata store does not support deletion".into(),
        ))
    }

    /// An operator-wide setting (the mint pause, for one), persisted so a
    /// restart keeps the decision. Default: nothing stored.
    async fn setting_get(&self, _key: &str) -> Result<Option<String>, IndexError> {
        Ok(None)
    }

    /// Write an operator-wide setting.
    async fn setting_set(&self, _key: &str, _value: &str) -> Result<(), IndexError> {
        Err(IndexError::OutOfRange(
            "this metadata store does not persist settings".into(),
        ))
    }

    /// The subset of `hashes` that are stored, not hidden, and embed an
    /// image — the one question the registry listing asks. Backends
    /// should answer it in a bounded number of round trips; the default
    /// loops (fine for the in-memory store).
    async fn visible_image_hashes(
        &self,
        hashes: &[[u8; 32]],
    ) -> Result<HashSet<[u8; 32]>, IndexError> {
        let mut visible = HashSet::new();
        for &sha256 in hashes {
            if self.is_hidden(sha256).await? {
                continue;
            }
            if let Some(bytes) = self.get(sha256).await? {
                if has_embedded_image(&bytes) {
                    visible.insert(sha256);
                }
            }
        }
        Ok(visible)
    }
}

/// Canonical bundle bytes are JSON; an embedded image shows up as an
/// `"image_data_uri":"data:` string value (None serializes as null).
/// Matching bytes keeps the check identical between backends without
/// parsing the whole document.
pub(crate) fn has_embedded_image(bytes: &[u8]) -> bool {
    let needle = br#""image_data_uri":"data:"#;
    bytes.windows(needle.len()).any(|window| window == needle)
}

pub fn hash_bytes(bytes: &[u8]) -> [u8; 32] {
    Sha256::digest(bytes).into()
}

#[async_trait]
impl MetadataStore for AssetIndex {
    async fn put(&self, bytes: Vec<u8>) -> Result<[u8; 32], IndexError> {
        let sha256 = hash_bytes(&bytes);
        sqlx::query(
            "INSERT INTO metadata_bundles (sha256, bytes) VALUES ($1, $2)
             ON CONFLICT (sha256) DO NOTHING",
        )
        .bind(sha256.as_slice())
        .bind(&bytes)
        .execute(self.pool())
        .await?;
        Ok(sha256)
    }

    async fn get(&self, sha256: [u8; 32]) -> Result<Option<Vec<u8>>, IndexError> {
        let row = sqlx::query("SELECT bytes FROM metadata_bundles WHERE sha256 = $1")
            .bind(sha256.as_slice())
            .fetch_optional(self.pool())
            .await?;
        Ok(row.map(|row| row.get("bytes")))
    }

    async fn is_hidden(&self, sha256: [u8; 32]) -> Result<bool, IndexError> {
        AssetIndex::is_hidden(self, ModerationKind::Bundle, sha256.as_slice()).await
    }

    async fn hidden_issuers(&self) -> Result<Vec<Vec<u8>>, IndexError> {
        let rows = sqlx::query("SELECT key FROM moderation_hidden WHERE kind = $1")
            .bind(ModerationKind::Issuer.as_str())
            .fetch_all(self.pool())
            .await?;
        Ok(rows.into_iter().map(|row| row.get("key")).collect())
    }

    async fn moderation_hide(
        &self,
        kind: ModerationKind,
        key: &[u8],
        reason: Option<&str>,
    ) -> Result<(), IndexError> {
        AssetIndex::hide(self, kind, key, reason).await
    }

    async fn moderation_unhide(
        &self,
        kind: ModerationKind,
        key: &[u8],
    ) -> Result<bool, IndexError> {
        AssetIndex::unhide(self, kind, key).await
    }

    async fn moderation_list(&self) -> Result<Vec<HiddenEntry>, IndexError> {
        AssetIndex::list_hidden(self).await
    }

    async fn delete(&self, sha256: [u8; 32]) -> Result<bool, IndexError> {
        let result = sqlx::query("DELETE FROM metadata_bundles WHERE sha256 = $1")
            .bind(sha256.as_slice())
            .execute(self.pool())
            .await?;
        Ok(result.rows_affected() > 0)
    }

    async fn setting_get(&self, key: &str) -> Result<Option<String>, IndexError> {
        let row = sqlx::query("SELECT value FROM operator_settings WHERE key = $1")
            .bind(key)
            .fetch_optional(self.pool())
            .await?;
        Ok(row.map(|row| row.get("value")))
    }

    async fn setting_set(&self, key: &str, value: &str) -> Result<(), IndexError> {
        sqlx::query(
            "INSERT INTO operator_settings (key, value) VALUES ($1, $2)
             ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()",
        )
        .bind(key)
        .bind(value)
        .execute(self.pool())
        .await?;
        Ok(())
    }

    /// Two round trips regardless of registry size (image test + hidden
    /// filter), instead of the default's two per asset. The image test
    /// runs inside Postgres over the stored bytes, so bundle payloads
    /// (up to ~400 KB each) never cross the wire for a listing.
    async fn visible_image_hashes(
        &self,
        hashes: &[[u8; 32]],
    ) -> Result<HashSet<[u8; 32]>, IndexError> {
        if hashes.is_empty() {
            return Ok(HashSet::new());
        }
        let keys: Vec<Vec<u8>> = hashes.iter().map(|hash| hash.to_vec()).collect();
        let rows = sqlx::query(
            // Byte-level search, not convert_from: the latter RAISES on any
            // row that is not valid UTF-8, which would turn one bad row into
            // a 503 for the whole registry listing. This is byte-for-byte
            // the same test as `has_embedded_image`.
            r#"SELECT sha256 FROM metadata_bundles
               WHERE sha256 = ANY($1)
                 AND position('"image_data_uri":"data:'::bytea in bytes) > 0"#,
        )
        .bind(&keys)
        .fetch_all(self.pool())
        .await?;
        let mut visible: HashSet<[u8; 32]> = rows
            .iter()
            .filter_map(|row| row.get::<Vec<u8>, _>("sha256").try_into().ok())
            .collect();
        if visible.is_empty() {
            return Ok(visible);
        }
        let hidden =
            sqlx::query("SELECT key FROM moderation_hidden WHERE kind = $1 AND key = ANY($2)")
                .bind(ModerationKind::Bundle.as_str())
                .bind(&keys)
                .fetch_all(self.pool())
                .await?;
        for row in hidden {
            if let Ok(key) = <[u8; 32]>::try_from(row.get::<Vec<u8>, _>("key").as_slice()) {
                visible.remove(&key);
            }
        }
        Ok(visible)
    }
}

/// (kind, key) → reason: mirrors the Postgres moderation table.
type ModerationMap = HashMap<(String, Vec<u8>), Option<String>>;

/// In-memory store for tests and database-less development.
#[derive(Debug, Default)]
pub struct MemoryMetadataStore {
    bundles: Mutex<HashMap<[u8; 32], Vec<u8>>>,
    hidden: Mutex<HashSet<[u8; 32]>>,
    moderation: Mutex<ModerationMap>,
    settings: Mutex<HashMap<String, String>>,
}

impl MemoryMetadataStore {
    pub fn new() -> Self {
        Self::default()
    }

    /// Test hook mirroring the operator denylist.
    pub fn hide(&self, sha256: [u8; 32]) {
        self.hidden
            .lock()
            .expect("metadata store lock poisoned")
            .insert(sha256);
    }
}

#[async_trait]
impl MetadataStore for MemoryMetadataStore {
    async fn put(&self, bytes: Vec<u8>) -> Result<[u8; 32], IndexError> {
        let sha256 = hash_bytes(&bytes);
        self.bundles
            .lock()
            .expect("metadata store lock poisoned")
            .insert(sha256, bytes);
        Ok(sha256)
    }

    async fn get(&self, sha256: [u8; 32]) -> Result<Option<Vec<u8>>, IndexError> {
        Ok(self
            .bundles
            .lock()
            .expect("metadata store lock poisoned")
            .get(&sha256)
            .cloned())
    }

    async fn is_hidden(&self, sha256: [u8; 32]) -> Result<bool, IndexError> {
        let via_hide = self
            .hidden
            .lock()
            .expect("metadata store lock poisoned")
            .contains(&sha256);
        let via_moderation = self
            .moderation
            .lock()
            .expect("metadata store lock poisoned")
            .contains_key(&("bundle".to_owned(), sha256.to_vec()));
        Ok(via_hide || via_moderation)
    }

    async fn hidden_issuers(&self) -> Result<Vec<Vec<u8>>, IndexError> {
        Ok(self
            .moderation
            .lock()
            .expect("metadata store lock poisoned")
            .keys()
            .filter(|(kind, _)| kind == "issuer")
            .map(|(_, key)| key.clone())
            .collect())
    }

    async fn moderation_hide(
        &self,
        kind: ModerationKind,
        key: &[u8],
        reason: Option<&str>,
    ) -> Result<(), IndexError> {
        self.moderation
            .lock()
            .expect("metadata store lock poisoned")
            .insert(
                (kind.as_str().to_owned(), key.to_vec()),
                reason.map(str::to_owned),
            );
        Ok(())
    }

    async fn moderation_unhide(
        &self,
        kind: ModerationKind,
        key: &[u8],
    ) -> Result<bool, IndexError> {
        Ok(self
            .moderation
            .lock()
            .expect("metadata store lock poisoned")
            .remove(&(kind.as_str().to_owned(), key.to_vec()))
            .is_some())
    }

    async fn moderation_list(&self) -> Result<Vec<HiddenEntry>, IndexError> {
        Ok(self
            .moderation
            .lock()
            .expect("metadata store lock poisoned")
            .iter()
            .map(|((kind, key), reason)| HiddenEntry {
                kind: kind.clone(),
                key: hex::encode(key),
                reason: reason.clone(),
                hidden_at: String::new(),
            })
            .collect())
    }

    async fn delete(&self, sha256: [u8; 32]) -> Result<bool, IndexError> {
        Ok(self
            .bundles
            .lock()
            .expect("metadata store lock poisoned")
            .remove(&sha256)
            .is_some())
    }

    async fn setting_get(&self, key: &str) -> Result<Option<String>, IndexError> {
        Ok(self
            .settings
            .lock()
            .expect("metadata store lock poisoned")
            .get(key)
            .cloned())
    }

    async fn setting_set(&self, key: &str, value: &str) -> Result<(), IndexError> {
        self.settings
            .lock()
            .expect("metadata store lock poisoned")
            .insert(key.to_owned(), value.to_owned());
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn memory_store_round_trips_by_hash() {
        let store = MemoryMetadataStore::new();
        let sha256 = store.put(b"hello".to_vec()).await.unwrap();
        assert_eq!(sha256, hash_bytes(b"hello"));
        assert_eq!(store.get(sha256).await.unwrap().unwrap(), b"hello");
        assert!(store.get([0; 32]).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn delete_forgets_the_bytes_but_not_the_moderation() {
        let store = MemoryMetadataStore::new();
        let sha256 = store.put(b"gone".to_vec()).await.unwrap();
        store
            .moderation_hide(ModerationKind::Bundle, &sha256, Some("purged"))
            .await
            .unwrap();
        assert!(store.delete(sha256).await.unwrap());
        assert!(store.get(sha256).await.unwrap().is_none());
        assert!(
            !store.delete(sha256).await.unwrap(),
            "second delete is a no-op"
        );
        // The denylist survives the deletion: the bytes stay refused.
        assert!(store.is_hidden(sha256).await.unwrap());
    }
}
