-- The public swap board: a mailbox for the three messages of an atomic swap
-- (crates/swap, ADR 004). The registry holds messages, never keys: an offer
-- is public by design, a take and a countersignature are read back only
-- with the capability token their author was handed (stored as SHA-256).
-- Times are unix seconds. Nothing here is derived from the chain; rows are
-- disposable and swept once closed or expired. The maker's own browser
-- countersigns (it holds the keys), so an offer is only takeable while
-- that page keeps checking in (`maker_seen_at`).
CREATE TABLE swap_offers (
    id               TEXT PRIMARY KEY,
    offer            TEXT NOT NULL,
    give_asset       BYTEA NOT NULL CHECK (length(give_asset) = 32),
    give_amount      BIGINT NOT NULL CHECK (give_amount > 0),
    want_asset       BYTEA NOT NULL CHECK (length(want_asset) = 32),
    want_amount      BIGINT NOT NULL CHECK (want_amount > 0),
    maker_token      BYTEA NOT NULL CHECK (length(maker_token) = 32),
    created_at       BIGINT NOT NULL,
    expires_at       BIGINT NOT NULL,
    maker_seen_at    BIGINT NOT NULL,
    take             TEXT,
    taker_token      BYTEA CHECK (length(taker_token) = 32),
    taken_at         BIGINT,
    countersignature TEXT,
    closed           BOOLEAN NOT NULL DEFAULT false
);

CREATE INDEX swap_offers_open ON swap_offers (created_at DESC) WHERE NOT closed;
