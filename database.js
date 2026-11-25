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

    CREATE TABLE IF NOT EXISTS managers (
      id BIGSERIAL PRIMARY KEY,
      full_name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS managers_full_name_lower_idx
      ON managers (lower(full_name));

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

    CREATE TABLE IF NOT EXISTS manager_logins (
      manager_id BIGINT PRIMARY KEY REFERENCES managers(id) ON DELETE CASCADE,
      session_id TEXT NOT NULL UNIQUE,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS subjects (
      id BIGSERIAL PRIMARY KEY,
      teacher_id BIGINT NOT NULL REFERENCES teachers(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      classroom_latitude DOUBLE PRECISION,
      classroom_longitude DOUBLE PRECISION,
      geofence_radius_meters INTEGER NOT NULL DEFAULT 100
        CHECK (geofence_radius_meters BETWEEN 10 AND 5000),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (teacher_id, name),
      CHECK ((classroom_latitude IS NULL) = (classroom_longitude IS NULL)),
      CHECK (classroom_latitude IS NULL OR classroom_latitude BETWEEN -90 AND 90),
      CHECK (classroom_longitude IS NULL OR classroom_longitude BETWEEN -180 AND 180)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS subjects_teacher_name_lower_idx
      ON subjects (teacher_id, lower(name));

    CREATE TABLE IF NOT EXISTS subject_students (
      subject_id BIGINT NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
      student_id BIGINT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
      enrolled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (subject_id, student_id)
    );

    CREATE TABLE IF NOT EXISTS teaching_sessions (
      id BIGSERIAL PRIMARY KEY,
      subject_id BIGINT NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
      join_token_hash TEXT NOT NULL UNIQUE,
      started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      ended_at TIMESTAMPTZ
    );
    CREATE UNIQUE INDEX IF NOT EXISTS teaching_sessions_one_active_subject_idx
      ON teaching_sessions (subject_id) WHERE ended_at IS NULL;

    CREATE TABLE IF NOT EXISTS attendance_events (
      id BIGSERIAL PRIMARY KEY,
      session_id BIGINT NOT NULL REFERENCES teaching_sessions(id) ON DELETE CASCADE,
      student_id BIGINT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
      recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      latitude DOUBLE PRECISION,
      longitude DOUBLE PRECISION,
      accuracy_meters DOUBLE PRECISION,
      status TEXT NOT NULL CHECK (status IN ('inside', 'outside', 'unavailable')),
      detail TEXT,
      CHECK ((latitude IS NULL) = (longitude IS NULL))
    );
    CREATE INDEX IF NOT EXISTS attendance_events_session_student_time_idx
      ON attendance_events (session_id, student_id, recorded_at DESC);

    CREATE TABLE IF NOT EXISTS gps_check_requests (
      id BIGSERIAL PRIMARY KEY,
      session_id BIGINT NOT NULL REFERENCES teaching_sessions(id) ON DELETE CASCADE,
      student_id BIGINT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
      teacher_id BIGINT NOT NULL REFERENCES teachers(id) ON DELETE CASCADE,
      source TEXT NOT NULL DEFAULT 'teacher-requested'
        CHECK (source IN ('automatic', 'student-manual', 'teacher-requested', 'legacy')),
      requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      dispatched_at TIMESTAMPTZ,
      completed_at TIMESTAMPTZ,
      accuracy_meters DOUBLE PRECISION CHECK (accuracy_meters IS NULL OR accuracy_meters >= 0),
      attendance_event_id BIGINT UNIQUE REFERENCES attendance_events(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'checking', 'inside', 'outside', 'unavailable')),
      detail TEXT
    );
    ALTER TABLE gps_check_requests
      ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'teacher-requested';
    ALTER TABLE gps_check_requests
      ADD COLUMN IF NOT EXISTS accuracy_meters DOUBLE PRECISION;
    ALTER TABLE gps_check_requests
      ADD COLUMN IF NOT EXISTS attendance_event_id BIGINT UNIQUE REFERENCES attendance_events(id) ON DELETE CASCADE;
    CREATE INDEX IF NOT EXISTS gps_check_requests_session_student_idx
      ON gps_check_requests (session_id, student_id, id DESC);
    INSERT INTO gps_check_requests
      (session_id, student_id, teacher_id, source, requested_at, dispatched_at,
       completed_at, accuracy_meters, attendance_event_id, status, detail)
    SELECT event.session_id, event.student_id, sb.teacher_id, 'legacy',
      event.recorded_at, event.recorded_at, event.recorded_at, event.accuracy_meters,
      event.id, event.status, event.detail
    FROM attendance_events event
    JOIN teaching_sessions ts ON ts.id = event.session_id
    JOIN subjects sb ON sb.id = ts.subject_id
    WHERE NOT EXISTS (
      SELECT 1 FROM gps_check_requests pulse WHERE pulse.attendance_event_id = event.id
    )
      AND NOT EXISTS (
        SELECT 1 FROM gps_check_requests pulse
        WHERE pulse.session_id = event.session_id AND pulse.student_id = event.student_id
          AND pulse.status = event.status
          AND pulse.completed_at BETWEEN event.recorded_at - INTERVAL '2 minutes'
            AND event.recorded_at + INTERVAL '2 minutes'
    );

    CREATE TABLE IF NOT EXISTS attendance_adjustments (
      id BIGSERIAL PRIMARY KEY,
      session_id BIGINT NOT NULL REFERENCES teaching_sessions(id) ON DELETE CASCADE,
      student_id BIGINT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
      teacher_id BIGINT NOT NULL REFERENCES teachers(id),
      status TEXT NOT NULL CHECK (status IN ('inside', 'outside', 'unavailable')),
      reason TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS attendance_adjustments_session_student_time_idx
      ON attendance_adjustments (session_id, student_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS polls (
      id BIGSERIAL PRIMARY KEY,
      session_id BIGINT NOT NULL REFERENCES teaching_sessions(id) ON DELETE CASCADE,
      prompt TEXT NOT NULL,
      closed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS poll_options (
      id BIGSERIAL PRIMARY KEY,
      poll_id BIGINT NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
      label TEXT NOT NULL,
      UNIQUE (poll_id, label)
    );
    CREATE TABLE IF NOT EXISTS poll_votes (
      id BIGSERIAL PRIMARY KEY,
      poll_id BIGINT NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
      option_id BIGINT NOT NULL REFERENCES poll_options(id) ON DELETE CASCADE,
      student_id BIGINT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (poll_id, student_id)
    );

    CREATE TABLE IF NOT EXISTS discussion_items (
      id BIGSERIAL PRIMARY KEY,
      session_id BIGINT NOT NULL REFERENCES teaching_sessions(id) ON DELETE CASCADE,
      student_id BIGINT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
      visibility TEXT NOT NULL CHECK (visibility IN ('class', 'private_to_teacher')),
      body TEXT NOT NULL,
      dedupe_key TEXT NOT NULL,
      teacher_reply TEXT,
      moderated_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (student_id, dedupe_key)
    );

    CREATE TABLE IF NOT EXISTS live_chat_messages (
      id BIGSERIAL PRIMARY KEY,
      session_id BIGINT NOT NULL REFERENCES teaching_sessions(id) ON DELETE CASCADE,
      author_type TEXT NOT NULL CHECK (author_type IN ('teacher', 'student')),
      teacher_id BIGINT REFERENCES teachers(id) ON DELETE SET NULL,
      student_id BIGINT REFERENCES students(id) ON DELETE SET NULL,
      author_name TEXT NOT NULL,
      body TEXT NOT NULL CHECK (char_length(body) BETWEEN 1 AND 1000),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK (
        (author_type = 'teacher' AND student_id IS NULL)
        OR (author_type = 'student' AND teacher_id IS NULL)
      )
    );
    CREATE INDEX IF NOT EXISTS live_chat_messages_session_id_idx
      ON live_chat_messages (session_id, id);

    CREATE TABLE IF NOT EXISTS class_summaries (
      id BIGSERIAL PRIMARY KEY,
      session_id BIGINT NOT NULL REFERENCES teaching_sessions(id) ON DELETE CASCADE,
      transcript TEXT NOT NULL,
      summary TEXT,
      status TEXT NOT NULL CHECK (status IN ('pending', 'ready', 'failed')),
      provider TEXT NOT NULL DEFAULT 'openai',
      model TEXT,
      approved_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS assignments (
      id BIGSERIAL PRIMARY KEY,
      subject_id BIGINT NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      instructions TEXT NOT NULL,
      due_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS submissions (
      id BIGSERIAL PRIMARY KEY,
      assignment_id BIGINT NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
      student_id BIGINT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
      content TEXT NOT NULL,
      submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (assignment_id, student_id)
    );
    CREATE TABLE IF NOT EXISTS submission_reviews (
      submission_id BIGINT PRIMARY KEY REFERENCES submissions(id) ON DELETE CASCADE,
      feedback TEXT,
      similarity JSONB NOT NULL DEFAULT '[]'::jsonb,
      status TEXT NOT NULL CHECK (status IN ('pending', 'ready', 'failed')),
      provider TEXT NOT NULL DEFAULT 'openai',
      model TEXT,
      generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

module.exports = { initializeDatabase, pool };
