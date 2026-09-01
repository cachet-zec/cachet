-- The issuance validating key per asset (ZIP 227 canonical encoding:
-- algorithm byte + 32-byte BIP-340 x-only key). Groups assets into
-- chain-level collections: "same issuer" is the only provenance statement
-- the chain itself makes.
ALTER TABLE assets ADD COLUMN issuer_ik BYTEA;

-- Same reasoning as 0004: derived state is reconstructible, so wipe it and
-- let the next sync refold the whole range with issuer keys included. The
-- description journal survives.
DELETE FROM asset_events;
DELETE FROM assets;
DELETE FROM index_checkpoint;
