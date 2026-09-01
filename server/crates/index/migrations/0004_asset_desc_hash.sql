-- The on-chain description hash (ZIP 227 assetDescHash) per asset. Needed
-- to verify permissionless description resolutions: anyone may submit a
-- preimage, and it is accepted only when its personalized BLAKE2b-256
-- matches this value — the registry cannot be lied to.
ALTER TABLE assets ADD COLUMN asset_desc_hash BYTEA;

-- Existing rows predate hash capture. All derived state is reconstructible
-- from the chain (ADR-001/P4), so wipe it and let the next sync refold the
-- whole range with hashes included. The issuer's description journal
-- (asset_descriptions) is NOT derived data and survives.
DELETE FROM asset_events;
DELETE FROM assets;
DELETE FROM index_checkpoint;
