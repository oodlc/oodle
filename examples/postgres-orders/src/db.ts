// The service's data layer: a pg pool on DATABASE_URL, as in production.
import pg from 'pg';

export const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
