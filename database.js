const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL must be set.');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined,
});

async function initializeDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS teachers (
      id BIGSERIAL PRIMARY KEY,
      full_name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS teachers_full_name_lower_idx
      ON teachers (lower(full_name));

    CREATE TABLE IF NOT EXISTS students (
      id BIGSERIAL PRIMARY KEY,
      full_name TEXT NOT NULL,
      email TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS students_email_lower_idx
      ON students (lower(email));

    CREATE TABLE IF NOT EXISTS teacher_logins (
      teacher_id BIGINT PRIMARY KEY REFERENCES teachers(id) ON DELETE CASCADE,
      session_id TEXT NOT NULL UNIQUE,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS class_sessions (
      teacher_id BIGINT PRIMARY KEY REFERENCES teachers(id) ON DELETE CASCADE,
      token TEXT NOT NULL UNIQUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

module.exports = { initializeDatabase, pool };
