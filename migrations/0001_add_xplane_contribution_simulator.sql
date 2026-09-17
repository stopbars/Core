PRAGMA defer_foreign_keys = on;

CREATE TABLE contributions_xplane_migration (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  airport_icao TEXT NOT NULL,
  package_name TEXT NOT NULL,
  submitted_xml TEXT NOT NULL,
  notes TEXT,
  simulator TEXT CHECK (
    simulator IN (
      'msfs2020',
      'msfs2024',
      'xplane'
    )
  ) NOT NULL DEFAULT 'msfs2024',
  submission_date DATETIME DEFAULT CURRENT_TIMESTAMP,
  status TEXT CHECK (
    status IN (
      'pending',
      'approved',
      'rejected',
      'outdated'
    )
  ) NOT NULL DEFAULT 'pending',
  rejection_reason TEXT,
  decision_date DATETIME
);

INSERT INTO contributions_xplane_migration (
  id,
  user_id,
  airport_icao,
  package_name,
  submitted_xml,
  notes,
  simulator,
  submission_date,
  status,
  rejection_reason,
  decision_date
)
SELECT
  id,
  user_id,
  airport_icao,
  package_name,
  submitted_xml,
  notes,
  simulator,
  submission_date,
  status,
  rejection_reason,
  decision_date
FROM contributions;

DROP TABLE contributions;

ALTER TABLE contributions_xplane_migration RENAME TO contributions;

CREATE INDEX IF NOT EXISTS idx_contributions_user_submission_date ON contributions (
  user_id,
  submission_date DESC
);

CREATE INDEX IF NOT EXISTS idx_contributions_submission_date ON contributions (
  submission_date
);

CREATE INDEX IF NOT EXISTS idx_contributions_status_submission_date ON contributions (
  status,
  submission_date DESC
);

CREATE INDEX IF NOT EXISTS idx_contributions_airport_submission_date ON contributions (
  airport_icao,
  submission_date DESC
);

CREATE INDEX IF NOT EXISTS idx_contributions_status_package ON contributions (
  status,
  package_name
);

CREATE INDEX IF NOT EXISTS idx_contributions_package_simulator_status ON contributions (
  package_name COLLATE NOCASE,
  simulator,
  status
);

CREATE INDEX IF NOT EXISTS idx_contributions_status_user ON contributions (
  status,
  user_id
);

CREATE INDEX IF NOT EXISTS idx_contributions_airport_lowerpkg_status_decision ON contributions (
  airport_icao,
  lower(package_name),
  status,
  decision_date DESC
);

PRAGMA defer_foreign_keys = off;
