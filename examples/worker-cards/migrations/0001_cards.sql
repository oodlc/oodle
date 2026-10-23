CREATE TABLE cards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('live', 'queued', 'draft', 'killed'))
);
CREATE TABLE signups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE
);
INSERT INTO cards (title, status) VALUES ('Welcome to Cards', 'live');
