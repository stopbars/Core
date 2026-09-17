CREATE TABLE IF NOT EXISTS contributor_fast_track (
  user_id INTEGER PRIMARY KEY,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  granted_by INTEGER,
  granted_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at DATETIME NOT NULL,
  updated_by INTEGER,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  FOREIGN KEY (granted_by) REFERENCES users (id) ON DELETE SET NULL,
  FOREIGN KEY (updated_by) REFERENCES users (id) ON DELETE SET NULL
);

ALTER TABLE contributions ADD COLUMN decision_source TEXT CHECK (
  decision_source IN (
    'staff',
    'fast_track'
  )
);
ALTER TABLE contributions ADD COLUMN decided_by TEXT;

CREATE INDEX IF NOT EXISTS idx_contributor_fast_track_active
ON contributor_fast_track (user_id, enabled, expires_at);

CREATE INDEX IF NOT EXISTS idx_contributions_fast_track_limit
ON contributions (user_id, decision_source, decision_date DESC);
