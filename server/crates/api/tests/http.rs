//! Black-box tests of the HTTP surface against the in-memory backend.
//! These pin the API contract: status codes, problem+json shape, and the
//! issuance flow. They must keep passing unchanged when the OrchardZSA
//! backend replaces the in-memory one.

use std::sync::Arc;

use axum::Router;
use axum::body::Body;
use axum::http::{Request, StatusCode, header};
use cachet_chain::memory::InMemoryChain;
use http_body_util::BodyExt;
use serde_json::{Value, json};
use tower::ServiceExt;

fn app() -> Router {
    // with_health mirrors the binary: the probe is mounted separately so
    // it can live outside the rate-limit layer in production.
    cachet_api::with_health(cachet_api::router(
        Arc::new(InMemoryChain::new()),
        Some(Arc::new(cachet_index::MemoryMetadataStore::new())),
        false,
        None,
    ))
}

fn read_only_app() -> Router {
    cachet_api::router(
        Arc::new(InMemoryChain::new()),
        Some(Arc::new(cachet_index::MemoryMetadataStore::new())),
        true,
        None,
    )
}

async fn send(app: &Router, request: Request<Body>) -> (StatusCode, Value) {
    let response = app.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let body = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes).unwrap()
    };
    (status, body)
}

fn post_json(uri: &str, body: Value) -> Request<Body> {
    Request::post(uri)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(body.to_string()))
        .unwrap()
}

#[tokio::test]
async fn health_is_alive() {
    let (status, _) = send(
        &app(),
        Request::get("/healthz").body(Body::empty()).unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
}

#[tokio::test]
async fn openapi_document_is_served() {
    let (status, body) = send(
        &app(),
        Request::get("/api/openapi.json")
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["info"]["title"], "Cachet API");
    assert!(body["paths"]["/api/v1/assets"].is_object());
}

#[tokio::test]
async fn issue_then_fetch_asset() {
    let app = app();

    let (status, issued) = send(
        &app,
        post_json(
            "/api/v1/assets",
            json!({"description": "Cachet Demo Ticket", "amount": 1000}),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED);
    assert_eq!(issued["txid"].as_str().unwrap().len(), 64);

    // The issuance receipt hands back the asset id; the read path must
    // resolve it.
    let asset_id = issued["asset_id"].as_str().unwrap().to_owned();
    assert_eq!(asset_id.len(), 64);
    let (status, asset) = send(
        &app,
        Request::get(format!("/api/v1/assets/{asset_id}"))
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(asset["total_supply"], 1000);
    assert_eq!(asset["finalized"], false);
}

#[tokio::test]
async fn validation_errors_are_problem_json() {
    let (status, body) = send(
        &app(),
        post_json("/api/v1/assets", json!({"description": "X", "amount": 0})),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["status"], 400);
    assert!(
        body["detail"]
            .as_str()
            .unwrap()
            .contains("greater than zero")
    );
}

#[tokio::test]
async fn unknown_asset_is_404() {
    let missing = "0".repeat(64);
    let (status, body) = send(
        &app(),
        Request::get(format!("/api/v1/assets/{missing}"))
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(body["type"], "https://cachetzec.com/problems/unknown-asset");
}

#[tokio::test]
async fn malformed_asset_id_is_400() {
    let (status, _) = send(
        &app(),
        Request::get("/api/v1/assets/not-hex")
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn list_assets_newest_first_with_descriptions() {
    let app = app();
    send(
        &app,
        post_json(
            "/api/v1/assets",
            json!({"description": "First", "amount": 10}),
        ),
    )
    .await;
    send(
        &app,
        post_json(
            "/api/v1/assets",
            json!({"description": "Second", "amount": 20, "finalize": true}),
        ),
    )
    .await;

    let (status, body) = send(
        &app,
        Request::get("/api/v1/assets").body(Body::empty()).unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let list = body.as_array().unwrap();
    assert_eq!(list.len(), 2);
    assert_eq!(list[0]["description"], "Second");
    assert_eq!(list[0]["finalized"], true);
    assert_eq!(list[1]["description"], "First");
    assert_eq!(list[1]["total_supply"], 10);
}

#[tokio::test]
async fn resolved_filter_composes_with_limit() {
    // Every asset the in-memory chain mints carries a description, so it
    // cannot produce the unresolved case; what is checked here is that the
    // filter keeps resolved assets and that `limit` applies AFTER it, so
    // asking for one resolved asset returns one rather than whatever is
    // resolved among the newest one.
    let app = app();
    for (description, amount) in [("First", 10), ("Second", 20)] {
        send(
            &app,
            post_json(
                "/api/v1/assets",
                json!({"description": description, "amount": amount}),
            ),
        )
        .await;
    }

    let (status, body) = send(
        &app,
        Request::get("/api/v1/assets?resolved=true")
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let list = body.as_array().unwrap();
    assert_eq!(list.len(), 2);
    assert!(list.iter().all(|asset| !asset["name_source"].is_null()));

    let (status, body) = send(
        &app,
        Request::get("/api/v1/assets?resolved=true&limit=1")
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body.as_array().unwrap().len(), 1);

    // Omitting the parameter must not narrow anything: the unfiltered
    // listing stays the default.
    let (_, body) = send(
        &app,
        Request::get("/api/v1/assets").body(Body::empty()).unwrap(),
    )
    .await;
    assert_eq!(body.as_array().unwrap().len(), 2);
}

#[tokio::test]
async fn transfer_then_burn_cycle() {
    let app = app();

    let (_, issued) = send(
        &app,
        post_json(
            "/api/v1/assets",
            json!({"description": "Cycle Asset", "amount": 1000}),
        ),
    )
    .await;
    let asset_id = issued["asset_id"].as_str().unwrap().to_owned();

    let (status, transferred) = send(
        &app,
        post_json(
            &format!("/api/v1/assets/{asset_id}/transfers"),
            json!({"amount": 300, "recipient": "account:1"}),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED);
    assert_eq!(transferred["txid"].as_str().unwrap().len(), 64);

    let (status, _) = send(
        &app,
        post_json(
            &format!("/api/v1/assets/{asset_id}/burns"),
            json!({"amount": 200}),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED);

    // Burn reduces supply; transfer does not.
    let (_, asset) = send(
        &app,
        Request::get(format!("/api/v1/assets/{asset_id}"))
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert_eq!(asset["total_supply"], 800);
}

#[tokio::test]
async fn transfer_more_than_held_is_unprocessable() {
    let app = app();
    let (_, issued) = send(
        &app,
        post_json(
            "/api/v1/assets",
            json!({"description": "Tiny", "amount": 5}),
        ),
    )
    .await;
    let asset_id = issued["asset_id"].as_str().unwrap().to_owned();

    let (status, body) = send(
        &app,
        post_json(
            &format!("/api/v1/assets/{asset_id}/transfers"),
            json!({"amount": 50, "recipient": "account:1"}),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(
        body["type"],
        "https://cachetzec.com/problems/insufficient-funds"
    );
}

#[tokio::test]
async fn malformed_recipient_is_400() {
    let app = app();
    let (_, issued) = send(
        &app,
        post_json("/api/v1/assets", json!({"description": "R", "amount": 5})),
    )
    .await;
    let asset_id = issued["asset_id"].as_str().unwrap().to_owned();

    let (status, _) = send(
        &app,
        post_json(
            &format!("/api/v1/assets/{asset_id}/transfers"),
            json!({"amount": 1, "recipient": "account:not-a-number"}),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn metadata_upload_binds_name_and_image_to_the_asset() {
    let app = app();

    // A 1x1 transparent PNG.
    let png_data_uri = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

    let (status, uploaded) = send(
        &app,
        post_json(
            "/api/v1/metadata",
            json!({
                "name": "Zcon Ticket 2027",
                "description": "Admits one, shielded.",
                "image_data_uri": png_data_uri,
            }),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    let sha256 = uploaded["sha256"].as_str().unwrap().to_owned();
    let chain_description = uploaded["chain_description"].as_str().unwrap().to_owned();
    assert!(chain_description.contains("Zcon Ticket 2027"));
    assert!(chain_description.len() <= 512);

    // The bundle is retrievable by hash, byte-exact.
    let (status, bundle) = send(
        &app,
        Request::get(format!("/api/v1/metadata/{sha256}"))
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(bundle["name"], "Zcon Ticket 2027");

    // Issue with the composed description: the listing shows the display
    // name and points at the same-origin image.
    let (_, issued) = send(
        &app,
        post_json(
            "/api/v1/assets",
            json!({"description": chain_description, "amount": 100}),
        ),
    )
    .await;
    assert_eq!(issued["asset_id"].as_str().unwrap().len(), 64);

    let (_, list) = send(
        &app,
        Request::get("/api/v1/assets").body(Body::empty()).unwrap(),
    )
    .await;
    let entry = &list.as_array().unwrap()[0];
    assert_eq!(entry["display_name"], "Zcon Ticket 2027");
    assert_eq!(
        entry["image_path"],
        format!("/api/v1/metadata/{sha256}/image")
    );

    // And the image itself is served.
    let response = app
        .clone()
        .oneshot(
            Request::get(format!("/api/v1/metadata/{sha256}/image"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response.headers()["content-type"].to_str().unwrap(),
        "image/png"
    );
}

#[tokio::test]
async fn unknown_metadata_hash_is_404_and_bad_image_rejected() {
    let app = app();
    let missing = "ee".repeat(32);
    let (status, body) = send(
        &app,
        Request::get(format!("/api/v1/metadata/{missing}"))
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(body["type"], "https://cachetzec.com/problems/not-found");

    let (status, _) = send(
        &app,
        post_json(
            "/api/v1/metadata",
            json!({"name": "X", "image_data_uri": "data:image/svg+xml;base64,AAAA"}),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn wallet_balances_track_the_lifecycle() {
    let app = app();
    let (_, issued) = send(
        &app,
        post_json(
            "/api/v1/assets",
            json!({"description": "Treasury", "amount": 1000}),
        ),
    )
    .await;
    let asset_id = issued["asset_id"].as_str().unwrap().to_owned();
    send(
        &app,
        post_json(
            &format!("/api/v1/assets/{asset_id}/transfers"),
            json!({"amount": 300, "recipient": "account:1"}),
        ),
    )
    .await;

    let (status, wallet) = send(
        &app,
        Request::get("/api/v1/wallet").body(Body::empty()).unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let accounts = wallet.as_array().unwrap();
    let account0 = accounts.iter().find(|a| a["account"] == 0).unwrap();
    let account1 = accounts.iter().find(|a| a["account"] == 1).unwrap();
    assert_eq!(account0["holdings"][0]["amount"], 700);
    assert_eq!(account1["holdings"][0]["amount"], 300);
}

#[tokio::test]
async fn asset_events_list_public_history_without_transfers() {
    let app = app();
    let (_, issued) = send(
        &app,
        post_json(
            "/api/v1/assets",
            json!({"description": "Storied", "amount": 500}),
        ),
    )
    .await;
    let asset_id = issued["asset_id"].as_str().unwrap().to_owned();
    send(
        &app,
        post_json(
            &format!("/api/v1/assets/{asset_id}/transfers"),
            json!({"amount": 100, "recipient": "account:1"}),
        ),
    )
    .await;
    send(
        &app,
        post_json(
            &format!("/api/v1/assets/{asset_id}/burns"),
            json!({"amount": 50}),
        ),
    )
    .await;

    let (status, events) = send(
        &app,
        Request::get(format!("/api/v1/assets/{asset_id}/events"))
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let events = events.as_array().unwrap();
    // Issuance and burn are public; the transfer must NOT appear.
    assert_eq!(events.len(), 2);
    assert_eq!(events[0]["kind"], "issuance");
    assert_eq!(events[0]["amount"], 500);
    assert_eq!(events[1]["kind"], "burn");
    assert_eq!(events[1]["amount"], 50);
}

#[tokio::test]
async fn read_only_mode_blocks_mutations_but_not_reads() {
    let app = read_only_app();

    let (status, chain) = send(
        &app,
        Request::get("/api/v1/chain").body(Body::empty()).unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(chain["read_only"], true);

    let (status, body) = send(
        &app,
        post_json("/api/v1/assets", json!({"description": "X", "amount": 1})),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(
        body["type"],
        "https://cachetzec.com/problems/read-only-mode"
    );

    // Metadata upload stays open, FULL bundles included: community mints
    // carry names, descriptions and images. The abuse bound is the
    // chain-anchored garbage collector plus the upload throttles, not a
    // read-only refusal.
    let (status, _) = send(&app, post_json("/api/v1/metadata", json!({"name": "X"}))).await;
    assert_eq!(status, StatusCode::CREATED);
    let (status, _) = send(
        &app,
        post_json(
            "/api/v1/metadata",
            json!({
                "name": "X",
                "description": "a community asset",
                "image_data_uri": "data:image/png;base64,AAAA"
            }),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);

    let (status, _) = send(
        &app,
        Request::get("/api/v1/assets").body(Body::empty()).unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
}

#[tokio::test]
async fn purged_bytes_are_gone_and_cannot_come_back() {
    use cachet_index::{MetadataStore, ModerationKind};
    let store = Arc::new(cachet_index::MemoryMetadataStore::new());
    let app = cachet_api::router(
        Arc::new(InMemoryChain::new()),
        Some(store.clone()),
        false,
        None,
    );

    let upload = json!({"name": "Must Not Stay", "description": "bytes an operator cannot keep"});
    let (status, meta) = send(&app, post_json("/api/v1/metadata", upload.clone())).await;
    assert_eq!(status, StatusCode::CREATED);
    let sha = meta["sha256"].as_str().unwrap().to_owned();
    let mut bytes = [0u8; 32];
    hex::decode_to_slice(&sha, &mut bytes).unwrap();

    // What the admin purge does, through the store: hide, then delete.
    store
        .moderation_hide(ModerationKind::Bundle, &bytes, Some("purged"))
        .await
        .unwrap();
    assert!(store.delete(bytes).await.unwrap());
    assert!(store.get(bytes).await.unwrap().is_none(), "bytes are gone");

    // Distribution answers 410, as for any hidden bundle...
    let (status, _) = send(
        &app,
        Request::get(format!("/api/v1/metadata/{sha}"))
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::GONE);

    // ...and the same bytes cannot be re-uploaded: refused before storage.
    let (status, body) = send(&app, post_json("/api/v1/metadata", upload)).await;
    assert_eq!(status, StatusCode::GONE);
    assert_eq!(
        body["type"],
        "https://cachetzec.com/problems/hidden-by-operator"
    );
    assert!(store.get(bytes).await.unwrap().is_none(), "still gone");
}

#[tokio::test]
async fn admin_surface_is_absent_without_a_token() {
    // No CACHET_ADMIN_TOKEN in the environment → 404 on every method and
    // even with a (necessarily wrong) bearer token: indistinguishable
    // from not existing.
    let app = app();
    let (status, _) = send(
        &app,
        Request::get("/api/v1/admin/moderation")
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, _) = send(
        &app,
        Request::post("/api/v1/admin/moderation")
            .header("authorization", "Bearer guess")
            .header("content-type", "application/json")
            .body(Body::from(
                serde_json::to_vec(&json!({"kind": "issuer", "key": "00aa"})).unwrap(),
            ))
            .unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn relay_validates_and_stays_open_in_read_only_mode() {
    // Bad hex is a validation error.
    let (status, _) = send(
        &read_only_app(),
        post_json("/api/v1/relay", json!({"tx_hex": "not-hex"})),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    // Read-only does NOT gate the relay (the instance signs nothing); the
    // in-memory backend then rejects it as unsupported, proving the
    // request reached the chain boundary rather than a 403.
    let (status, body) = send(
        &read_only_app(),
        post_json("/api/v1/relay", json!({"tx_hex": "deadbeef"})),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(
        body["type"],
        "https://cachetzec.com/problems/rejected-by-node"
    );
}

#[tokio::test]
async fn finalized_asset_conflicts_on_reissue() {
    let app = app();
    send(
        &app,
        post_json(
            "/api/v1/assets",
            json!({"description": "One-shot", "amount": 5, "finalize": true}),
        ),
    )
    .await;

    let (status, body) = send(
        &app,
        post_json(
            "/api/v1/assets",
            json!({"description": "One-shot", "amount": 1}),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(
        body["type"],
        "https://cachetzec.com/problems/asset-finalized"
    );
}

#[tokio::test]
async fn batch_mints_several_assets_in_one_transaction() {
    let app = app();
    let (status, body) = send(
        &app,
        post_json(
            "/api/v1/assets/batch",
            json!({"items": [
                {"description": "Edition A", "amount": 1, "finalize": true},
                {"description": "Edition B", "amount": 1, "finalize": true},
                {"description": "Edition C", "amount": 10}
            ]}),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED);
    let asset_ids = body["asset_ids"].as_array().unwrap();
    assert_eq!(asset_ids.len(), 3);
    let txid = body["txid"].as_str().unwrap();
    assert_eq!(txid.len(), 64);

    // Every asset is readable and its history carries the SAME txid.
    for (index, asset_id) in asset_ids.iter().enumerate() {
        let asset_id = asset_id.as_str().unwrap();
        let (status, asset) = send(
            &app,
            Request::get(format!("/api/v1/assets/{asset_id}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(asset["finalized"], index < 2);

        let (_, events) = send(
            &app,
            Request::get(format!("/api/v1/assets/{asset_id}/events"))
                .body(Body::empty())
                .unwrap(),
        )
        .await;
        assert_eq!(events[0]["txid"], txid);
    }
}

#[tokio::test]
async fn batch_rejects_duplicates_and_bad_sizes() {
    let app = app();
    let (status, _) = send(
        &app,
        post_json(
            "/api/v1/assets/batch",
            json!({"items": [
                {"description": "Twin", "amount": 1},
                {"description": "Twin", "amount": 2}
            ]}),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    let (status, _) = send(
        &app,
        post_json("/api/v1/assets/batch", json!({"items": []})),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn batch_is_gated_in_read_only_mode() {
    let (status, body) = send(
        &read_only_app(),
        post_json(
            "/api/v1/assets/batch",
            json!({"items": [{"description": "X", "amount": 1}]}),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(
        body["type"],
        "https://cachetzec.com/problems/read-only-mode"
    );
}

#[tokio::test]
async fn description_resolution_verifies_the_preimage() {
    let app = app();
    let (_, issued) = send(
        &app,
        post_json(
            "/api/v1/assets",
            json!({"description": "Provable", "amount": 7}),
        ),
    )
    .await;
    let asset_id = issued["asset_id"].as_str().unwrap().to_owned();

    // A wrong preimage is rejected: the registry cannot be lied to.
    let (status, body) = send(
        &app,
        post_json(
            &format!("/api/v1/assets/{asset_id}/description"),
            json!({"description": "Forged"}),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(body["detail"].as_str().unwrap().contains("commitment"));

    // The true preimage verifies (idempotently).
    let (status, resolved) = send(
        &app,
        post_json(
            &format!("/api/v1/assets/{asset_id}/description"),
            json!({"description": "Provable"}),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(resolved["description"], "Provable");
    assert_eq!(resolved["name_source"], "free_text");
}

#[tokio::test]
async fn description_resolution_stays_open_in_read_only_mode() {
    // Resolution is a verification act, not an issuance act: a public
    // read-only registry must keep accepting provable preimages.
    let chain = Arc::new(InMemoryChain::new());
    let writable = cachet_api::router(
        chain.clone(),
        Some(Arc::new(cachet_index::MemoryMetadataStore::new())),
        false,
        None,
    );
    let (_, issued) = send(
        &writable,
        post_json(
            "/api/v1/assets",
            json!({"description": "Shared", "amount": 1}),
        ),
    )
    .await;
    let asset_id = issued["asset_id"].as_str().unwrap().to_owned();

    let read_only = cachet_api::router(
        chain,
        Some(Arc::new(cachet_index::MemoryMetadataStore::new())),
        true,
        None,
    );
    let (status, _) = send(
        &read_only,
        post_json(
            &format!("/api/v1/assets/{asset_id}/description"),
            json!({"description": "Shared"}),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
}

#[tokio::test]
async fn assets_carry_their_issuer_and_collections_group_them() {
    let app = app();
    send(
        &app,
        post_json(
            "/api/v1/assets",
            json!({"description": "Solo A", "amount": 3}),
        ),
    )
    .await;
    send(
        &app,
        post_json(
            "/api/v1/assets",
            json!({"description": "Solo B", "amount": 4, "finalize": true}),
        ),
    )
    .await;

    let (_, assets) = send(
        &app,
        Request::get("/api/v1/assets").body(Body::empty()).unwrap(),
    )
    .await;
    let issuer = assets[0]["issuer"].as_str().unwrap();
    assert_eq!(issuer.len(), 66); // 33 bytes, ZIP 227 canonical encoding
    assert_eq!(assets[1]["issuer"], issuer);

    let (status, collections) = send(
        &app,
        Request::get("/api/v1/collections")
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(collections.as_array().unwrap().len(), 1);
    assert_eq!(collections[0]["issuer"], issuer);
    assert_eq!(collections[0]["asset_count"], 2);
    assert_eq!(collections[0]["total_supply"], 7);
    assert_eq!(collections[0]["finalized_count"], 1);
}

#[tokio::test]
async fn wallet_is_private_in_read_only_mode() {
    // A public read-only instance must not broadcast the operator's
    // shielded balances.
    let (status, body) = send(
        &read_only_app(),
        Request::get("/api/v1/wallet").body(Body::empty()).unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(
        body["type"],
        "https://cachetzec.com/problems/read-only-mode"
    );
}

#[tokio::test]
async fn operator_denylist_hides_bundles_without_touching_the_chain() {
    // Build the app with a handle on the store so the test can act as the
    // operator's denylist.
    let store = Arc::new(cachet_index::MemoryMetadataStore::new());
    let app = cachet_api::router(
        Arc::new(InMemoryChain::new()),
        Some(store.clone()),
        false,
        None,
    );

    let (_, meta) = send(
        &app,
        post_json("/api/v1/metadata", json!({"name": "Edgy Art"})),
    )
    .await;
    let sha = meta["sha256"].as_str().unwrap().to_owned();
    let (_, issued) = send(
        &app,
        post_json(
            "/api/v1/assets",
            json!({"description": meta["chain_description"], "amount": 1}),
        ),
    )
    .await;
    let asset_id = issued["asset_id"].as_str().unwrap().to_owned();

    // Served before moderation.
    let (status, _) = send(
        &app,
        Request::get(format!("/api/v1/metadata/{sha}"))
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    // The operator hides the bundle: distribution stops with an explicit
    // problem type...
    let mut bytes = [0u8; 32];
    hex::decode_to_slice(&sha, &mut bytes).unwrap();
    store.hide(bytes);
    for path in [
        format!("/api/v1/metadata/{sha}"),
        format!("/api/v1/metadata/{sha}/image"),
    ] {
        let (status, body) = send(&app, Request::get(path).body(Body::empty()).unwrap()).await;
        assert_eq!(status, StatusCode::GONE);
        assert_eq!(
            body["type"],
            "https://cachetzec.com/problems/hidden-by-operator"
        );
    }

    // ...but the chain facts are untouched: the asset still exists with
    // its exact supply.
    let (status, asset) = send(
        &app,
        Request::get(format!("/api/v1/assets/{asset_id}"))
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(asset["total_supply"], 1);
}

/// Signed snapshots: 503 without an operator key; with one, the envelope
/// verifies by the documented procedure and reflects the registry.
#[tokio::test]
async fn snapshot_signed_and_verifiable() {
    use base64::Engine as _;
    use ed25519_dalek::Verifier;
    use sha2::Digest;

    // Without a key the endpoint is honestly unavailable.
    let keyless = app();
    let (status, body) = send(
        &keyless,
        Request::get("/api/v1/snapshot")
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(
        body["type"],
        "https://cachetzec.com/problems/not-configured"
    );

    // With a key: mint one asset, snapshot, verify.
    let key = cachet_api::snapshot::signing_key_from_hex(&"22".repeat(32)).unwrap();
    let app = cachet_api::router(
        Arc::new(InMemoryChain::new()),
        Some(Arc::new(cachet_index::MemoryMetadataStore::new())),
        false,
        Some(Arc::new(key)),
    );
    let (_, issued) = send(
        &app,
        post_json(
            "/api/v1/assets",
            json!({"description": "Snapshot Me", "amount": 3}),
        ),
    )
    .await;
    let asset_id = issued["asset_id"].as_str().unwrap();

    let (status, envelope) = send(
        &app,
        Request::get("/api/v1/snapshot")
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    // 1. payload hashes to sha256
    let payload_bytes = base64::engine::general_purpose::STANDARD
        .decode(envelope["payload"].as_str().unwrap())
        .unwrap();
    let sha256: [u8; 32] = sha2::Sha256::digest(&payload_bytes).into();
    assert_eq!(hex::encode(sha256), envelope["sha256"].as_str().unwrap());

    // 2. signature verifies over the domain-separated hash
    let public = ed25519_dalek::VerifyingKey::from_bytes(
        &<[u8; 32]>::try_from(hex::decode(envelope["public_key"].as_str().unwrap()).unwrap())
            .unwrap(),
    )
    .unwrap();
    let signature = ed25519_dalek::Signature::from_bytes(
        &<[u8; 64]>::try_from(hex::decode(envelope["signature"].as_str().unwrap()).unwrap())
            .unwrap(),
    );
    let mut message = b"cachet-snapshot-v1".to_vec();
    message.extend_from_slice(&sha256);
    public
        .verify(&message, &signature)
        .expect("signature verifies");

    // 3. the payload reflects the registry
    let payload: Value = serde_json::from_slice(&payload_bytes).unwrap();
    assert_eq!(payload["version"], 1);
    let assets = payload["assets"].as_array().unwrap();
    let entry = assets
        .iter()
        .find(|a| a["asset_id"] == asset_id)
        .expect("minted asset is in the snapshot");
    assert_eq!(entry["total_supply"], 3);
}
