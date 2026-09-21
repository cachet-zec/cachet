-- Listings answered a page at a time, by the database.
--
-- A listing can be searched and ordered by how a name is attested. Both
-- come from the description through rules written in Rust (the v1
-- envelope, a foreign JSON document's `name`, plain text), which SQL cannot
-- reproduce faithfully. So what those rules produce is kept beside the
-- description it was derived from:
--
--   search_text  the display name, a newline, the description; lowercased
--   name_rank    0 name sealed into the asset id, 1 free-text label
--
-- Reconstruction (PRIVACY.md P4): both are derived from `description` and
-- recomputed at startup for any row where they are missing or stale, so
-- they need no backup and a change of the naming rule needs no migration.
ALTER TABLE asset_descriptions
    ADD COLUMN search_text TEXT,
    ADD COLUMN name_rank   SMALLINT CHECK (name_rank IN (0, 1));

-- A page is the newest rows, or one issuer's newest rows.
CREATE INDEX assets_by_ord ON assets (ord DESC);
CREATE INDEX assets_by_issuer ON assets (issuer_ik, ord DESC);
