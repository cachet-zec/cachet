//! Postgres-backed derived-state index for Cachet.
//!
//! Design rules (ADR-001 / PRIVACY.md P4): the chain is the source of
//! truth; everything here is a reconstructible cache except three tables.
//! `asset_descriptions` is the resolution journal (the chain carries only
//! description hashes, so the preimages live here); `metadata_bundles`
//! holds the content-addressed bundles the chain commits to by hash but
//! never stores; `moderation_hidden` is operator judgment. Sync logic —
//! deciding *what* to fold from the chain — lives in `cachet-chain`; this
//! crate only stores.
//!
//! Queries use sqlx's runtime API rather than the compile-time macros: the
//! query surface is small, and skipping the offline-cache workflow keeps CI
//! database-free. Revisit when the query count grows.

pub mod metadata;

pub use metadata::{MemoryMetadataStore, MetadataStore};

use cachet_domain::{AssetEvent, AssetEventKind, AssetId, AssetSummary, TxId};
use sqlx::Row;
use sqlx::postgres::{PgPool, PgPoolOptions};

#[derive(Debug, thiserror::Error)]
pub enum IndexError {
    #[error("database error: {0}")]
    Database(#[from] sqlx::Error),
    #[error("migration error: {0}")]
    Migration(#[from] sqlx::migrate::MigrateError),
    #[error("stored value out of range: {0}")]
    OutOfRange(String),
}

/// A synced chain position: the last indexed block.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Checkpoint {
    pub tip_height: u64,
    pub tip_hash: String,
}

/// Additive per-asset delta from folding a block range.
#[derive(Debug, Clone, Copy)]
pub struct AssetDelta {
    pub asset_id: [u8; 32],
    pub issued: u64,
    pub burned: u64,
    pub finalized: bool,
    /// ZIP 227 assetDescHash, when the range contained an issuance for the
    /// asset (burn-only ranges don't carry it).
    pub asset_desc_hash: Option<[u8; 32]>,
    /// Issuance validating key (ZIP 227 canonical encoding), when the range
    /// contained an issuance for the asset.
    pub issuer_ik: Option<[u8; 33]>,
}

/// What an operator denylist entry hides: a stored metadata bundle (by
/// content hash) or an asset's journaled description text (by asset id).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ModerationKind {
    Bundle,
    Description,
    /// An issuance validating key: hides every asset minted under it.
    Issuer,
}

impl ModerationKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Bundle => "bundle",
            Self::Description => "description",
            Self::Issuer => "issuer",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "bundle" => Some(Self::Bundle),
            "description" => Some(Self::Description),
            "issuer" => Some(Self::Issuer),
            _ => None,
        }
    }
}

/// One operator denylist entry, for audit listings.
#[derive(Debug, Clone)]
pub struct HiddenEntry {
    pub kind: String,
    /// Hex of the hidden key (bundle sha256 or asset id).
    pub key: String,
    pub reason: Option<String>,
    pub hidden_at: String,
}

/// One public event row from folding a block range.
#[derive(Debug, Clone)]
pub struct EventRow {
    pub asset_id: [u8; 32],
    pub height: u64,
    /// Display byte order.
    pub txid: [u8; 32],
    pub kind: AssetEventKind,
    pub amount: u64,
}

fn kind_to_str(kind: &AssetEventKind) -> &'static str {
    match kind {
        AssetEventKind::Issuance => "issuance",
        AssetEventKind::Burn => "burn",
        AssetEventKind::Finalization => "finalization",
    }
}

pub struct AssetIndex {
    pool: PgPool,
}

impl AssetIndex {
    pub(crate) fn pool(&self) -> &PgPool {
        &self.pool
    }

    /// Connect and run migrations. Fails fast (5s) when the database is
    /// unreachable so callers can fall back to scan-only mode.
    pub async fn connect(database_url: &str) -> Result<Self, IndexError> {
        let pool = PgPoolOptions::new()
            .max_connections(5)
            .acquire_timeout(std::time::Duration::from_secs(5))
            .connect(database_url)
            .await?;
        sqlx::migrate!("./migrations").run(&pool).await?;
        Ok(Self { pool })
    }

    pub async fn checkpoint(&self) -> Result<Option<Checkpoint>, IndexError> {
        let row = sqlx::query("SELECT tip_height, tip_hash FROM index_checkpoint WHERE id = 1")
            .fetch_optional(&self.pool)
            .await?;
        row.map(|row| {
            let height: i64 = row.get("tip_height");
            let height = u64::try_from(height)
                .map_err(|_| IndexError::OutOfRange("negative tip_height".into()))?;
            Ok(Checkpoint {
                tip_height: height,
                tip_hash: row.get("tip_hash"),
            })
        })
        .transpose()
    }

    /// Drop all derived rows (chain reset detected). The description
    /// journal survives: it is keyed by asset id, which is
    /// derivation-stable across chain resets for the same issuer+description.
    pub async fn reset(&self) -> Result<(), IndexError> {
        let mut tx = self.pool.begin().await?;
        sqlx::query("DELETE FROM assets").execute(&mut *tx).await?;
        sqlx::query("DELETE FROM asset_events")
            .execute(&mut *tx)
            .await?;
        sqlx::query("DELETE FROM index_checkpoint")
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        tracing::info!("asset index reset (chain reorg or reset detected)");
        Ok(())
    }

    /// Apply the deltas and events of a freshly folded block range and
    /// advance the checkpoint, atomically.
    pub async fn apply(
        &self,
        deltas: &[AssetDelta],
        events: &[EventRow],
        checkpoint: Checkpoint,
    ) -> Result<(), IndexError> {
        let mut tx = self.pool.begin().await?;

        for delta in deltas {
            let issued = i64::try_from(delta.issued)
                .map_err(|_| IndexError::OutOfRange("issued delta exceeds i64".into()))?;
            let burned = i64::try_from(delta.burned)
                .map_err(|_| IndexError::OutOfRange("burned delta exceeds i64".into()))?;
            sqlx::query(
                "INSERT INTO assets (asset_id, issued, burned, finalized, asset_desc_hash, issuer_ik)
                 VALUES ($1, $2, $3, $4, $5, $6)
                 ON CONFLICT (asset_id) DO UPDATE SET
                     issued    = assets.issued + EXCLUDED.issued,
                     burned    = assets.burned + EXCLUDED.burned,
                     finalized = assets.finalized OR EXCLUDED.finalized,
                     asset_desc_hash = COALESCE(assets.asset_desc_hash, EXCLUDED.asset_desc_hash),
                     issuer_ik = COALESCE(assets.issuer_ik, EXCLUDED.issuer_ik)",
            )
            .bind(delta.asset_id.as_slice())
            .bind(issued)
            .bind(burned)
            .bind(delta.finalized)
            .bind(delta.asset_desc_hash.as_ref().map(|hash| hash.as_slice()))
            .bind(delta.issuer_ik.as_ref().map(|ik| ik.as_slice()))
            .execute(&mut *tx)
            .await?;
        }

        for event in events {
            let amount = i64::try_from(event.amount)
                .map_err(|_| IndexError::OutOfRange("event amount exceeds i64".into()))?;
            let height = i64::try_from(event.height)
                .map_err(|_| IndexError::OutOfRange("event height exceeds i64".into()))?;
            sqlx::query(
                "INSERT INTO asset_events (asset_id, height, txid, kind, amount)
                 VALUES ($1, $2, $3, $4, $5)",
            )
            .bind(event.asset_id.as_slice())
            .bind(height)
            .bind(event.txid.as_slice())
            .bind(kind_to_str(&event.kind))
            .bind(amount)
            .execute(&mut *tx)
            .await?;
        }

        let height = i64::try_from(checkpoint.tip_height)
            .map_err(|_| IndexError::OutOfRange("tip_height exceeds i64".into()))?;
        sqlx::query(
            "INSERT INTO index_checkpoint (id, tip_height, tip_hash) VALUES (1, $1, $2)
             ON CONFLICT (id) DO UPDATE SET
                 tip_height = EXCLUDED.tip_height,
                 tip_hash   = EXCLUDED.tip_hash",
        )
        .bind(height)
        .bind(&checkpoint.tip_hash)
        .execute(&mut *tx)
        .await?;

        tx.commit().await?;
        Ok(())
    }

    /// Public events of one asset, oldest first.
    pub async fn events(&self, asset_id: AssetId) -> Result<Vec<AssetEvent>, IndexError> {
        let rows = sqlx::query(
            "SELECT height, txid, kind, amount FROM asset_events
             WHERE asset_id = $1 ORDER BY id ASC",
        )
        .bind(asset_id.as_bytes().as_slice())
        .fetch_all(&self.pool)
        .await?;

        rows.into_iter()
            .map(|row| {
                let height: i64 = row.get("height");
                let amount: i64 = row.get("amount");
                let txid: Vec<u8> = row.get("txid");
                let txid: [u8; 32] = txid
                    .try_into()
                    .map_err(|_| IndexError::OutOfRange("txid is not 32 bytes".into()))?;
                let kind = match row.get::<String, _>("kind").as_str() {
                    "issuance" => AssetEventKind::Issuance,
                    "burn" => AssetEventKind::Burn,
                    _ => AssetEventKind::Finalization,
                };
                Ok(AssetEvent {
                    asset_id,
                    height: height.max(0) as u64,
                    txid: TxId::from_bytes(txid),
                    kind,
                    amount: amount.max(0) as u64,
                })
            })
            .collect()
    }

    /// Hide a bundle or description from THIS registry's distribution.
    /// Availability-only: the chain commitment is untouched, and the entry
    /// is auditable (reason + timestamp) and reversible.
    pub async fn hide(
        &self,
        kind: ModerationKind,
        key: &[u8],
        reason: Option<&str>,
    ) -> Result<(), IndexError> {
        sqlx::query(
            "INSERT INTO moderation_hidden (kind, key, reason) VALUES ($1, $2, $3)
             ON CONFLICT (kind, key) DO UPDATE SET reason = EXCLUDED.reason",
        )
        .bind(kind.as_str())
        .bind(key)
        .bind(reason)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Lift a moderation entry. Returns whether one existed.
    pub async fn unhide(&self, kind: ModerationKind, key: &[u8]) -> Result<bool, IndexError> {
        let result = sqlx::query("DELETE FROM moderation_hidden WHERE kind = $1 AND key = $2")
            .bind(kind.as_str())
            .bind(key)
            .execute(&self.pool)
            .await?;
        Ok(result.rows_affected() > 0)
    }

    /// Whether a moderation entry exists for this key.
    pub async fn is_hidden(&self, kind: ModerationKind, key: &[u8]) -> Result<bool, IndexError> {
        let row =
            sqlx::query("SELECT 1 AS one FROM moderation_hidden WHERE kind = $1 AND key = $2")
                .bind(kind.as_str())
                .bind(key)
                .fetch_optional(&self.pool)
                .await?;
        Ok(row.is_some())
    }

    /// Every moderation entry, newest first (audit listing).
    pub async fn list_hidden(&self) -> Result<Vec<HiddenEntry>, IndexError> {
        let rows = sqlx::query(
            "SELECT kind, key, reason, hidden_at::TEXT AS hidden_at
             FROM moderation_hidden ORDER BY hidden_at DESC",
        )
        .fetch_all(&self.pool)
        .await?;
        Ok(rows
            .into_iter()
            .map(|row| HiddenEntry {
                kind: row.get("kind"),
                key: hex::encode(row.get::<Vec<u8>, _>("key")),
                reason: row.get("reason"),
                hidden_at: row.get("hidden_at"),
            })
            .collect())
    }

    /// Every journaled description text (the issuer journal survives chain
    /// resets — PRIVACY.md P4). Callers parse these for envelope hashes to
    /// build the "referenced bundles" set for garbage collection.
    pub async fn all_description_texts(&self) -> Result<Vec<String>, IndexError> {
        let rows = sqlx::query("SELECT description FROM asset_descriptions")
            .fetch_all(&self.pool)
            .await?;
        Ok(rows.into_iter().map(|row| row.get("description")).collect())
    }

    /// Delete stored bundles that are older than `grace_secs` and not in
    /// `referenced`, and report the byte total of the orphans that remain
    /// (younger ones still inside their grace window). The grace window
    /// lets an upload-then-mint flow complete before its bundle is
    /// eligible; anything that never makes it on-chain (or into the
    /// journal) is swept. Storage therefore tracks what the chain
    /// committed to — the abuse bound for the open, accountless uploader.
    ///
    /// A deliberately dumb predicate: it sweeps exactly what the caller
    /// could not vouch for. Judging "does this sweep look too big?" here
    /// would be wrong — on a public instance the unreferenced majority is
    /// usually spam, which is precisely what must go. The caller owns the
    /// one guard that matters: never sweep against an EMPTY reference
    /// set, which would mean "delete everything".
    pub async fn purge_unreferenced_bundles(
        &self,
        referenced: &[[u8; 32]],
        grace_secs: i64,
    ) -> Result<(u64, u64), IndexError> {
        let keys: Vec<Vec<u8>> = referenced.iter().map(|hash| hash.to_vec()).collect();
        let deleted = sqlx::query(
            "DELETE FROM metadata_bundles
             WHERE NOT (sha256 = ANY($1))
               AND created_at < now() - ($2 * interval '1 second')",
        )
        .bind(&keys)
        .bind(grace_secs)
        .execute(&self.pool)
        .await?
        .rows_affected();
        let orphan_bytes: i64 = sqlx::query(
            "SELECT COALESCE(SUM(octet_length(bytes)), 0)::BIGINT AS total
             FROM metadata_bundles WHERE NOT (sha256 = ANY($1))",
        )
        .bind(&keys)
        .fetch_one(&self.pool)
        .await?
        .get("total");
        Ok((deleted, orphan_bytes.max(0) as u64))
    }

    /// The on-chain description hash (ZIP 227) of an indexed asset, when an
    /// issuance for it has been folded.
    pub async fn asset_desc_hash(&self, asset_id: AssetId) -> Result<Option<[u8; 32]>, IndexError> {
        let row = sqlx::query("SELECT asset_desc_hash FROM assets WHERE asset_id = $1")
            .bind(asset_id.as_bytes().as_slice())
            .fetch_optional(&self.pool)
            .await?;
        row.and_then(|row| row.get::<Option<Vec<u8>>, _>("asset_desc_hash"))
            .map(|bytes| {
                bytes
                    .try_into()
                    .map_err(|_| IndexError::OutOfRange("asset_desc_hash is not 32 bytes".into()))
            })
            .transpose()
    }

    /// Journal the description of an asset this instance issued.
    pub async fn record_description(
        &self,
        asset_id: AssetId,
        description: &str,
    ) -> Result<(), IndexError> {
        sqlx::query(
            "INSERT INTO asset_descriptions (asset_id, description) VALUES ($1, $2)
             ON CONFLICT (asset_id) DO NOTHING",
        )
        .bind(asset_id.as_bytes().as_slice())
        .bind(description)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Single-asset lookup from the index (same shape as one `list` row).
    pub async fn get_asset(&self, asset_id: AssetId) -> Result<Option<AssetSummary>, IndexError> {
        let row = sqlx::query(
            "SELECT a.asset_id, a.issued, a.burned, a.finalized, a.issuer_ik,
                    CASE WHEN m.key IS NULL THEN d.description END AS description
             FROM assets a
             LEFT JOIN asset_descriptions d USING (asset_id)
             LEFT JOIN moderation_hidden m
                    ON m.kind = 'description' AND m.key = a.asset_id
             WHERE a.asset_id = $1",
        )
        .bind(asset_id.as_bytes().as_slice())
        .fetch_optional(&self.pool)
        .await?;

        row.map(|row| {
            let issued: i64 = row.get("issued");
            let burned: i64 = row.get("burned");
            Ok(AssetSummary {
                asset_id,
                description: row.get("description"),
                issuer: row.get::<Option<Vec<u8>>, _>("issuer_ik").map(hex::encode),
                total_supply: (issued.max(0) as u64).saturating_sub(burned.max(0) as u64),
                finalized: row.get("finalized"),
            })
        })
        .transpose()
    }

    /// Registry listing, newest first, with journaled descriptions.
    pub async fn list(&self) -> Result<Vec<AssetSummary>, IndexError> {
        let rows = sqlx::query(
            "SELECT a.asset_id, a.issued, a.burned, a.finalized, a.issuer_ik,
                    CASE WHEN m.key IS NULL THEN d.description END AS description
             FROM assets a
             LEFT JOIN asset_descriptions d USING (asset_id)
             LEFT JOIN moderation_hidden m
                    ON m.kind = 'description' AND m.key = a.asset_id
             ORDER BY a.ord DESC",
        )
        .fetch_all(&self.pool)
        .await?;

        rows.into_iter()
            .map(|row| {
                let bytes: Vec<u8> = row.get("asset_id");
                let bytes: [u8; 32] = bytes
                    .try_into()
                    .map_err(|_| IndexError::OutOfRange("asset_id is not 32 bytes".into()))?;
                let issued: i64 = row.get("issued");
                let burned: i64 = row.get("burned");
                Ok(AssetSummary {
                    asset_id: AssetId::from_bytes(bytes),
                    description: row.get("description"),
                    issuer: row.get::<Option<Vec<u8>>, _>("issuer_ik").map(hex::encode),
                    total_supply: (issued.max(0) as u64).saturating_sub(burned.max(0) as u64),
                    finalized: row.get("finalized"),
                })
            })
            .collect()
    }

    /// Chain-level collections: assets grouped by issuance key, largest
    /// first. Burn-only assets (issuer unknown) are excluded.
    pub async fn collections(&self) -> Result<Vec<cachet_domain::CollectionSummary>, IndexError> {
        let rows = sqlx::query(
            "SELECT issuer_ik,
                    COUNT(*)                                   AS asset_count,
                    -- SUM(bigint) yields NUMERIC in Postgres; keep it i64.
                    COALESCE(SUM(issued - burned), 0)::BIGINT  AS total_supply,
                    COUNT(*) FILTER (WHERE finalized)          AS finalized_count
             FROM assets
             WHERE issuer_ik IS NOT NULL
             GROUP BY issuer_ik
             ORDER BY asset_count DESC, issuer_ik ASC",
        )
        .fetch_all(&self.pool)
        .await?;

        Ok(rows
            .into_iter()
            .map(|row| {
                let asset_count: i64 = row.get("asset_count");
                let total_supply: i64 = row.get("total_supply");
                let finalized_count: i64 = row.get("finalized_count");
                cachet_domain::CollectionSummary {
                    issuer: hex::encode(row.get::<Vec<u8>, _>("issuer_ik")),
                    asset_count: asset_count.max(0) as u64,
                    total_supply: total_supply.max(0) as u64,
                    finalized_count: finalized_count.max(0) as u64,
                }
            })
            .collect())
    }
}
