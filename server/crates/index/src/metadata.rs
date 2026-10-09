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

use crate::{
    AssetIndex, HiddenEntry, IndexError, ModerationKind, SWAP_MAKER_AWAY_SECS, SWAP_TAKE_HOLD_SECS,
    SwapFill, SwapRow,
};

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

    /// Post an offer to the swap board.
    async fn swap_insert(&self, _row: SwapRow) -> Result<(), IndexError> {
        Err(IndexError::OutOfRange(
            "this metadata store does not keep a swap board".into(),
        ))
    }

    /// One offer, whatever its state.
    async fn swap_get(&self, _id: &str) -> Result<Option<SwapRow>, IndexError> {
        Ok(None)
    }

    /// Offers a taker can take at `now`, newest first.
    async fn swap_list_open(&self, _now: i64, _limit: u32) -> Result<Vec<SwapRow>, IndexError> {
        Ok(Vec::new())
    }

    /// The maker's page checked in at `now`; false if the token does not
    /// match an offer still up.
    async fn swap_seen(
        &self,
        _id: &str,
        _maker_token: [u8; 32],
        _now: i64,
    ) -> Result<bool, IndexError> {
        Ok(false)
    }

    /// Record a take if the offer is open at `now`; false otherwise.
    async fn swap_take(
        &self,
        _id: &str,
        _take: &str,
        _taker_token: [u8; 32],
        _now: i64,
    ) -> Result<bool, IndexError> {
        Ok(false)
    }

    /// Record the maker's countersignature of the take recorded at
    /// `taken_at` (so a signature for an expired take never lands on a
    /// newer one); false if the token, the take or the state do not match.
    async fn swap_countersign(
        &self,
        _id: &str,
        _maker_token: [u8; 32],
        _taken_at: i64,
        _countersignature: &str,
        _txid: &str,
    ) -> Result<bool, IndexError> {
        Ok(false)
    }

    /// Countersigned offers whose transaction the chain has not shown yet.
    async fn swap_awaiting_fill(&self) -> Result<Vec<SwapRow>, IndexError> {
        Ok(Vec::new())
    }

    /// The offer countersigned for transaction `txid`, if any.
    async fn swap_for_txid(&self, _txid: &str) -> Result<Option<SwapRow>, IndexError> {
        Ok(None)
    }

    /// Record a swap the chain shows landed, and close its offer.
    async fn swap_record_fill(&self, _fill: &SwapFill) -> Result<(), IndexError> {
        Ok(())
    }

    /// The board offer transaction `txid` filled, if it filled one.
    async fn swap_fill(&self, _txid: &str) -> Result<Option<SwapFill>, IndexError> {
        Ok(None)
    }

    /// Drop the take holding an offer (the maker refused it), so the offer
    /// is open again at once; false if the token, or the state, do not match.
    async fn swap_release(&self, _id: &str, _maker_token: [u8; 32]) -> Result<bool, IndexError> {
        Ok(false)
    }

    /// Close an offer: the maker withdrawing it, or the taker reporting it
    /// complete once countersigned. False if the token does not allow it.
    async fn swap_close(&self, _id: &str, _token: [u8; 32]) -> Result<bool, IndexError> {
        Ok(false)
    }

    /// Delete offers closed or expired more than a day before `now`.
    async fn swap_sweep(&self, _now: i64) -> Result<u64, IndexError> {
        Ok(0)
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

fn out_of_range(what: &str) -> IndexError {
    IndexError::OutOfRange(format!("{what} out of range"))
}

fn bytes32(value: Vec<u8>, what: &str) -> Result<[u8; 32], IndexError> {
    value.try_into().map_err(|_| out_of_range(what))
}

fn swap_row(row: sqlx::postgres::PgRow) -> Result<SwapRow, IndexError> {
    Ok(SwapRow {
        id: row.get("id"),
        offer: row.get("offer"),
        give_asset: bytes32(row.get("give_asset"), "give asset")?,
        give_amount: u64::try_from(row.get::<i64, _>("give_amount"))
            .map_err(|_| out_of_range("give amount"))?,
        want_asset: bytes32(row.get("want_asset"), "want asset")?,
        want_amount: u64::try_from(row.get::<i64, _>("want_amount"))
            .map_err(|_| out_of_range("want amount"))?,
        maker_token: bytes32(row.get("maker_token"), "maker token")?,
        created_at: row.get("created_at"),
        expires_at: row.get("expires_at"),
        maker_seen_at: row.get("maker_seen_at"),
        take: row.get("take"),
        taker_token: row
            .get::<Option<Vec<u8>>, _>("taker_token")
            .map(|token| bytes32(token, "taker token"))
            .transpose()?,
        taken_at: row.get("taken_at"),
        countersignature: row.get("countersignature"),
        txid: row.get("txid"),
        closed: row.get("closed"),
    })
}

fn swap_fill_row(row: sqlx::postgres::PgRow) -> Result<SwapFill, IndexError> {
    Ok(SwapFill {
        txid: row.get("txid"),
        offer_id: row.get("offer_id"),
        give_asset: bytes32(row.get("give_asset"), "give asset")?,
        give_amount: u64::try_from(row.get::<i64, _>("give_amount"))
            .map_err(|_| out_of_range("give amount"))?,
        want_asset: bytes32(row.get("want_asset"), "want asset")?,
        want_amount: u64::try_from(row.get::<i64, _>("want_amount"))
            .map_err(|_| out_of_range("want amount"))?,
        height: u64::try_from(row.get::<i64, _>("height")).map_err(|_| out_of_range("height"))?,
    })
}

pub fn hash_bytes(bytes: &[u8]) -> [u8; 32] {
    Sha256::digest(bytes).into()
}

#[async_trait]
impl MetadataStore for AssetIndex {
    async fn put(&self, bytes: Vec<u8>) -> Result<[u8; 32], IndexError> {
        let sha256 = hash_bytes(&bytes);
        sqlx::query(
            "INSERT INTO metadata_bundles (sha256, bytes, has_image) VALUES ($1, $2, $3)
             ON CONFLICT (sha256) DO NOTHING",
        )
        .bind(sha256.as_slice())
        .bind(&bytes)
        // Tested once, here, so no listing ever reads the bytes to ask.
        .bind(has_embedded_image(&bytes))
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

    async fn swap_insert(&self, row: SwapRow) -> Result<(), IndexError> {
        sqlx::query(
            "INSERT INTO swap_offers (id, offer, give_asset, give_amount, want_asset, want_amount,
                 maker_token, created_at, expires_at, maker_seen_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)",
        )
        .bind(&row.id)
        .bind(&row.offer)
        .bind(row.give_asset.as_slice())
        .bind(i64::try_from(row.give_amount).map_err(|_| out_of_range("give amount"))?)
        .bind(row.want_asset.as_slice())
        .bind(i64::try_from(row.want_amount).map_err(|_| out_of_range("want amount"))?)
        .bind(row.maker_token.as_slice())
        .bind(row.created_at)
        .bind(row.expires_at)
        .bind(row.maker_seen_at)
        .execute(self.pool())
        .await?;
        Ok(())
    }

    async fn swap_seen(
        &self,
        id: &str,
        maker_token: [u8; 32],
        now: i64,
    ) -> Result<bool, IndexError> {
        let result = sqlx::query(
            "UPDATE swap_offers SET maker_seen_at = $3
             WHERE id = $1 AND maker_token = $2 AND NOT closed",
        )
        .bind(id)
        .bind(maker_token.as_slice())
        .bind(now)
        .execute(self.pool())
        .await?;
        Ok(result.rows_affected() == 1)
    }

    async fn swap_get(&self, id: &str) -> Result<Option<SwapRow>, IndexError> {
        let row = sqlx::query("SELECT * FROM swap_offers WHERE id = $1")
            .bind(id)
            .fetch_optional(self.pool())
            .await?;
        row.map(swap_row).transpose()
    }

    async fn swap_list_open(&self, now: i64, limit: u32) -> Result<Vec<SwapRow>, IndexError> {
        let rows = sqlx::query(
            "SELECT * FROM swap_offers
             WHERE NOT closed AND expires_at > $1 AND maker_seen_at + $4 > $1
               AND (take IS NULL OR (countersignature IS NULL AND taken_at + $2 <= $1))
             ORDER BY created_at DESC LIMIT $3",
        )
        .bind(now)
        .bind(SWAP_TAKE_HOLD_SECS)
        .bind(i64::from(limit))
        .bind(SWAP_MAKER_AWAY_SECS)
        .fetch_all(self.pool())
        .await?;
        rows.into_iter().map(swap_row).collect()
    }

    async fn swap_take(
        &self,
        id: &str,
        take: &str,
        taker_token: [u8; 32],
        now: i64,
    ) -> Result<bool, IndexError> {
        // One statement: two takers racing for the same offer cannot both win.
        let result = sqlx::query(
            "UPDATE swap_offers SET take = $2, taker_token = $3, taken_at = $4, countersignature = NULL
             WHERE id = $1 AND NOT closed AND expires_at > $4 AND maker_seen_at + $6 > $4
               AND (take IS NULL OR (countersignature IS NULL AND taken_at + $5 <= $4))",
        )
        .bind(id)
        .bind(take)
        .bind(taker_token.as_slice())
        .bind(now)
        .bind(SWAP_TAKE_HOLD_SECS)
        .bind(SWAP_MAKER_AWAY_SECS)
        .execute(self.pool())
        .await?;
        Ok(result.rows_affected() == 1)
    }

    async fn swap_countersign(
        &self,
        id: &str,
        maker_token: [u8; 32],
        taken_at: i64,
        countersignature: &str,
        txid: &str,
    ) -> Result<bool, IndexError> {
        let result = sqlx::query(
            "UPDATE swap_offers SET countersignature = $4, txid = $5
             WHERE id = $1 AND maker_token = $2 AND taken_at = $3
               AND take IS NOT NULL AND countersignature IS NULL AND NOT closed",
        )
        .bind(id)
        .bind(maker_token.as_slice())
        .bind(taken_at)
        .bind(countersignature)
        .bind(txid)
        .execute(self.pool())
        .await?;
        Ok(result.rows_affected() == 1)
    }

    async fn swap_awaiting_fill(&self) -> Result<Vec<SwapRow>, IndexError> {
        let rows = sqlx::query(
            "SELECT o.* FROM swap_offers o
             WHERE o.txid IS NOT NULL
               AND NOT EXISTS (SELECT 1 FROM swap_fills f WHERE f.txid = o.txid)",
        )
        .fetch_all(self.pool())
        .await?;
        rows.into_iter().map(swap_row).collect()
    }

    async fn swap_for_txid(&self, txid: &str) -> Result<Option<SwapRow>, IndexError> {
        let row = sqlx::query("SELECT * FROM swap_offers WHERE txid = $1 LIMIT 1")
            .bind(txid)
            .fetch_optional(self.pool())
            .await?;
        row.map(swap_row).transpose()
    }

    async fn swap_record_fill(&self, fill: &SwapFill) -> Result<(), IndexError> {
        let mut tx = self.pool().begin().await?;
        sqlx::query(
            "INSERT INTO swap_fills (txid, offer_id, give_asset, give_amount, want_asset,
                 want_amount, height)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             ON CONFLICT (txid) DO NOTHING",
        )
        .bind(&fill.txid)
        .bind(&fill.offer_id)
        .bind(fill.give_asset.as_slice())
        .bind(i64::try_from(fill.give_amount).map_err(|_| out_of_range("give amount"))?)
        .bind(fill.want_asset.as_slice())
        .bind(i64::try_from(fill.want_amount).map_err(|_| out_of_range("want amount"))?)
        .bind(i64::try_from(fill.height).map_err(|_| out_of_range("height"))?)
        .execute(&mut *tx)
        .await?;
        sqlx::query("UPDATE swap_offers SET closed = true WHERE id = $1")
            .bind(&fill.offer_id)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        Ok(())
    }

    async fn swap_fill(&self, txid: &str) -> Result<Option<SwapFill>, IndexError> {
        let row = sqlx::query("SELECT * FROM swap_fills WHERE txid = $1")
            .bind(txid)
            .fetch_optional(self.pool())
            .await?;
        row.map(swap_fill_row).transpose()
    }

    async fn swap_release(&self, id: &str, maker_token: [u8; 32]) -> Result<bool, IndexError> {
        let result = sqlx::query(
            "UPDATE swap_offers SET take = NULL, taker_token = NULL, taken_at = NULL
             WHERE id = $1 AND maker_token = $2 AND take IS NOT NULL
               AND countersignature IS NULL AND NOT closed",
        )
        .bind(id)
        .bind(maker_token.as_slice())
        .execute(self.pool())
        .await?;
        Ok(result.rows_affected() == 1)
    }

    async fn swap_close(&self, id: &str, token: [u8; 32]) -> Result<bool, IndexError> {
        let result = sqlx::query(
            "UPDATE swap_offers SET closed = true
             WHERE id = $1 AND NOT closed
               AND (maker_token = $2 OR (taker_token = $2 AND countersignature IS NOT NULL))",
        )
        .bind(id)
        .bind(token.as_slice())
        .execute(self.pool())
        .await?;
        Ok(result.rows_affected() == 1)
    }

    async fn swap_sweep(&self, now: i64) -> Result<u64, IndexError> {
        let result = sqlx::query(
            "DELETE FROM swap_offers
             WHERE expires_at < $1 - 86400 OR (closed AND created_at < $1 - 86400)",
        )
        .bind(now)
        .execute(self.pool())
        .await?;
        Ok(result.rows_affected())
    }

    /// Two round trips regardless of registry size (image flag + hidden
    /// filter), instead of the default's two per asset. The flag is set
    /// when a bundle is stored (`has_embedded_image`, the same byte test),
    /// so a listing reads no bundle at all.
    async fn visible_image_hashes(
        &self,
        hashes: &[[u8; 32]],
    ) -> Result<HashSet<[u8; 32]>, IndexError> {
        if hashes.is_empty() {
            return Ok(HashSet::new());
        }
        let keys: Vec<Vec<u8>> = hashes.iter().map(|hash| hash.to_vec()).collect();
        let rows =
            sqlx::query("SELECT sha256 FROM metadata_bundles WHERE sha256 = ANY($1) AND has_image")
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
    swaps: Mutex<Vec<SwapRow>>,
    fills: Mutex<Vec<SwapFill>>,
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

    async fn swap_insert(&self, row: SwapRow) -> Result<(), IndexError> {
        self.swaps
            .lock()
            .expect("metadata store lock poisoned")
            .push(row);
        Ok(())
    }

    async fn swap_get(&self, id: &str) -> Result<Option<SwapRow>, IndexError> {
        Ok(self
            .swaps
            .lock()
            .expect("metadata store lock poisoned")
            .iter()
            .find(|row| row.id == id)
            .cloned())
    }

    async fn swap_list_open(&self, now: i64, limit: u32) -> Result<Vec<SwapRow>, IndexError> {
        let mut open: Vec<SwapRow> = self
            .swaps
            .lock()
            .expect("metadata store lock poisoned")
            .iter()
            .filter(|row| row.is_open(now))
            .cloned()
            .collect();
        open.sort_by_key(|row| std::cmp::Reverse(row.created_at));
        open.truncate(limit as usize);
        Ok(open)
    }

    async fn swap_seen(
        &self,
        id: &str,
        maker_token: [u8; 32],
        now: i64,
    ) -> Result<bool, IndexError> {
        let mut swaps = self.swaps.lock().expect("metadata store lock poisoned");
        match swaps
            .iter_mut()
            .find(|row| row.id == id && row.maker_token == maker_token && !row.closed)
        {
            Some(row) => {
                row.maker_seen_at = now;
                Ok(true)
            }
            None => Ok(false),
        }
    }

    async fn swap_take(
        &self,
        id: &str,
        take: &str,
        taker_token: [u8; 32],
        now: i64,
    ) -> Result<bool, IndexError> {
        let mut swaps = self.swaps.lock().expect("metadata store lock poisoned");
        match swaps
            .iter_mut()
            .find(|row| row.id == id && row.is_open(now))
        {
            Some(row) => {
                row.take = Some(take.to_owned());
                row.taker_token = Some(taker_token);
                row.taken_at = Some(now);
                row.countersignature = None;
                Ok(true)
            }
            None => Ok(false),
        }
    }

    async fn swap_countersign(
        &self,
        id: &str,
        maker_token: [u8; 32],
        taken_at: i64,
        countersignature: &str,
        txid: &str,
    ) -> Result<bool, IndexError> {
        let mut swaps = self.swaps.lock().expect("metadata store lock poisoned");
        match swaps.iter_mut().find(|row| {
            row.id == id
                && row.maker_token == maker_token
                && row.taken_at == Some(taken_at)
                && row.take.is_some()
                && row.countersignature.is_none()
                && !row.closed
        }) {
            Some(row) => {
                row.countersignature = Some(countersignature.to_owned());
                row.txid = Some(txid.to_owned());
                Ok(true)
            }
            None => Ok(false),
        }
    }

    async fn swap_awaiting_fill(&self) -> Result<Vec<SwapRow>, IndexError> {
        let fills = self.fills.lock().expect("metadata store lock poisoned");
        let swaps = self.swaps.lock().expect("metadata store lock poisoned");
        Ok(swaps
            .iter()
            .filter(|row| {
                row.txid
                    .as_ref()
                    .is_some_and(|txid| !fills.iter().any(|fill| &fill.txid == txid))
            })
            .cloned()
            .collect())
    }

    async fn swap_for_txid(&self, txid: &str) -> Result<Option<SwapRow>, IndexError> {
        let swaps = self.swaps.lock().expect("metadata store lock poisoned");
        Ok(swaps
            .iter()
            .find(|row| row.txid.as_deref() == Some(txid))
            .cloned())
    }

    async fn swap_record_fill(&self, fill: &SwapFill) -> Result<(), IndexError> {
        let mut fills = self.fills.lock().expect("metadata store lock poisoned");
        if !fills.iter().any(|known| known.txid == fill.txid) {
            fills.push(fill.clone());
        }
        let mut swaps = self.swaps.lock().expect("metadata store lock poisoned");
        if let Some(row) = swaps.iter_mut().find(|row| row.id == fill.offer_id) {
            row.closed = true;
        }
        Ok(())
    }

    async fn swap_fill(&self, txid: &str) -> Result<Option<SwapFill>, IndexError> {
        let fills = self.fills.lock().expect("metadata store lock poisoned");
        Ok(fills.iter().find(|fill| fill.txid == txid).cloned())
    }

    async fn swap_release(&self, id: &str, maker_token: [u8; 32]) -> Result<bool, IndexError> {
        let mut swaps = self.swaps.lock().expect("metadata store lock poisoned");
        match swaps.iter_mut().find(|row| {
            row.id == id
                && row.maker_token == maker_token
                && row.take.is_some()
                && row.countersignature.is_none()
                && !row.closed
        }) {
            Some(row) => {
                row.take = None;
                row.taker_token = None;
                row.taken_at = None;
                Ok(true)
            }
            None => Ok(false),
        }
    }

    async fn swap_close(&self, id: &str, token: [u8; 32]) -> Result<bool, IndexError> {
        let mut swaps = self.swaps.lock().expect("metadata store lock poisoned");
        match swaps.iter_mut().find(|row| {
            row.id == id
                && !row.closed
                && (row.maker_token == token
                    || (row.taker_token == Some(token) && row.countersignature.is_some()))
        }) {
            Some(row) => {
                row.closed = true;
                Ok(true)
            }
            None => Ok(false),
        }
    }

    async fn swap_sweep(&self, now: i64) -> Result<u64, IndexError> {
        let mut swaps = self.swaps.lock().expect("metadata store lock poisoned");
        let before = swaps.len();
        swaps.retain(|row| {
            !(row.expires_at < now - 86_400 || (row.closed && row.created_at < now - 86_400))
        });
        Ok((before - swaps.len()) as u64)
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
