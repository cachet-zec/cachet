-- Amounts as wide as the chain makes them.
--
-- An on-chain amount is an unsigned 64-bit integer, and an asset's issued
-- and burned totals are sums of such amounts with no ceiling of their own.
-- BIGINT holds neither: one mint above 2^63 - 1, or a total that crossed
-- it, failed the fold that carried it, and with the fold the checkpoint,
-- so the index stopped at that block for every asset. NUMERIC holds every
-- value exactly; nothing the chain can carry is refused, rounded or capped.
--
-- Existing values convert as they are. The non-negative CHECKs and the
-- defaults of migrations 0001 and 0003 follow the columns to the new type.
-- Heights and times stay BIGINT: they are nowhere near its range.
--
-- Reconstruction (PRIVACY.md P4): unchanged, all three columns are derived
-- from the chain.

ALTER TABLE assets
    ALTER COLUMN issued TYPE NUMERIC,
    ALTER COLUMN burned TYPE NUMERIC;

ALTER TABLE asset_events
    ALTER COLUMN amount TYPE NUMERIC;
