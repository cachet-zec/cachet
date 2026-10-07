-- The height of each asset's latest public event (issuance, burn, seal),
-- for listings ordered by activity. Derived from asset_events like the
-- rest of `assets`: kept current as events are indexed, filled here from
-- what is already indexed. Transfers are shielded and never counted.

ALTER TABLE assets ADD COLUMN last_height BIGINT;

UPDATE assets a
   SET last_height = e.height
  FROM (SELECT asset_id, MAX(height) AS height FROM asset_events GROUP BY asset_id) e
 WHERE e.asset_id = a.asset_id;

-- "Most active first" is an index walk: (last_height DESC NULLS LAST, ord DESC).
CREATE INDEX assets_by_activity ON assets (last_height DESC NULLS LAST, ord DESC);
