-- The remote inbox. Section 10.2 of docs/implementation-guide.md, plus what ADR 0031 adds:
-- gaps.note / answer_id / created_at, the conflicts table and a few indexes.

CREATE TABLE projects (
  id TEXT PRIMARY KEY,                 -- slug, matches oodle.config.yaml remote.project
  name TEXT NOT NULL,
  repo_url TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE members (
  project_id TEXT NOT NULL REFERENCES projects(id),
  email TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner','answerer','viewer')),
  PRIMARY KEY (project_id, email)
);
CREATE INDEX members_email ON members(email);

CREATE TABLE tokens (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  hash TEXT NOT NULL,                  -- SHA-256 of the token, never the token
  label TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE UNIQUE INDEX tokens_hash ON tokens(hash);

CREATE TABLE gaps (
  project_id TEXT NOT NULL REFERENCES projects(id),
  id TEXT NOT NULL,                    -- gapId from the CLI, stable
  content_hash TEXT NOT NULL,          -- hash of the gap file minus answer fields
  status TEXT NOT NULL,                -- open | answered | dismissed | applied | superseded
  route TEXT NOT NULL,
  tier TEXT NOT NULL,
  kind TEXT NOT NULL,
  question TEXT NOT NULL,
  body_json TEXT NOT NULL,             -- full gap file as JSON
  spec_hash TEXT NOT NULL,
  intent_id TEXT,                      -- when raised by an intent review
  answer_id TEXT,                      -- the answer that currently stands, if any
  note TEXT,                           -- why the gap was reopened, shown to people
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, id)
);
CREATE INDEX gaps_open ON gaps(project_id, status, route);
CREATE INDEX gaps_intent ON gaps(project_id, intent_id);

CREATE TABLE answers (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  gap_id TEXT NOT NULL,
  answer_json TEXT NOT NULL,           -- { option | text + target | dont_care | dismiss }
  answered_by TEXT NOT NULL,           -- person:<email> (from Access) or agent:<id>
  answered_at TEXT NOT NULL,
  seq INTEGER NOT NULL,                -- per-project monotonic, the sync cursor
  applied_sha TEXT,
  acked_at TEXT,
  FOREIGN KEY (project_id, gap_id) REFERENCES gaps(project_id, id)
);
CREATE UNIQUE INDEX answers_seq ON answers(project_id, seq);
CREATE INDEX answers_gap ON answers(project_id, gap_id);

-- A second person's answer to a gap someone else already answered (section 8.5).
-- It does not count until the person whose answer stands takes it.
CREATE TABLE conflicts (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  gap_id TEXT NOT NULL,
  answer_json TEXT NOT NULL,
  answered_by TEXT NOT NULL,
  answered_at TEXT NOT NULL,
  against_answer_id TEXT NOT NULL,     -- the answer that stood when this one arrived
  resolution TEXT CHECK (resolution IN ('kept','taken')),
  resolved_by TEXT,
  resolved_at TEXT,
  FOREIGN KEY (project_id, gap_id) REFERENCES gaps(project_id, id)
);
CREATE INDEX conflicts_open ON conflicts(project_id, gap_id, resolved_at);

CREATE TABLE intents (
  project_id TEXT NOT NULL,
  id TEXT NOT NULL,
  status TEXT NOT NULL,
  body_json TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, id)
);

CREATE TABLE approvals (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  intent_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,          -- approval binds to exact intent content
  decision TEXT NOT NULL CHECK (decision IN ('approve','reject')),
  by_email TEXT NOT NULL,
  at TEXT NOT NULL,
  note TEXT,
  seq INTEGER NOT NULL
);
CREATE UNIQUE INDEX approvals_seq ON approvals(project_id, seq);
CREATE INDEX approvals_intent ON approvals(project_id, intent_id);

CREATE TABLE events (                  -- append-only audit log
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  at TEXT NOT NULL,
  actor TEXT NOT NULL,
  type TEXT NOT NULL,
  data_json TEXT NOT NULL
);
CREATE INDEX events_project ON events(project_id, at);

CREATE TABLE counters (project_id TEXT PRIMARY KEY, seq INTEGER NOT NULL);
