-- Persona users. The runtime reads the signed-in user from here; the simulation seeds it from journey fixtures.
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  persona TEXT NOT NULL,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  data TEXT NOT NULL DEFAULT '{}'
);
