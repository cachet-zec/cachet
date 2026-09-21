//! What a caller may ask of the asset listing, and the reference answer.
//!
//! `AssetListQuery::apply` is the definition: it works on a whole listing
//! held in memory, and is what the in-memory backend and the scan-only mode
//! run. An index that answers the same question in SQL must return exactly
//! what `apply` returns, and is tested against it.

use crate::{AssetSummary, NameSource, display_name_for};

/// Longest search text kept, in characters. A search box has no use for
/// more, and the text is compared against every row.
pub const MAX_SEARCH_CHARS: usize = 120;

/// Largest page a caller can skip to. Far past any registry, small enough
/// to stay a plain signed 64-bit number everywhere.
pub const MAX_OFFSET: usize = 1 << 40;

/// Which supply states a listing keeps.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SupplyState {
    /// Finalized: no further units, ever.
    Sealed,
    /// The issuer can still mint more.
    Open,
}

/// How a listing is ordered.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ListingOrder {
    /// As the chain recorded them, newest first.
    #[default]
    Newest,
    /// Names sealed into the asset id, then free-text labels, then assets
    /// without a resolved description; newest first inside each group.
    NamedFirst,
}

/// A caller's view of the listing. None of it is moderation, except
/// `hidden_issuers`, which is the operator's and is applied first.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AssetListQuery {
    /// Issuance keys the operator withholds from listings (raw bytes).
    pub hidden_issuers: Vec<Vec<u8>>,
    /// Keep only assets whose description is known.
    pub resolved_only: bool,
    /// Keep only assets minted under this issuance key (raw bytes).
    pub issuer: Option<Vec<u8>>,
    pub supply: Option<SupplyState>,
    /// Text to look for. Build it with [`AssetListQuery::search_text`].
    pub search: Option<String>,
    pub order: ListingOrder,
    pub offset: usize,
    /// `None`: everything after `offset`.
    pub limit: Option<usize>,
}

/// One page, and what a pager needs to know about the rest.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AssetListPage {
    pub items: Vec<AssetSummary>,
    /// Assets listed at all (hidden issuers excluded), before the caller's
    /// filters.
    pub registry_count: usize,
    /// Assets matching the caller's filters, before the page is cut.
    pub total_count: usize,
    /// Among those, the ones without a resolved description.
    pub unresolved_count: usize,
}

/// 0: name sealed into the asset id. 1: free-text label. 2: no description.
pub fn name_rank(description: Option<&str>) -> i16 {
    match description.map(display_name_for) {
        Some((_, NameSource::Envelope)) => 0,
        Some((_, NameSource::FreeText)) => 1,
        None => 2,
    }
}

impl AssetListQuery {
    /// Normalize what a caller typed: trimmed, lowercased, control
    /// characters dropped, bounded. `None` when nothing is left.
    ///
    /// The result is only ever compared with stored text, as a bound
    /// value; it is cleaned because it is attacker-chosen and a database
    /// refuses some characters (NUL) outright.
    pub fn search_text(typed: &str) -> Option<String> {
        let clean: String = typed
            .trim()
            .chars()
            .filter(|c| !c.is_control())
            .take(MAX_SEARCH_CHARS)
            .collect::<String>()
            .to_lowercase();
        (!clean.is_empty()).then_some(clean)
    }

    /// Whether the caller's own filters keep this asset.
    fn keeps(&self, asset: &AssetSummary) -> bool {
        if self.resolved_only && asset.description.is_none() {
            return false;
        }
        if let Some(issuer) = &self.issuer {
            if asset.issuer.as_deref() != Some(hex::encode(issuer).as_str()) {
                return false;
            }
        }
        if let Some(supply) = self.supply {
            if asset.finalized != (supply == SupplyState::Sealed) {
                return false;
            }
        }
        let Some(needle) = self.search.as_deref() else {
            return true;
        };
        let description = asset.description.as_deref();
        description.is_some_and(|text| text.to_lowercase().contains(needle))
            || description
                .is_some_and(|text| display_name_for(text).0.to_lowercase().contains(needle))
            || asset.asset_id.to_string().starts_with(needle)
            || asset
                .issuer
                .as_deref()
                .is_some_and(|issuer| issuer.starts_with(needle))
    }

    /// The reference answer, from a whole listing in chain order (newest
    /// first).
    pub fn apply(&self, mut assets: Vec<AssetSummary>) -> AssetListPage {
        if !self.hidden_issuers.is_empty() {
            let hidden: std::collections::HashSet<String> =
                self.hidden_issuers.iter().map(hex::encode).collect();
            assets.retain(|asset| {
                asset
                    .issuer
                    .as_deref()
                    .is_none_or(|issuer| !hidden.contains(issuer))
            });
        }
        let registry_count = assets.len();

        assets.retain(|asset| self.keeps(asset));
        if self.order == ListingOrder::NamedFirst {
            // Stable: chain order survives inside each group.
            assets.sort_by_key(|asset| name_rank(asset.description.as_deref()));
        }
        let total_count = assets.len();
        let unresolved_count = assets
            .iter()
            .filter(|asset| asset.description.is_none())
            .count();

        assets.drain(..self.offset.min(assets.len()));
        if let Some(limit) = self.limit {
            assets.truncate(limit);
        }
        AssetListPage {
            items: assets,
            registry_count,
            total_count,
            unresolved_count,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{AssetId, ChainDescription};

    fn asset(byte: u8, description: Option<&str>, issuer: u8, finalized: bool) -> AssetSummary {
        AssetSummary {
            asset_id: AssetId::from_bytes([byte; 32]),
            description: description.map(str::to_owned),
            issuer: Some(hex::encode([issuer; 33])),
            total_supply: 1,
            finalized,
        }
    }

    fn registry() -> Vec<AssetSummary> {
        let sealed_name = ChainDescription::compose("Zcon Ticket", &"ab".repeat(32)).unwrap();
        vec![
            asset(5, None, 1, false),
            asset(4, Some("Harbor Pass"), 1, true),
            asset(3, Some(&sealed_name), 2, false),
            asset(2, None, 2, true),
            asset(1, Some("harbor dues"), 9, false),
        ]
    }

    fn ids(page: &AssetListPage) -> Vec<u8> {
        page.items
            .iter()
            .map(|asset| asset.asset_id.as_bytes()[0])
            .collect()
    }

    #[test]
    fn no_parameters_is_the_whole_listing() {
        let page = AssetListQuery::default().apply(registry());
        assert_eq!(ids(&page), [5, 4, 3, 2, 1]);
        assert_eq!(
            (page.registry_count, page.total_count, page.unresolved_count),
            (5, 5, 2)
        );
    }

    #[test]
    fn a_hidden_issuer_leaves_the_registry_count_too() {
        let query = AssetListQuery {
            hidden_issuers: vec![vec![9; 33]],
            ..Default::default()
        };
        let page = query.apply(registry());
        assert_eq!(ids(&page), [5, 4, 3, 2]);
        assert_eq!(page.registry_count, 4);
    }

    #[test]
    fn named_first_keeps_chain_order_inside_each_group() {
        let query = AssetListQuery {
            order: ListingOrder::NamedFirst,
            ..Default::default()
        };
        assert_eq!(ids(&query.apply(registry())), [3, 4, 1, 5, 2]);
    }

    #[test]
    fn search_reads_names_descriptions_and_id_prefixes() {
        let query = |typed: &str| AssetListQuery {
            search: AssetListQuery::search_text(typed),
            ..Default::default()
        };
        assert_eq!(ids(&query("  HARBOR ").apply(registry())), [4, 1]);
        assert_eq!(ids(&query("zcon").apply(registry())), [3]);
        assert_eq!(ids(&query("0505").apply(registry())), [5]);
        // An issuer key prefix: the two assets of key 02.
        assert_eq!(ids(&query("020202").apply(registry())), [3, 2]);
        // Filters narrow the total, never the registry count.
        let page = query("harbor").apply(registry());
        assert_eq!((page.registry_count, page.total_count), (5, 2));
    }

    #[test]
    fn a_page_is_cut_after_the_filters() {
        let query = AssetListQuery {
            supply: Some(SupplyState::Open),
            offset: 1,
            limit: Some(1),
            ..Default::default()
        };
        let page = query.apply(registry());
        assert_eq!(ids(&page), [3]);
        assert_eq!(page.total_count, 3);

        let past = AssetListQuery {
            offset: 40,
            ..Default::default()
        };
        assert!(past.apply(registry()).items.is_empty());
    }

    #[test]
    fn search_text_is_cleaned_and_bounded() {
        assert_eq!(AssetListQuery::search_text("  \u{0}\n "), None);
        assert_eq!(
            AssetListQuery::search_text("a\u{0}b%_'"),
            Some("ab%_'".into())
        );
        let long = "x".repeat(500);
        assert_eq!(
            AssetListQuery::search_text(&long).unwrap().chars().count(),
            MAX_SEARCH_CHARS
        );
    }
}
