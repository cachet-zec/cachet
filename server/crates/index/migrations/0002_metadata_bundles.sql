-- Content-addressed metadata bundles.
--
-- Reconstruction (PRIVACY.md P4): issuer-provided journal data. The bundle
-- hash is immutably committed on-chain inside the asset's description, so
-- integrity never depends on this table; availability does. The issuer can
-- re-upload the identical bundle at any time (same bytes → same hash) —
-- losing this table degrades display, never trust or funds.

CREATE TABLE metadata_bundles (
    sha256     BYTEA PRIMARY KEY CHECK (octet_length(sha256) = 32),
    bytes      BYTEA NOT NULL CHECK (octet_length(bytes) <= 1000000),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
