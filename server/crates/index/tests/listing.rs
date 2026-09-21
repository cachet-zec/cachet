//! The database's answer to a listing question must be the reference
//! answer (`AssetListQuery::apply` over the whole listing), whatever the
//! caller typed.
//!
//! Needs a Postgres it may create and drop a scratch database in:
//!
//! ```text
//! CACHET_TEST_DATABASE_URL=postgres://user:pass@localhost:5432/postgres \
//!   cargo test -p cachet-index --test listing -- --ignored
//! ```

use cachet_domain::{AssetListQuery, ChainDescription, ListingOrder, SupplyState};
use cachet_index::{AssetDelta, AssetIndex, Checkpoint, ModerationKind};
use sqlx::postgres::PgPoolOptions;
use sqlx::{Connection, PgConnection, Row};

const ISSUERS: [u8; 3] = [0x02, 0x0a, 0xf1];

/// Text an attacker, or an ordinary person, might seal or type.
const HOSTILE: [&str; 9] = [
    "%",
    "_",
    "'",
    "\\",
    "'; DROP TABLE assets; --",
    "\" OR \"\"=\"",
    "$1",
    "harbor' OR '1'='1",
    "\u{e9}dition",
];

fn descriptions() -> Vec<Option<String>> {
    let sealed = |name: &str| Some(ChainDescription::compose(name, &"ab".repeat(32)).unwrap());
    let mut all = vec![
        None,
        Some("Harbor Pass".to_owned()),
        Some("harbor dues 100%".to_owned()),
        Some("under_score".to_owned()),
        Some("\u{c9}dition Sp\u{e9}ciale".to_owned()),
        Some(r#"{"name":"Foreign Harbor","standard":"SAMPLE-1"}"#.to_owned()),
        sealed("Zcon Ticket"),
        sealed("Harbor Master"),
        None,
    ];
    all.extend(
        HOSTILE
            .iter()
            .map(|text| Some(format!("Robert {text} Tables"))),
    );
    all
}

struct Scratch {
    admin_url: String,
    name: String,
    url: String,
}

impl Scratch {
    async fn create() -> Option<Self> {
        let admin_url = std::env::var("CACHET_TEST_DATABASE_URL").ok()?;
        // A database name cannot be a bound parameter. This one is built
        // here from digits only; nothing a caller supplies reaches it.
        let name = format!(
            "cachet_listing_{}_{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let mut admin = PgConnection::connect(&admin_url)
            .await
            .expect("admin connect");
        sqlx::query(&format!("CREATE DATABASE {name}"))
            .execute(&mut admin)
            .await
            .expect("create scratch database");
        let (base, _) = admin_url.rsplit_once('/').expect("url names a database");
        Some(Self {
            url: format!("{base}/{name}"),
            admin_url,
            name,
        })
    }

    async fn drop(self) {
        let mut admin = PgConnection::connect(&self.admin_url)
            .await
            .expect("admin connect");
        sqlx::query(&format!("DROP DATABASE {} WITH (FORCE)", self.name))
            .execute(&mut admin)
            .await
            .expect("drop scratch database");
    }
}

async fn fill(index: &AssetIndex) {
    let deltas: Vec<AssetDelta> = descriptions()
        .iter()
        .enumerate()
        .map(|(position, _)| {
            let mut asset_id = [0u8; 32];
            asset_id[0] = position as u8;
            asset_id[1] = 0x5a;
            AssetDelta {
                asset_id,
                issued: 10 + position as u64,
                burned: 0,
                finalized: position % 3 == 0,
                asset_desc_hash: None,
                // Every fifth asset is a burn-only sighting: no issuer.
                issuer_ik: (position % 5 != 4).then(|| [ISSUERS[position % 3]; 33]),
            }
        })
        .collect();
    // One asset per block range, so `ord` follows the position.
    for (height, delta) in deltas.iter().enumerate() {
        index
            .apply(
                std::slice::from_ref(delta),
                &[],
                Checkpoint {
                    tip_height: height as u64 + 1,
                    tip_hash: format!("{height:064x}"),
                },
            )
            .await
            .expect("apply");
    }
    for (delta, description) in deltas.iter().zip(descriptions()) {
        if let Some(description) = description {
            index
                .record_description(
                    cachet_domain::AssetId::from_bytes(delta.asset_id),
                    &description,
                )
                .await
                .expect("record description");
        }
    }
    // The operator withholds one description: that asset lists as unnamed.
    index
        .hide(
            ModerationKind::Description,
            &deltas[1].asset_id,
            Some("test"),
        )
        .await
        .expect("hide");
}

fn questions() -> Vec<AssetListQuery> {
    let mut searches: Vec<Option<String>> = vec![None];
    for typed in [
        "harbor",
        "HARBOR ",
        "zcon",
        "foreign",
        "sample-1",
        "00",
        "0a0a",
        "5a",
        "zz",
        // identifier prefixes: odd length, an issuer key, a whole id, too long
        "0",
        "05",
        "055",
        "f1f1f",
        "0a0a0a0a0",
        "ha",
        "h",
    ]
    .iter()
    .chain(HOSTILE.iter())
    {
        searches.push(AssetListQuery::search_text(typed));
    }
    let mut all = Vec::new();
    for search in &searches {
        for resolved_only in [false, true] {
            for issuer in [None, Some(vec![ISSUERS[1]; 33]), Some(vec![0x77; 33])] {
                for supply in [None, Some(SupplyState::Sealed), Some(SupplyState::Open)] {
                    for order in [ListingOrder::Newest, ListingOrder::NamedFirst] {
                        for (offset, limit) in [
                            (0, None),
                            (0, Some(5)),
                            (3, Some(4)),
                            (100, Some(5)),
                            (0, Some(0)),
                        ] {
                            for hidden_issuers in [vec![], vec![vec![ISSUERS[2]; 33]]] {
                                all.push(AssetListQuery {
                                    hidden_issuers,
                                    resolved_only,
                                    issuer: issuer.clone(),
                                    supply,
                                    search: search.clone(),
                                    order,
                                    offset,
                                    limit,
                                });
                            }
                        }
                    }
                }
            }
        }
    }
    all
}

async fn assert_database_agrees_with_the_reference(index: &AssetIndex) {
    let whole = index.list().await.expect("list");
    assert_eq!(whole.len(), descriptions().len());
    for question in questions() {
        let answered = index.list_page(&question).await.expect("list_page");
        assert_eq!(answered, question.apply(whole.clone()), "{question:?}");
    }
}

#[tokio::test]
#[ignore = "requires Postgres (CACHET_TEST_DATABASE_URL)"]
async fn the_database_answers_what_the_reference_answers() {
    let Some(scratch) = Scratch::create().await else {
        panic!("set CACHET_TEST_DATABASE_URL to run this test");
    };
    let index = AssetIndex::connect(&scratch.url).await.expect("connect");
    fill(&index).await;

    assert_database_agrees_with_the_reference(&index).await;
    // Whatever was typed or sealed, it was data: the tables are intact.
    assert_eq!(
        index.list().await.expect("list").len(),
        descriptions().len()
    );

    // Whether a bundle holds an image is noted when it is stored, and a
    // listing asks for it without reading a bundle.
    {
        use cachet_index::MetadataStore;
        let with_image = index
            .put(br#"{"name":"A","image_data_uri":"data:image/png;base64,AAAA"}"#.to_vec())
            .await
            .expect("put");
        let without = index
            .put(br#"{"name":"B","image_data_uri":null}"#.to_vec())
            .await
            .expect("put");
        let visible = index
            .visible_image_hashes(&[with_image, without, [0x42; 32]])
            .await
            .expect("visible");
        assert!(visible.contains(&with_image));
        assert_eq!(visible.len(), 1);
    }

    // The journal outlives the chain: a description whose asset is no
    // longer indexed is "kept", one still on chain is not, a withheld one
    // is left out.
    let gone = cachet_domain::AssetId::from_bytes([0xee; 32]);
    let gone_withheld = cachet_domain::AssetId::from_bytes([0xef; 32]);
    let sealed = ChainDescription::compose("Gone With The Reset", &"cd".repeat(32)).unwrap();
    for id in [gone, gone_withheld] {
        index
            .record_description(id, &sealed)
            .await
            .expect("journal");
    }
    index
        .hide(
            ModerationKind::Description,
            gone_withheld.as_bytes(),
            Some("test"),
        )
        .await
        .expect("hide");
    let (kept, total) = index.kept_off_chain(10, 0).await.expect("kept");
    assert_eq!((kept.len(), total), (1, 1));
    assert_eq!(kept[0], (gone, sealed.clone()));
    assert_eq!(index.kept_off_chain(10, 1).await.expect("kept").0.len(), 0);
    assert_eq!(
        index.kept_description(gone).await.expect("kept one"),
        Some(sealed)
    );
    assert_eq!(
        index
            .kept_description(gone_withheld)
            .await
            .expect("kept one"),
        None
    );
    // An issuer the operator withholds stays withheld once its assets are
    // gone: the journal learned the key while the chain still said it.
    let listed = index.list().await.expect("list");
    let lost = listed
        .iter()
        .find(|asset| asset.description.is_some() && asset.issuer.is_some())
        .expect("a described asset with an issuer")
        .clone();
    let lost_issuer = hex::decode(lost.issuer.as_deref().unwrap()).unwrap();
    let pool = PgPoolOptions::new()
        .connect(&scratch.url)
        .await
        .expect("pool");
    let remembered: Option<Vec<u8>> =
        sqlx::query("SELECT issuer_ik FROM asset_descriptions WHERE asset_id = $1")
            .bind(lost.asset_id.as_bytes().as_slice())
            .fetch_one(&pool)
            .await
            .expect("journal row")
            .get("issuer_ik");
    assert_eq!(remembered.as_deref(), Some(lost_issuer.as_slice()));
    sqlx::query("DELETE FROM assets WHERE asset_id = $1")
        .bind(lost.asset_id.as_bytes().as_slice())
        .execute(&pool)
        .await
        .expect("stand in for a reset");
    assert!(
        index
            .kept_description(lost.asset_id)
            .await
            .expect("kept one")
            .is_some()
    );
    index
        .hide(ModerationKind::Issuer, &lost_issuer, Some("test"))
        .await
        .expect("hide issuer");
    assert_eq!(
        index
            .kept_description(lost.asset_id)
            .await
            .expect("kept one"),
        None
    );
    assert!(
        index
            .kept_off_chain(100, 0)
            .await
            .expect("kept")
            .0
            .iter()
            .all(|(id, _)| *id != lost.asset_id)
    );
    index
        .unhide(ModerationKind::Issuer, &lost_issuer)
        .await
        .expect("unhide issuer");
    pool.close().await;
    // Minted again: back on chain, no longer kept.
    index
        .apply(
            &[AssetDelta {
                asset_id: *lost.asset_id.as_bytes(),
                issued: lost.total_supply,
                burned: 0,
                finalized: lost.finalized,
                asset_desc_hash: None,
                issuer_ik: Some(lost_issuer.clone().try_into().expect("33 bytes")),
            }],
            &[],
            Checkpoint {
                tip_height: 10_000,
                tip_hash: "f".repeat(64),
            },
        )
        .await
        .expect("apply");
    assert_eq!(
        index
            .kept_description(lost.asset_id)
            .await
            .expect("kept one"),
        None
    );

    let on_chain = index.list().await.expect("list")[0].asset_id;
    assert_eq!(
        index.kept_description(on_chain).await.expect("kept one"),
        None
    );

    // Rows written before the derived columns existed are recomputed when
    // the index connects, and answer the same.
    drop(index);
    let pool = PgPoolOptions::new()
        .connect(&scratch.url)
        .await
        .expect("pool");
    sqlx::query("UPDATE asset_descriptions SET search_text = NULL, name_rank = NULL")
        .execute(&pool)
        .await
        .expect("forget derived names");
    let index = AssetIndex::connect(&scratch.url).await.expect("reconnect");
    let missing: i64 = sqlx::query(
        "SELECT COUNT(*) AS missing FROM asset_descriptions
         WHERE search_text IS NULL OR name_rank IS NULL",
    )
    .fetch_one(&pool)
    .await
    .expect("count")
    .get("missing");
    assert_eq!(missing, 0);
    assert_database_agrees_with_the_reference(&index).await;

    pool.close().await;
    drop(index);
    scratch.drop().await;
}
