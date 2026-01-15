CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  vatsim_id TEXT NOT NULL UNIQUE,
  api_key TEXT NOT NULL,
  last_api_key_regen DATETIME DEFAULT CURRENT_TIMESTAMP,
  email TEXT NOT NULL,
  full_name TEXT,
  display_mode INTEGER NOT NULL DEFAULT 0,
  display_name TEXT,
  region_id TEXT,
  region_name TEXT,
  division_id TEXT,
  division_name TEXT,
  subdivision_id TEXT,
  subdivision_name TEXT,
  created_at TEXT NOT NULL,
  last_login TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS staff (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL UNIQUE,
  role TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (
    user_id
  ) REFERENCES users (
    id
  )
);

CREATE TABLE IF NOT EXISTS points (
  id TEXT PRIMARY KEY,
  airport_id TEXT NOT NULL,
  type TEXT CHECK (
    type IN (
      'stopbar',
      'lead_on',
      'taxiway',
      'stand'
    )
  ) NOT NULL,
  name TEXT NOT NULL,
  coordinates TEXT NOT NULL,
  directionality TEXT CHECK (
    directionality IN (
      'bi-directional',
      'uni-directional'
    )
  ),
  orientation TEXT CHECK (
    orientation IN (
      'left',
      'right'
    )
  ),
  color TEXT CHECK (
    color IN (
      'yellow',
      'green',
      'green-yellow',
      'green-orange',
      'green-blue'
    )
  ),
  elevated BOOLEAN DEFAULT FALSE,
  ihp BOOLEAN DEFAULT FALSE,
  linked_to TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  created_by TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS airports (
  icao TEXT PRIMARY KEY,
  latitude REAL NOT NULL,
  longitude REAL NOT NULL,
  name TEXT NOT NULL,
  continent TEXT NOT NULL,
  country_code TEXT,
  country_name TEXT,
  region_name TEXT,
  elevation_ft INTEGER,
  elevation_m REAL,
  bbox_min_lat REAL,
  bbox_min_lon REAL,
  bbox_max_lat REAL,
  bbox_max_lon REAL
);

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
  FOREIGN KEY (
    airport_icao
  ) REFERENCES airports (
    icao
  ) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS divisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS division_members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  division_id INTEGER NOT NULL,
  vatsim_id TEXT NOT NULL,
  role TEXT CHECK (
    role IN (
      'nav_head',
      'nav_member'
    )
  ) NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (
    division_id
  ) REFERENCES divisions (
    id
  ) ON DELETE CASCADE,
  UNIQUE (
    division_id,
    vatsim_id
  )
);

CREATE TABLE IF NOT EXISTS division_airports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  division_id INTEGER NOT NULL,
  icao TEXT NOT NULL,
  status TEXT CHECK (
    status IN (
      'pending',
      'approved',
      'rejected'
    )
  ) NOT NULL DEFAULT 'pending',
  requested_by TEXT NOT NULL,
  approved_by TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (
    division_id
  ) REFERENCES divisions (
    id
  ) ON DELETE CASCADE,
  UNIQUE (
    division_id,
    icao
  )
);

CREATE TABLE IF NOT EXISTS active_objects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  last_updated TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS contributions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  airport_icao TEXT NOT NULL,
  package_name TEXT NOT NULL,
  submitted_xml TEXT NOT NULL,
  notes TEXT,
  simulator TEXT CHECK (
    simulator IN (
      'msfs2020',
      'msfs2024'
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

CREATE TABLE IF NOT EXISTS notams (
  id TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  type TEXT DEFAULT 'warning' CHECK (
    type IN (
      'warning',
      'info',
      'discord',
      'success',
      'error'
    )
  ),
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS faqs (
  id TEXT PRIMARY KEY,
  question TEXT NOT NULL,
  answer TEXT NOT NULL,
  order_position INTEGER NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS installer_releases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product TEXT NOT NULL,
  version TEXT NOT NULL,
  file_key TEXT NOT NULL,
  file_size INTEGER NOT NULL,
  file_hash TEXT NOT NULL,
  changelog TEXT,
  image_url TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (
    product,
    version
  )
);

CREATE TABLE IF NOT EXISTS contact_messages (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  topic TEXT NOT NULL,
  message TEXT NOT NULL,
  ip_address TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (
    status IN (
      'pending',
      'handling',
      'handled'
    )
  ),
  handled_by TEXT,
  handled_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS downloads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product TEXT NOT NULL,
  version TEXT NOT NULL,
  total_count INTEGER NOT NULL DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (
    product,
    version
  )
);

CREATE TABLE IF NOT EXISTS download_ip_hits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product TEXT NOT NULL,
  version TEXT NOT NULL,
  ip_hash TEXT NOT NULL,
  last_seen DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (
    product,
    version,
    ip_hash
  )
);

CREATE TABLE IF NOT EXISTS bans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  vatsim_id TEXT NOT NULL UNIQUE,
  reason TEXT,
  issued_by TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  expires_at DATETIME
  -- NULL means permanent
  
);

CREATE INDEX IF NOT EXISTS idx_airports_continent ON airports (
  continent
);

CREATE INDEX IF NOT EXISTS idx_airports_continent_icao ON airports (
  continent,
  icao
);

CREATE INDEX IF NOT EXISTS idx_airports_lat_lon ON airports (
  latitude,
  longitude
);

CREATE INDEX IF NOT EXISTS idx_runways_airport ON runways (
  airport_icao
);

CREATE INDEX IF NOT EXISTS idx_runways_idents ON runways (
  le_ident,
  he_ident
);

CREATE INDEX IF NOT EXISTS idx_vatsim_id ON users (
  vatsim_id
);

CREATE INDEX IF NOT EXISTS idx_api_key ON users (
  api_key
);

CREATE INDEX IF NOT EXISTS idx_staff_user_id ON staff (
  user_id
);

CREATE INDEX IF NOT EXISTS idx_staff_role ON staff (
  role
);

CREATE INDEX IF NOT EXISTS idx_staff_created_at ON staff (
  created_at DESC
);

CREATE INDEX IF NOT EXISTS idx_points_airport_id ON points (
  airport_id
);

CREATE INDEX IF NOT EXISTS idx_points_type ON points (
  type
);

CREATE INDEX IF NOT EXISTS idx_active_objects_name ON active_objects (
  name
);

CREATE INDEX IF NOT EXISTS idx_active_objects_last_updated ON active_objects (
  last_updated
);

CREATE INDEX IF NOT EXISTS idx_contributions_status ON contributions (
  status
);

CREATE INDEX IF NOT EXISTS idx_contributions_user ON contributions (
  user_id
);

CREATE INDEX IF NOT EXISTS idx_contributions_user_submission_date ON contributions (
  user_id,
  submission_date DESC
);

CREATE INDEX IF NOT EXISTS idx_contributions_airport ON contributions (
  airport_icao
);

CREATE INDEX IF NOT EXISTS idx_contributions_submission_date ON contributions (
  submission_date
);

CREATE INDEX IF NOT EXISTS idx_contributions_decision_date ON contributions (
  decision_date
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

CREATE INDEX IF NOT EXISTS idx_contributions_airport_lowerpkg_status_decision ON contributions (
  airport_icao,
  lower(package_name),
  status,
  decision_date DESC
);

CREATE INDEX IF NOT EXISTS idx_points_timestamps ON points (
  created_at,
  updated_at
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users (
  email
);

CREATE INDEX IF NOT EXISTS idx_users_created_at ON users (
  created_at DESC
);

CREATE INDEX IF NOT EXISTS idx_division_members_composite ON division_members (
  division_id,
  vatsim_id
);

CREATE INDEX IF NOT EXISTS idx_division_members_vatsim ON division_members (
  vatsim_id
);

CREATE INDEX IF NOT EXISTS idx_division_airports_composite ON division_airports (
  division_id,
  icao
);

CREATE INDEX IF NOT EXISTS idx_division_airports_icao ON division_airports (
  icao
);

CREATE INDEX IF NOT EXISTS idx_points_airport_type ON points (
  airport_id,
  type
);

CREATE INDEX IF NOT EXISTS idx_points_linked_to ON points (
  linked_to
);

CREATE INDEX IF NOT EXISTS idx_faqs_order ON faqs (
  order_position ASC
);

CREATE INDEX IF NOT EXISTS idx_installer_releases_product ON installer_releases (
  product
);

CREATE INDEX IF NOT EXISTS idx_installer_releases_created_at ON installer_releases (
  created_at DESC
);

CREATE INDEX IF NOT EXISTS idx_installer_releases_product_created_at ON installer_releases (
  product,
  created_at DESC
);

CREATE INDEX IF NOT EXISTS idx_contact_messages_created_at ON contact_messages (
  created_at DESC
);

CREATE INDEX IF NOT EXISTS idx_contact_messages_ip_created ON contact_messages (
  ip_address,
  created_at DESC
);

CREATE INDEX IF NOT EXISTS idx_contact_messages_status ON contact_messages (
  status
);

CREATE INDEX IF NOT EXISTS idx_downloads_product ON downloads (
  product
);

CREATE INDEX IF NOT EXISTS idx_downloads_product_version ON downloads (
  product,
  version
);

CREATE INDEX IF NOT EXISTS idx_downloads_product_created_at ON downloads (
  product,
  created_at DESC
);

CREATE INDEX IF NOT EXISTS idx_download_ip_hits_product_version ON download_ip_hits (
  product,
  version
);

CREATE INDEX IF NOT EXISTS idx_download_ip_hits_last_seen ON download_ip_hits (
  last_seen
);

CREATE INDEX IF NOT EXISTS idx_download_ip_hits_cleanup ON download_ip_hits (
  last_seen,
  product,
  version
);

CREATE INDEX IF NOT EXISTS idx_bans_vatsim_id ON bans (
  vatsim_id
);

CREATE INDEX IF NOT EXISTS idx_bans_expires_at ON bans (
  expires_at
);

CREATE INDEX IF NOT EXISTS idx_bans_created_at ON bans (
  created_at DESC
);