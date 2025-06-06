-- Existing tables
CREATE TABLE IF NOT EXISTS users (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 vatsim_id TEXT NOT NULL UNIQUE,
 api_key TEXT NOT NULL,
 last_api_key_regen DATETIME DEFAULT CURRENT_TIMESTAMP,
 email TEXT NOT NULL,
 created_at TEXT NOT NULL,
 last_login TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS stats (
  id INTEGER PRIMARY KEY,
  stat_key TEXT NOT NULL,
  value INTEGER NOT NULL,
  day_key TEXT NOT NULL,
  last_updated TEXT NOT NULL,
  UNIQUE(stat_key, day_key)
);

CREATE TABLE IF NOT EXISTS staff (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL UNIQUE,
  role TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(user_id) REFERENCES users(id)
);

-- Points table for airport lighting points
CREATE TABLE IF NOT EXISTS points (
    id TEXT PRIMARY KEY,
    airport_id TEXT NOT NULL,
    type TEXT CHECK(type IN ('stopbar', 'lead_on', 'taxiway', 'stand')) NOT NULL,
    name TEXT NOT NULL,
    coordinates TEXT NOT NULL,
    directionality TEXT CHECK(directionality IN ('bi-directional', 'uni-directional')),
    orientation TEXT CHECK(orientation IN ('left', 'right')),
    color TEXT CHECK(color IN ('yellow', 'green', 'green-yellow', 'green-orange', 'green-blue')),
    elevated BOOLEAN DEFAULT FALSE,
    ihp BOOLEAN DEFAULT FALSE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    created_by TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS airports (
    icao TEXT PRIMARY KEY,
    latitude REAL NOT NULL,
    longitude REAL NOT NULL,
    name TEXT NOT NULL,
    continent TEXT NOT NULL
);

-- Runways table
CREATE TABLE IF NOT EXISTS runways (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    airport_icao TEXT NOT NULL,
    length_ft TEXT NOT NULL,
    width_ft TEXT NOT NULL,
    le_ident TEXT NOT NULL,
    le_latitude_deg TEXT NOT NULL,
    le_longitude_deg TEXT NOT NULL,
    he_ident TEXT NOT NULL,
    he_latitude_deg TEXT NOT NULL,
    he_longitude_deg TEXT NOT NULL,
    FOREIGN KEY (airport_icao) REFERENCES airports(icao) ON DELETE CASCADE
);


-- Divisions table
CREATE TABLE IF NOT EXISTS divisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Division members table
CREATE TABLE IF NOT EXISTS division_members (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    division_id INTEGER NOT NULL,
    vatsim_id TEXT NOT NULL,
    role TEXT CHECK(role IN ('nav_head', 'nav_member')) NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (division_id) REFERENCES divisions(id) ON DELETE CASCADE,
    UNIQUE(division_id, vatsim_id)
);

-- Division airports table
CREATE TABLE IF NOT EXISTS division_airports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    division_id INTEGER NOT NULL,
    icao TEXT NOT NULL,
    status TEXT CHECK(status IN ('pending', 'approved', 'rejected')) NOT NULL DEFAULT 'pending',
    requested_by TEXT NOT NULL,
    approved_by TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (division_id) REFERENCES divisions(id) ON DELETE CASCADE,
    UNIQUE(division_id, icao)
);

-- Table for tracking active Durable Object connections
CREATE TABLE IF NOT EXISTS active_objects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    last_updated TEXT NOT NULL
);

-- Table for contributions
CREATE TABLE IF NOT EXISTS contributions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    user_display_name TEXT,
    airport_icao TEXT NOT NULL,
    package_name TEXT NOT NULL,
    submitted_xml TEXT NOT NULL,
    notes TEXT,
    submission_date DATETIME DEFAULT CURRENT_TIMESTAMP,
    status TEXT CHECK(status IN ('pending', 'approved', 'rejected', 'outdated')) NOT NULL DEFAULT 'pending',
    rejection_reason TEXT,
    decision_date DATETIME
);

-- NOTAM table for storing system-wide notifications
CREATE TABLE IF NOT EXISTS notams (
    id TEXT PRIMARY KEY,
    content TEXT NOT NULL,
    type TEXT DEFAULT 'warning' CHECK(type IN ('warning', 'info', 'discord', 'success', 'error')),
    updated_by TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_airports_continent ON airports(continent);
CREATE INDEX IF NOT EXISTS idx_runways_airport ON runways(airport_icao);
CREATE INDEX IF NOT EXISTS idx_runways_idents ON runways(le_ident, he_ident);
CREATE INDEX IF NOT EXISTS idx_vatsim_id ON users(vatsim_id);
CREATE INDEX IF NOT EXISTS idx_api_key ON users(api_key);
CREATE INDEX IF NOT EXISTS idx_stats_day_key ON stats(day_key);
CREATE INDEX IF NOT EXISTS idx_stats_stat_key ON stats(stat_key);
CREATE INDEX IF NOT EXISTS idx_staff_user_id ON staff(user_id);
CREATE INDEX IF NOT EXISTS idx_points_airport_id ON points(airport_id);
CREATE INDEX IF NOT EXISTS idx_points_type ON points(type);

-- Add index for active_objects name
CREATE INDEX IF NOT EXISTS idx_active_objects_name ON active_objects(name);

-- Contribution related indices
CREATE INDEX IF NOT EXISTS idx_contributions_status ON contributions(status);
CREATE INDEX IF NOT EXISTS idx_contributions_user ON contributions(user_id);
CREATE INDEX IF NOT EXISTS idx_contributions_airport ON contributions(airport_icao);
CREATE INDEX IF NOT EXISTS idx_contributions_submission_date ON contributions(submission_date);
CREATE INDEX IF NOT EXISTS idx_contributions_decision_date ON contributions(decision_date);

-- Additional indexes for performance optimization
CREATE INDEX IF NOT EXISTS idx_points_timestamps ON points(created_at, updated_at);

-- Additional indexes for query optimization

-- Users table indexes
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_created_at ON users(created_at DESC);

-- Division related indexes
CREATE INDEX IF NOT EXISTS idx_division_members_composite ON division_members(division_id, vatsim_id);
CREATE INDEX IF NOT EXISTS idx_division_airports_composite ON division_airports(division_id, icao);
CREATE INDEX IF NOT EXISTS idx_division_airports_icao ON division_airports(icao);

-- Points table composite index
CREATE INDEX IF NOT EXISTS idx_points_airport_type ON points(airport_id, type);