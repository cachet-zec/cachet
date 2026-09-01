-- Public asset events (issuances, burns, finalizations).
--
-- Reconstruction (PRIVACY.md P4): fully derived from the chain; wiped and
-- rebuilt together with `assets` on chain reset. Transfers are shielded
-- and by design never recorded anywhere.

CREATE TABLE asset_events (
    id       BIGSERIAL PRIMARY KEY,
    asset_id BYTEA  NOT NULL CHECK (octet_length(asset_id) = 32),
    height   BIGINT NOT NULL,
    txid     BYTEA  NOT NULL CHECK (octet_length(txid) = 32),
    kind     TEXT   NOT NULL CHECK (kind IN ('issuance', 'burn', 'finalization')),
    amount   BIGINT NOT NULL DEFAULT 0 CHECK (amount >= 0)
);

CREATE INDEX asset_events_by_asset ON asset_events (asset_id, id);
