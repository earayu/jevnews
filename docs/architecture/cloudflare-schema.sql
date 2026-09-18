-- JevNews Cloudflare / D1 design schema v0.1, 2026-09-19.
-- Design reference, not an executed production migration.
-- SQLite compatibility is tested locally; D1 remote validation remains required.
-- All timestamps are UTC epoch seconds. IDs other than HN IDs are application-generated.
PRAGMA foreign_keys = ON;

CREATE TABLE hn_items (
  hn_id INTEGER PRIMARY KEY,
  item_type TEXT NOT NULL,
  author TEXT,
  title TEXT,
  url TEXT,
  submitted_at INTEGER NOT NULL,
  parent_id INTEGER,
  score INTEGER,
  descendants INTEGER,
  kids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(kids_json)),
  text_html TEXT,
  deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),
  dead INTEGER NOT NULL DEFAULT 0 CHECK (dead IN (0, 1)),
  payload_hash TEXT NOT NULL,
  fetched_at INTEGER NOT NULL
);
CREATE INDEX hn_items_recent ON hn_items(submitted_at DESC, hn_id DESC);
-- No index on score/descendants/fetched_at: avoid a write to indexes for every counter refresh.
-- Parent comments can be retrieved through kids_json; add a parent index only after measuring.

CREATE TABLE source_documents (
  id TEXT PRIMARY KEY,
  url_key TEXT NOT NULL UNIQUE,
  original_url TEXT NOT NULL,
  final_url TEXT,
  current_version_id TEXT,
  fetch_status TEXT NOT NULL DEFAULT 'pending',
  etag TEXT,
  last_modified TEXT,
  last_attempt_at INTEGER,
  next_retry_at INTEGER,
  failure_code TEXT
);
CREATE TABLE document_versions (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES source_documents(id),
  content_hash TEXT NOT NULL,
  extractor_version TEXT NOT NULL,
  coverage TEXT NOT NULL CHECK (coverage IN ('full', 'partial', 'metadata_only')),
  body_r2_key TEXT,
  byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  UNIQUE(document_id, content_hash, extractor_version)
);
CREATE TABLE story_documents (
  hn_id INTEGER PRIMARY KEY REFERENCES hn_items(hn_id) ON DELETE CASCADE,
  document_id TEXT NOT NULL REFERENCES source_documents(id)
);

CREATE TABLE article_analyses (
  id TEXT PRIMARY KEY,
  input_hash TEXT NOT NULL,
  rubric_version TEXT NOT NULL,
  model_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ready', 'partial', 'failed')),
  features_json TEXT NOT NULL CHECK (json_valid(features_json)),
  evidence_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(evidence_json)),
  input_tokens INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  UNIQUE(input_hash, rubric_version, model_id)
);
CREATE TABLE story_analyses (
  hn_id INTEGER PRIMARY KEY REFERENCES hn_items(hn_id) ON DELETE CASCADE,
  analysis_id TEXT NOT NULL REFERENCES article_analyses(id),
  document_version_id TEXT REFERENCES document_versions(id),
  updated_at INTEGER NOT NULL
);
CREATE TABLE preset_versions (
  preset_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  config_json TEXT NOT NULL CHECK (json_valid(config_json)),
  created_at INTEGER NOT NULL,
  PRIMARY KEY(preset_id, version)
) WITHOUT ROWID;
CREATE TABLE preset_scores (
  preset_id TEXT NOT NULL,
  preset_version INTEGER NOT NULL,
  hn_id INTEGER NOT NULL REFERENCES hn_items(hn_id) ON DELETE CASCADE,
  analysis_id TEXT NOT NULL REFERENCES article_analyses(id),
  base_score REAL NOT NULL,
  sort_priority REAL NOT NULL,
  computed_at INTEGER NOT NULL,
  PRIMARY KEY(preset_id, preset_version, hn_id),
  FOREIGN KEY(preset_id, preset_version) REFERENCES preset_versions(preset_id, version)
) WITHOUT ROWID;
CREATE INDEX preset_scores_rank ON preset_scores(preset_id, preset_version, sort_priority DESC, hn_id DESC);

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL COLLATE NOCASE UNIQUE,
  password_hash TEXT NOT NULL,
  email TEXT,
  email_verified INTEGER NOT NULL DEFAULT 0 CHECK (email_verified IN (0, 1)),
  created_at INTEGER NOT NULL,
  disabled INTEGER NOT NULL DEFAULT 0 CHECK (disabled IN (0, 1))
);
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX sessions_user ON sessions(user_id);
CREATE TABLE recovery_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER,
  consumed_at INTEGER
);
CREATE INDEX recovery_tokens_user ON recovery_tokens(user_id);
CREATE TABLE private_profiles (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  current_version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  UNIQUE(user_id, id)
);
CREATE TABLE private_profile_versions (
  profile_id TEXT NOT NULL REFERENCES private_profiles(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  original_text TEXT NOT NULL,
  compiled_json TEXT NOT NULL CHECK (json_valid(compiled_json)),
  status TEXT NOT NULL CHECK (status IN ('draft', 'ready', 'unsupported', 'failed')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY(profile_id, version)
) WITHOUT ROWID;
CREATE TABLE private_evaluations (
  user_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  profile_version INTEGER NOT NULL,
  analysis_id TEXT NOT NULL REFERENCES article_analyses(id),
  condition_hash TEXT NOT NULL,
  result_json TEXT NOT NULL CHECK (json_valid(result_json)),
  evaluated_at INTEGER NOT NULL,
  PRIMARY KEY(user_id, profile_id, profile_version, analysis_id, condition_hash),
  FOREIGN KEY(user_id, profile_id) REFERENCES private_profiles(user_id, id) ON DELETE CASCADE,
  FOREIGN KEY(profile_id, profile_version) REFERENCES private_profile_versions(profile_id, version) ON DELETE CASCADE
) WITHOUT ROWID;
CREATE TABLE user_item_state (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  hn_id INTEGER NOT NULL,
  hidden INTEGER NOT NULL DEFAULT 0 CHECK (hidden IN (0, 1)),
  saved INTEGER NOT NULL DEFAULT 0 CHECK (saved IN (0, 1)),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(user_id, hn_id)
) WITHOUT ROWID;
-- hn_id deliberately has no foreign key here: bookmarks may outlive the HN metadata cache.

CREATE TABLE feed_snapshots (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL CHECK (scope IN ('hn', 'preset', 'private')),
  owner_user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  profile_id TEXT,
  profile_version INTEGER,
  rule_key TEXT NOT NULL,
  object_key TEXT NOT NULL UNIQUE,
  candidate_cutoff_at INTEGER NOT NULL,
  item_count INTEGER NOT NULL,
  coverage_json TEXT NOT NULL CHECK (json_valid(coverage_json)),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  CHECK ((scope = 'private' AND owner_user_id IS NOT NULL AND profile_id IS NOT NULL AND profile_version IS NOT NULL)
      OR (scope <> 'private' AND owner_user_id IS NULL AND profile_id IS NULL AND profile_version IS NULL)),
  FOREIGN KEY(owner_user_id, profile_id) REFERENCES private_profiles(user_id, id) ON DELETE CASCADE,
  FOREIGN KEY(profile_id, profile_version) REFERENCES private_profile_versions(profile_id, version) ON DELETE CASCADE
);
CREATE INDEX feed_snapshots_expiry ON feed_snapshots(expires_at);
CREATE TABLE feed_heads (
  scope_key TEXT PRIMARY KEY,
  snapshot_id TEXT NOT NULL REFERENCES feed_snapshots(id) ON DELETE CASCADE,
  updated_at INTEGER NOT NULL
);

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  dedupe_key TEXT NOT NULL UNIQUE,
  job_type TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  state TEXT NOT NULL CHECK (state IN ('pending', 'queued', 'running', 'retry', 'done', 'dead')),
  attempts INTEGER NOT NULL DEFAULT 0,
  available_at INTEGER NOT NULL,
  lease_owner TEXT,
  lease_until INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX jobs_due ON jobs(state, available_at);
CREATE TABLE sync_state (
  state_key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL CHECK (json_valid(value_json)),
  updated_at INTEGER NOT NULL
);
CREATE TABLE budgets (
  scope_key TEXT NOT NULL,
  utc_day TEXT NOT NULL,
  resource TEXT NOT NULL,
  quota INTEGER NOT NULL CHECK (quota >= 0),
  reserved INTEGER NOT NULL DEFAULT 0 CHECK (reserved >= 0),
  used INTEGER NOT NULL DEFAULT 0 CHECK (used >= 0),
  PRIMARY KEY(scope_key, utc_day, resource),
  CHECK (used + reserved <= quota)
) WITHOUT ROWID;
CREATE TABLE budget_reservations (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  utc_day TEXT NOT NULL,
  resource TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK (amount > 0),
  actual INTEGER,
  state TEXT NOT NULL CHECK (state IN ('reserved', 'settled', 'released', 'uncertain')),
  created_at INTEGER NOT NULL,
  UNIQUE(job_id, scope_key, utc_day, resource),
  FOREIGN KEY(scope_key, utc_day, resource) REFERENCES budgets(scope_key, utc_day, resource)
);
