-- Operator-wide settings that must survive a restart: today the mint
-- pause (key 'mints_paused', a small JSON document with the decision,
-- an optional reason and its time). One row per key; the API keeps the
-- live value in memory and writes here on every change.
CREATE TABLE operator_settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
