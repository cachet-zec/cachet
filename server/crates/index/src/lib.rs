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

use cachet_domain::{
    AssetEvent, AssetEventKind, AssetId, AssetListPage, AssetListQuery, AssetSummary, ListingOrder,
    SupplyState, TxId,
};
use sqlx::postgres::{PgPool, PgPoolOptions, PgRow};
use sqlx::{Postgres, QueryBuilder, Row};

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

/// What a listing searches and orders by, derived from a description by the
/// domain's naming rules: the lowercased display name and description on
/// two lines, and the rank of the name's attestation.
fn derived_names(description: &str) -> (String, i16) {
    let (name, _) = cachet_domain::display_name_for(description);
    (
        format!("{}\n{}", name.to_lowercase(), description.to_lowercase()),
        cachet_domain::name_rank(Some(description)),
    )
}

/// A listing row: the asset, its journaled description unless the operator
/// withholds it.
const LISTING_FROM: &str = "
             FROM assets a
             LEFT JOIN asset_descriptions d USING (asset_id)
             LEFT JOIN moderation_hidden m
                    ON m.kind = 'description' AND m.key = a.asset_id";

/// Journal rows whose asset is not on the indexed chain, and that the
/// operator does not withhold, by description or by issuer (the journal
/// keeps the issuance key for exactly this: `assets` is empty after a
/// reset). A constant: no caller text.
const KEPT_FROM: &str = "
             FROM asset_descriptions d
             WHERE NOT EXISTS (SELECT 1 FROM assets a WHERE a.asset_id = d.asset_id)
               AND NOT EXISTS (SELECT 1 FROM moderation_hidden m
                               WHERE (m.kind = 'description' AND m.key = d.asset_id)
                                  OR (m.kind = 'issuer' AND m.key = d.issuer_ik))";

/// The row's description is known to a caller.
const DESCRIPTION_KNOWN: &str = "(d.description IS NOT NULL AND m.key IS NULL)";

/// A count or offset as the database takes it. Anything past `i64` is past
/// every registry.
fn bounded(value: usize) -> i64 {
    i64::try_from(value.min(cachet_domain::listing::MAX_OFFSET)).unwrap_or(i64::MAX)
}

/// `WHERE`: the operator's scope, which also bounds the registry count.
fn push_operator_scope<'a>(sql: &mut QueryBuilder<'a, Postgres>, query: &'a AssetListQuery) {
    sql.push(" WHERE TRUE");
    if !query.hidden_issuers.is_empty() {
        sql.push(" AND (a.issuer_ik IS NULL OR a.issuer_ik <> ALL(");
        sql.push_bind(&query.hidden_issuers);
        sql.push("))");
    }
}

/// The caller's own filters, each one `AND`ed onto what precedes.
fn push_caller_filters<'a>(sql: &mut QueryBuilder<'a, Postgres>, query: &'a AssetListQuery) {
    if query.resolved_only {
        sql.push(" AND ");
        sql.push(DESCRIPTION_KNOWN);
    }
    if let Some(issuer) = &query.issuer {
        sql.push(" AND a.issuer_ik = ");
        sql.push_bind(issuer);
    }
    if let Some(supply) = query.supply {
        sql.push(" AND a.finalized = ");
        sql.push_bind(supply == SupplyState::Sealed);
    }
    if let Some(needle) = &query.search {
        // Each of the three tests is one an index can answer: a trigram
        // index for "contains", the primary key and the issuer index for
        // "starts with". What the caller typed is data all the way: it is
        // escaped before it becomes a LIKE pattern, and bound.
        sql.push(" AND ((");
        sql.push(DESCRIPTION_KNOWN);
        sql.push(" AND d.search_text LIKE ");
        sql.push_bind(contains_pattern(needle));
        sql.push(" ESCAPE '\\')");
        for (column, width) in [("a.asset_id", 32), ("a.issuer_ik", 33)] {
            if let Some((low, high)) = hex_prefix_range(needle, width) {
                sql.push(" OR ");
                sql.push(column);
                sql.push(" BETWEEN ");
                sql.push_bind(low);
                sql.push(" AND ");
                sql.push_bind(high);
            }
        }
        sql.push(")");
    }
}

/// `%needle%` with the needle's own `%`, `_` and `\` made literal.
fn contains_pattern(needle: &str) -> String {
    let mut pattern = String::with_capacity(needle.len() + 2);
    pattern.push('%');
    for character in needle.chars() {
        if matches!(character, '%' | '_' | '\\') {
            pattern.push('\\');
        }
        pattern.push(character);
    }
    pattern.push('%');
    pattern
}

/// Every `width`-byte value whose lowercase hex starts with `needle`, as an
/// inclusive range: the needle padded with `0`s, and with `f`s. `None` when
/// the needle is not hex or is longer than the value.
fn hex_prefix_range(needle: &str, width: usize) -> Option<(Vec<u8>, Vec<u8>)> {
    let digits = width * 2;
    if needle.is_empty()
        || needle.len() > digits
        || !needle
            .bytes()
            .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
    {
        return None;
    }
    let padded = |with: char| {
        let mut text = needle.to_owned();
        text.extend(std::iter::repeat_n(with, digits - needle.len()));
        hex::decode(text).ok()
    };
    Some((padded('0')?, padded('f')?))
}

/// `assets.name_rank` as the journal and the operator's list make it: the
/// journaled rank when the description is known to a caller, 2 otherwise.
/// Only rows that differ are written.
const RECONCILE_NAME_RANKS: &str = "
    UPDATE assets a SET name_rank = r.rank
      FROM (SELECT a2.asset_id,
                   CASE WHEN d.description IS NOT NULL AND m.key IS NULL
                        THEN COALESCE(d.name_rank, 1) ELSE 2 END AS rank
              FROM assets a2
              LEFT JOIN asset_descriptions d USING (asset_id)
              LEFT JOIN moderation_hidden m
                     ON m.kind = 'description' AND m.key = a2.asset_id) r
     WHERE r.asset_id = a.asset_id AND a.name_rank IS DISTINCT FROM r.rank";

fn summary_from_row(row: &PgRow) -> Result<AssetSummary, IndexError> {
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
}

pub struct AssetIndex {
    pool: PgPool,
    /// The three counts of a listing, per set of filters, for a few
    /// seconds. They cost a pass over the whole table, a page costs an
    /// index walk, and a registry is polled far more often than it changes:
    /// without this every poll of every open page paid for the pass, even
    /// the ones answered `304`. Emptied by every write this index makes.
    counts: std::sync::Mutex<std::collections::HashMap<CountsKey, (std::time::Instant, Counts)>>,
}

/// What the counts depend on: the operator's scope and the caller's filters,
/// not the order or the page.
type CountsKey = (
    Vec<Vec<u8>>,
    bool,
    Option<Vec<u8>>,
    Option<bool>,
    Option<String>,
);
/// Registry, total, unresolved.
type Counts = (usize, usize, usize);

/// How long counts stand. The console polls every fifteen seconds.
const COUNTS_FRESH_FOR: std::time::Duration = std::time::Duration::from_secs(3);
/// Search text is caller-chosen, so the keys are too: past this many the
/// cache is emptied rather than grown.
const COUNTS_CACHE_MAX: usize = 512;

fn counts_key(query: &AssetListQuery) -> CountsKey {
    (
        query.hidden_issuers.clone(),
        query.resolved_only,
        query.issuer.clone(),
        query.supply.map(|supply| supply == SupplyState::Sealed),
        query.search.clone(),
    )
}

impl AssetIndex {
    pub(crate) fn pool(&self) -> &PgPool {
        &self.pool
    }

    /// Connect and run migrations. Fails fast (5s) when the database is
    /// unreachable so callers can fall back to scan-only mode.
    pub async fn connect(database_url: &str) -> Result<Self, IndexError> {
        let pool = PgPoolOptions::new()
            // Postgres allows a hundred; five made a burst of page
            // requests queue behind each other for a connection.
            .max_connections(12)
            .acquire_timeout(std::time::Duration::from_secs(5))
            .connect(database_url)
            .await?;
        sqlx::migrate!("./migrations").run(&pool).await?;
        let index = Self {
            pool,
            counts: Default::default(),
        };
        index.refresh_derived_names().await?;
        Ok(index)
    }

    /// Bring `search_text` and `name_rank` in line with the naming rules
    /// this build runs: rows written before the columns existed, or under
    /// an older rule, are recomputed. Rows already right are left alone.
    async fn refresh_derived_names(&self) -> Result<(), IndexError> {
        // Read and written in bounded batches, by key: the journal can
        // outgrow memory, and one batch is one short transaction.
        const BATCH: i64 = 2_000;
        let mut recomputed = 0usize;
        let mut after: Vec<u8> = Vec::new();
        loop {
            let rows = sqlx::query(
                "SELECT asset_id, description, search_text, name_rank
                 FROM asset_descriptions WHERE asset_id > $1
                 ORDER BY asset_id LIMIT $2",
            )
            .bind(after.as_slice())
            .bind(BATCH)
            .fetch_all(&self.pool)
            .await?;
            let Some(last) = rows.last() else { break };
            after = last.get("asset_id");

            let mut stale = Vec::new();
            for row in &rows {
                let description: String = row.get("description");
                let (search_text, name_rank) = derived_names(&description);
                let stored_text: Option<String> = row.get("search_text");
                let stored_rank: Option<i16> = row.get("name_rank");
                if stored_text.as_deref() != Some(search_text.as_str())
                    || stored_rank != Some(name_rank)
                {
                    stale.push((row.get::<Vec<u8>, _>("asset_id"), search_text, name_rank));
                }
            }
            if stale.is_empty() {
                continue;
            }
            let mut tx = self.pool.begin().await?;
            for (asset_id, search_text, name_rank) in &stale {
                sqlx::query(
                    "UPDATE asset_descriptions SET search_text = $2, name_rank = $3
                     WHERE asset_id = $1",
                )
                .bind(asset_id.as_slice())
                .bind(search_text)
                .bind(name_rank)
                .execute(&mut *tx)
                .await?;
            }
            tx.commit().await?;
            recomputed += stale.len();
        }
        if recomputed > 0 {
            tracing::info!(rows = recomputed, "listing names recomputed");
        }
        // The rank kept on each asset follows from the above and from the
        // operator's list: brought in line, whatever wrote them last.
        let ranked = sqlx::query(RECONCILE_NAME_RANKS)
            .execute(&self.pool)
            .await?
            .rows_affected();
        if ranked > 0 {
            tracing::info!(rows = ranked, "listing ranks reconciled");
        }
        Ok(())
    }

    /// Bring `assets.name_rank` in line for these assets.
    async fn reconcile_name_ranks<'e>(
        executor: impl sqlx::PgExecutor<'e>,
        asset_ids: &[&[u8]],
    ) -> Result<(), IndexError> {
        let mut sql = QueryBuilder::<Postgres>::new(RECONCILE_NAME_RANKS);
        sql.push(" AND a.asset_id = ANY(");
        sql.push_bind(asset_ids);
        sql.push(")");
        sql.build().execute(executor).await?;
        Ok(())
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
    fn forget_counts(&self) {
        self.counts
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clear();
    }

    pub async fn reset(&self) -> Result<(), IndexError> {
        self.forget_counts();
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
        self.apply_inner(false, deltas, events, checkpoint).await
    }

    /// The chain was reset or reorganised past the checkpoint: what was
    /// folded from the new chain REPLACES the derived rows, in one
    /// transaction. Until it commits, readers keep seeing the last complete
    /// picture this registry had, never an index emptied and half refilled
    /// (which would, for one, list every journaled asset as lost). The
    /// description journal survives, as with `reset`.
    pub async fn replace(
        &self,
        deltas: &[AssetDelta],
        events: &[EventRow],
        checkpoint: Checkpoint,
    ) -> Result<(), IndexError> {
        self.apply_inner(true, deltas, events, checkpoint).await?;
        tracing::info!("asset index replaced (chain reorg or reset detected)");
        Ok(())
    }

    async fn apply_inner(
        &self,
        replacing: bool,
        deltas: &[AssetDelta],
        events: &[EventRow],
        checkpoint: Checkpoint,
    ) -> Result<(), IndexError> {
        self.forget_counts();
        let mut tx = self.pool.begin().await?;
        // The index is a projection of the chain, and the checkpoint travels
        // in this same transaction: a commit lost to a crash is refolded
        // from the previous checkpoint at the next sync. So this commit
        // need not wait for the disk to confirm it, which on a busy disk is
        // the difference between milliseconds and seconds per block.
        // Bundles and moderation keep the default: they are not on chain.
        sqlx::query("SET LOCAL synchronous_commit = off")
            .execute(&mut *tx)
            .await?;
        if replacing {
            sqlx::query("DELETE FROM assets").execute(&mut *tx).await?;
            sqlx::query("DELETE FROM asset_events")
                .execute(&mut *tx)
                .await?;
            sqlx::query("DELETE FROM index_checkpoint")
                .execute(&mut *tx)
                .await?;
        }

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

        // An asset that (re)appears may already have a journaled description
        // (minted again after a reset): its rank follows at once.
        let touched: Vec<&[u8]> = deltas
            .iter()
            .map(|delta| delta.asset_id.as_slice())
            .collect();
        if !touched.is_empty() {
            Self::reconcile_name_ranks(&mut *tx, &touched).await?;
        }

        // The journal keeps the issuance key beside the description, so
        // issuer-level moderation still holds once `assets` is emptied.
        let issued: Vec<&[u8]> = deltas
            .iter()
            .filter(|delta| delta.issuer_ik.is_some())
            .map(|delta| delta.asset_id.as_slice())
            .collect();
        if !issued.is_empty() {
            sqlx::query(
                "UPDATE asset_descriptions d SET issuer_ik = a.issuer_ik
                   FROM assets a
                  WHERE a.asset_id = d.asset_id AND d.asset_id = ANY($1)
                    AND a.issuer_ik IS NOT NULL
                    AND d.issuer_ik IS DISTINCT FROM a.issuer_ik",
            )
            .bind(&issued)
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
        self.forget_counts();
        sqlx::query(
            "INSERT INTO moderation_hidden (kind, key, reason) VALUES ($1, $2, $3)
             ON CONFLICT (kind, key) DO UPDATE SET reason = EXCLUDED.reason",
        )
        .bind(kind.as_str())
        .bind(key)
        .bind(reason)
        .execute(&self.pool)
        .await?;
        if matches!(kind, ModerationKind::Description) {
            Self::reconcile_name_ranks(&self.pool, &[key]).await?;
        }
        Ok(())
    }

    /// Lift a moderation entry. Returns whether one existed.
    pub async fn unhide(&self, kind: ModerationKind, key: &[u8]) -> Result<bool, IndexError> {
        self.forget_counts();
        let result = sqlx::query("DELETE FROM moderation_hidden WHERE kind = $1 AND key = $2")
            .bind(kind.as_str())
            .bind(key)
            .execute(&self.pool)
            .await?;
        if matches!(kind, ModerationKind::Description) {
            Self::reconcile_name_ranks(&self.pool, &[key]).await?;
        }
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
        self.forget_counts();
        let (search_text, name_rank) = derived_names(description);
        sqlx::query(
            "INSERT INTO asset_descriptions
                    (asset_id, description, search_text, name_rank, issuer_ik)
             VALUES ($1, $2, $3, $4, (SELECT issuer_ik FROM assets WHERE asset_id = $1))
             ON CONFLICT (asset_id) DO NOTHING",
        )
        .bind(asset_id.as_bytes().as_slice())
        .bind(description)
        .bind(search_text)
        .bind(name_rank)
        .execute(&self.pool)
        .await?;
        Self::reconcile_name_ranks(&self.pool, &[asset_id.as_bytes().as_slice()]).await?;
        Ok(())
    }

    /// Descriptions the journal keeps for assets the chain no longer
    /// carries (a test network that was reset takes its assets with it;
    /// the journal is keyed by asset id and survives). Withheld
    /// descriptions are left out. Returns the page and the total.
    pub async fn kept_off_chain(
        &self,
        limit: usize,
        offset: usize,
    ) -> Result<(Vec<(AssetId, String)>, usize), IndexError> {
        let mut count = QueryBuilder::<Postgres>::new("SELECT COUNT(*) AS total");
        count.push(KEPT_FROM);
        let total: i64 = count.build().fetch_one(&self.pool).await?.get("total");

        let mut page = QueryBuilder::<Postgres>::new("SELECT d.asset_id, d.description");
        page.push(KEPT_FROM);
        page.push(" ORDER BY d.name_rank ASC NULLS LAST, d.asset_id ASC OFFSET ");
        page.push_bind(bounded(offset));
        page.push(" LIMIT ");
        page.push_bind(bounded(limit));
        let rows = page.build().fetch_all(&self.pool).await?;
        let page = rows
            .iter()
            .map(|row| {
                let bytes: Vec<u8> = row.get("asset_id");
                let bytes: [u8; 32] = bytes
                    .try_into()
                    .map_err(|_| IndexError::OutOfRange("asset_id is not 32 bytes".into()))?;
                Ok((AssetId::from_bytes(bytes), row.get("description")))
            })
            .collect::<Result<_, IndexError>>()?;
        Ok((page, usize::try_from(total).unwrap_or(0)))
    }

    /// The kept description of one asset the chain no longer carries.
    /// `None` when the asset is on chain, unknown, or withheld.
    pub async fn kept_description(&self, asset_id: AssetId) -> Result<Option<String>, IndexError> {
        let mut one = QueryBuilder::<Postgres>::new("SELECT d.description");
        one.push(KEPT_FROM);
        one.push(" AND d.asset_id = ");
        one.push_bind(asset_id.as_bytes().as_slice());
        let row = one.build().fetch_optional(&self.pool).await?;
        Ok(row.map(|row| row.get("description")))
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

        rows.iter().map(summary_from_row).collect()
    }

    /// One page of the listing, with the counts a pager needs: what
    /// `AssetListQuery::apply` returns from the whole listing, answered by
    /// the database instead of read out of it.
    ///
    /// Every value a caller supplied reaches the database as a bound
    /// parameter. The only text assembled here is made of the constants
    /// below, chosen by matching on enums.
    pub async fn list_page(&self, query: &AssetListQuery) -> Result<AssetListPage, IndexError> {
        let key = counts_key(query);
        let remembered = self
            .counts
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(&key)
            .filter(|(at, _)| at.elapsed() < COUNTS_FRESH_FOR)
            .map(|(_, counts)| *counts);

        // Counted afresh, both statements must see the same registry.
        let mut tx = self.pool.begin().await?;
        let (registry_count, total_count, unresolved_count) = match remembered {
            Some(counts) => counts,
            None => {
                sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY")
                    .execute(&mut *tx)
                    .await?;
                let mut counts = QueryBuilder::<Postgres>::new(
                    "SELECT COUNT(*) AS registry, COUNT(*) FILTER (WHERE TRUE",
                );
                push_caller_filters(&mut counts, query);
                counts.push(") AS total, COUNT(*) FILTER (WHERE NOT ");
                counts.push(DESCRIPTION_KNOWN);
                push_caller_filters(&mut counts, query);
                counts.push(") AS unresolved");
                counts.push(LISTING_FROM);
                push_operator_scope(&mut counts, query);
                let row = counts.build().fetch_one(&mut *tx).await?;
                let count = |name: &str| -> Result<usize, IndexError> {
                    usize::try_from(row.get::<i64, _>(name))
                        .map_err(|_| IndexError::OutOfRange(format!("{name} count is negative")))
                };
                let counted = (count("registry")?, count("total")?, count("unresolved")?);
                let mut cache = self
                    .counts
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                if cache.len() >= COUNTS_CACHE_MAX {
                    cache.clear();
                }
                cache.insert(key, (std::time::Instant::now(), counted));
                counted
            }
        };

        let mut page = QueryBuilder::<Postgres>::new(
            "SELECT a.asset_id, a.issued, a.burned, a.finalized, a.issuer_ik,
                    CASE WHEN m.key IS NULL THEN d.description END AS description",
        );
        page.push(LISTING_FROM);
        push_operator_scope(&mut page, query);
        push_caller_filters(&mut page, query);
        page.push(match query.order {
            ListingOrder::Newest => " ORDER BY a.ord DESC",
            ListingOrder::NamedFirst => " ORDER BY a.name_rank ASC, a.ord DESC",
        });
        page.push(" OFFSET ");
        page.push_bind(bounded(query.offset));
        if let Some(limit) = query.limit {
            page.push(" LIMIT ");
            page.push_bind(bounded(limit));
        }
        let rows = page.build().fetch_all(&mut *tx).await?;
        tx.commit().await?;

        Ok(AssetListPage {
            items: rows
                .iter()
                .map(summary_from_row)
                .collect::<Result<_, _>>()?,
            registry_count,
            total_count,
            unresolved_count,
        })
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

#[cfg(test)]
mod search_tests {
    use super::*;

    #[test]
    fn what_was_typed_is_never_a_pattern() {
        assert_eq!(contains_pattern("harbor"), "%harbor%");
        assert_eq!(contains_pattern(r"100%_a\b"), r"%100\%\_a\\b%");
    }

    #[test]
    fn a_hex_prefix_is_a_range_of_keys() {
        let (low, high) = hex_prefix_range("0a", 32).unwrap();
        assert_eq!((low[0], low[1], low.len()), (0x0a, 0x00, 32));
        assert_eq!((high[0], high[1]), (0x0a, 0xff));
        // An odd number of digits: the last nibble spans 0 to f.
        let (low, high) = hex_prefix_range("0a5", 33).unwrap();
        assert_eq!((low[1], high[1], low.len()), (0x50, 0x5f, 33));
        // A whole key is a range of one.
        let whole = "ab".repeat(32);
        let (low, high) = hex_prefix_range(&whole, 32).unwrap();
        assert_eq!(low, high);
        // Not hex, empty, or longer than a key: no identifier can match.
        assert!(hex_prefix_range("harbor", 32).is_none());
        assert!(hex_prefix_range("", 32).is_none());
        assert!(hex_prefix_range(&"a".repeat(65), 32).is_none());
        assert!(hex_prefix_range(&"a".repeat(65), 33).is_some());
    }
}
