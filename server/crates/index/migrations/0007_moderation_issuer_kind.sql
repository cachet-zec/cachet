-- Issuer-level moderation: hiding an issuance validating key withholds
-- every asset minted under it from this registry's listings, while the
-- chain record stays untouched (availability only, like the other kinds).
--
-- Reconstruction (PRIVACY.md P4): operator judgement, not chain-derived
-- and not reconstructible — it is backed up with the bundle store.
ALTER TABLE moderation_hidden DROP CONSTRAINT IF EXISTS moderation_hidden_kind_check;
ALTER TABLE moderation_hidden
    ADD CONSTRAINT moderation_hidden_kind_check
    CHECK (kind IN ('bundle', 'description', 'issuer'));
