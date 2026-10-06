-- An ordinary migration, as any migrations tool would write it.
CREATE TABLE plans (
  id text PRIMARY KEY,
  discount_percent integer NOT NULL DEFAULT 0
);

CREATE TABLE users (
  id text PRIMARY KEY,
  email text NOT NULL UNIQUE,
  plan text NOT NULL REFERENCES plans(id) DEFAULT 'free'
);

CREATE TABLE orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL REFERENCES users(id),
  amount_cents integer NOT NULL CHECK (amount_cents > 0),
  charge_id text,
  status text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now()
);
