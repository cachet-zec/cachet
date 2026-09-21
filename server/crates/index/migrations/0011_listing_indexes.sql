-- A listing that stays a walk of an index as the registry grows.
--
-- Three questions a listing asks were answered by reading every row:
--
--   "does this bundle hold an image?"   read every candidate bundle in full
--   "named first"                       sorted the whole filtered join
--   "contains this text"                scanned every description
--
-- Reconstruction (PRIVACY.md P4): everything added here is derived, and the
-- server recomputes it at start where it can drift (`assets.name_rank`).

-- Whether the bundle embeds an image: the byte test the listing used to run
-- per request, done once, when the bundle is stored.
ALTER TABLE metadata_bundles ADD COLUMN has_image BOOLEAN;
UPDATE metadata_bundles
   SET has_image = position('"image_data_uri":"data:'::bytea in bytes) > 0;
ALTER TABLE metadata_bundles ALTER COLUMN has_image SET NOT NULL;
ALTER TABLE metadata_bundles ALTER COLUMN has_image SET DEFAULT FALSE;

-- How the asset's name is attested, as the listing orders by it: 0 sealed
-- into the asset id, 1 free-text label, 2 no description a caller may see
-- (none journaled, or withheld by the operator). Kept on the asset so
-- "named first" is an index walk: (name_rank, ord DESC).
ALTER TABLE assets ADD COLUMN name_rank SMALLINT NOT NULL DEFAULT 2
    CHECK (name_rank IN (0, 1, 2));
UPDATE assets a
   SET name_rank = COALESCE(d.name_rank, 1)
  FROM asset_descriptions d
 WHERE d.asset_id = a.asset_id
   AND NOT EXISTS (SELECT 1 FROM moderation_hidden m
                    WHERE m.kind = 'description' AND m.key = a.asset_id);
CREATE INDEX assets_by_name_rank ON assets (name_rank, ord DESC);

-- Text search: trigrams over the lowercased name and description. pg_trgm
-- ships with Postgres and is a trusted extension (a database owner may
-- create it).
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX asset_descriptions_search ON asset_descriptions
    USING gin (search_text gin_trgm_ops);
