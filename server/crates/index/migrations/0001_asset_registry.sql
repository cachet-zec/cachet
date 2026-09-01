-- Asset registry index.
--
-- Reconstruction (PRIVACY.md P4): every table here is derived or
-- re-derivable. `assets` and `index_checkpoint` rebuild from a full chain
-- scan (dropping them costs one rescan). `asset_descriptions` is the
-- issuer's own journal: the chain stores only the description *hash*, but
-- the issuer can re-derive each row from their own description records via
-- the deterministic ZIP 227 asset-id derivation. Losing it degrades labels,
-- never funds or supply data.

CREATE TABLE index_checkpoint (
    id          INTEGER PRIMARY KEY CHECK (id = 1),
    tip_height  BIGINT NOT NULL,
    tip_hash    TEXT   NOT NULL
);

CREATE TABLE assets (
    asset_id   BYTEA PRIMARY KEY CHECK (octet_length(asset_id) = 32),
    ord        BIGSERIAL NOT NULL,
    issued     BIGINT NOT NULL DEFAULT 0 CHECK (issued >= 0),
    burned     BIGINT NOT NULL DEFAULT 0 CHECK (burned >= 0),
    finalized  BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE TABLE asset_descriptions (
    asset_id    BYTEA PRIMARY KEY CHECK (octet_length(asset_id) = 32),
    description TEXT NOT NULL
);
