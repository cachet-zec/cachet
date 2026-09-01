-- Operator denylist: availability-only moderation. Hiding an entry stops
-- THIS registry from distributing the content; the chain commitment is
-- untouched and any other registry can keep serving the identical,
-- self-verifying bytes. Rows carry a reason and a timestamp so moderation
-- decisions stay auditable.
CREATE TABLE moderation_hidden (
    kind      TEXT NOT NULL CHECK (kind IN ('bundle', 'description')),
    key       BYTEA NOT NULL,
    reason    TEXT,
    hidden_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (kind, key)
);
