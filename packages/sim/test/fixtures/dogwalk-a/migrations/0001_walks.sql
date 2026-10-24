CREATE TABLE walks (
  id TEXT PRIMARY KEY,
  seq INTEGER NOT NULL,
  owner_id TEXT NOT NULL REFERENCES users(id),
  walker_id TEXT NOT NULL REFERENCES users(id),
  starts_at TEXT NOT NULL,
  minutes INTEGER NOT NULL CHECK (minutes IN (30, 60)),
  price_cents INTEGER NOT NULL,
  status TEXT NOT NULL,
  charged_cents INTEGER NOT NULL DEFAULT 0,
  rating INTEGER,
  created_at TEXT NOT NULL
);

CREATE TABLE availability (
  walker_id TEXT PRIMARY KEY REFERENCES users(id),
  from_time TEXT NOT NULL,
  to_time TEXT NOT NULL
);
