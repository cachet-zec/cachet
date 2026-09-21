-- The journal remembers who issued.
--
-- An operator can withhold every asset of an issuance key. While the asset
-- is on chain that key is read from `assets`; after a chain reset `assets`
-- is emptied and the journal alone remains, so without the key beside the
-- description a withheld issuer's content would come back in the listing of
-- what the registry kept. The key is copied here while the chain still says
-- it, and stays.
--
-- Reconstruction (PRIVACY.md P4): chain-derived while the asset exists; for
-- an asset the chain no longer carries it is, like the description itself,
-- what this registry remembers. Rows journaled for assets that were already
-- gone when this migration ran have no key: the operator withholds those by
-- description.
ALTER TABLE asset_descriptions ADD COLUMN issuer_ik BYTEA;

UPDATE asset_descriptions d
   SET issuer_ik = a.issuer_ik
  FROM assets a
 WHERE a.asset_id = d.asset_id;
