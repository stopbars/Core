ALTER TABLE contributions ADD COLUMN generation_token TEXT;
ALTER TABLE contributions ADD COLUMN generation_hash TEXT;
ALTER TABLE contributions ADD COLUMN artifact_identity TEXT;
ALTER TABLE contributions ADD COLUMN artifact_generation_id TEXT;
ALTER TABLE contributions ADD COLUMN removal_artifact_key TEXT;
ALTER TABLE contributions ADD COLUMN bars_artifact_key TEXT;
ALTER TABLE contribution_generations ADD COLUMN simulator TEXT;
ALTER TABLE contribution_generations ADD COLUMN generation_hash TEXT;

CREATE INDEX IF NOT EXISTS idx_contributions_artifact_identity
ON contributions (airport_icao, artifact_identity, simulator, status);
