-- Which transaction filled which board offer. When the maker countersigns,
-- the registry reads the id the swap will have from the take (a v6 txid
-- commits to the effecting data, not to proofs or signatures), and records
-- a fill only once the chain shows that very transaction in a block. So the
-- link is the chain's, not the taker's word, and a maker taking the units
-- back (which also spends the offered note) is never mistaken for a fill.
-- Fills outlive the swept offers: the terms were public on the board.
ALTER TABLE swap_offers ADD COLUMN txid TEXT;

CREATE INDEX swap_offers_txid ON swap_offers (txid) WHERE txid IS NOT NULL;

CREATE TABLE swap_fills (
    txid        TEXT PRIMARY KEY,
    offer_id    TEXT NOT NULL,
    give_asset  BYTEA NOT NULL CHECK (length(give_asset) = 32),
    give_amount BIGINT NOT NULL CHECK (give_amount > 0),
    want_asset  BYTEA NOT NULL CHECK (length(want_asset) = 32),
    want_amount BIGINT NOT NULL CHECK (want_amount > 0),
    height      BIGINT NOT NULL
);
