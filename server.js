require('dotenv').config();

const crypto = require('node:crypto');
const path = require('node:path');
const bcrypt = require('bcryptjs');
const express = require('express');
const session = require('express-session');
const { rateLimit } = require('express-rate-limit');
const PgSession = require('connect-pg-simple')(session);
const QRCode = require('qrcode');
const { initializeDatabase, pool } = require('./database');
const { validateAccountPassword } = require('./accounts');
const { Manager, Teacher, Student, Subject, evaluateLocation } = require('./models');
const { generateText } = require('./services/openai');
const { similarityDetails } = require('./similarity');
const { attendanceStatus } = require('./attendance');

const app = express();
const port = Number(process.env.PORT) || 3000;
const maximumAccuracyMeters = process.env.GPS_MAX_ACCURACY_METERS === undefined
  ? 100 : Number(process.env.GPS_MAX_ACCURACY_METERS);

if (!Number.isFinite(maximumAccuracyMeters) || maximumAccuracyMeters < 1 || maximumAccuracyMeters > 5000) {
  throw new Error('GPS_MAX_ACCURACY_METERS must be between 1 and 5000.');
}

if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32) {
  throw new Error('SESSION_SECRET must be set to at least 32 characters.');
}

app.set('trust proxy', 1);
app.use(express.urlencoded({ extended: false, limit: '250kb' }));
app.use(express.json({ limit: '250kb' }));
app.use((req, res, next) => {
  if (['POST', 'PUT', 'PATCH'].includes(req.method)
    && (!req.body || typeof req.body !== 'object' || Array.isArray(req.body))) {
    if (req.is('application/json')) return res.status(400).json({ error: 'Expected a JSON object request body.' });
    return res.status(400).send('Expected a form request body.');
  }
  next();
});
app.use(express.static(path.join(__dirname, 'public'), { fallthrough: true }));
app.use(session({
  store: new PgSession({
    pool,
    tableName: 'web_sessions',
    createTableIfMissing: true,
  }),
  name: 'classteachweb.sid',
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'strict',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 8 * 60 * 60 * 1000,
  },
}));
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
});

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character]);
}

function renderPage(title, content, csrfToken = '', liveSessionId = '', checkinsEnabled = false, studentId = '') {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="csrf-token" content="${escapeHtml(csrfToken)}">
    <title>${escapeHtml(title)}</title>
    <style>
      :root { color-scheme: light; font: 16px system-ui, sans-serif; color: #172033; background: #f5f7fb; }
      body { margin: 0 auto; max-width: 62rem; padding: 1.25rem; }
      main { background: white; border: 1px solid #dce2ed; border-radius: .75rem; padding: 1.25rem; }
      h1, h2, h3 { line-height: 1.2; }
      section, article { border-top: 1px solid #dce2ed; margin-top: 1.5rem; padding-top: 1rem; }
      label { display: block; font-weight: 600; margin: .55rem 0 .25rem; }
      input, select, textarea { box-sizing: border-box; font: inherit; margin: .25rem 0 .75rem; max-width: 38rem; padding: .5rem; width: 100%; }
      input[type=checkbox], input[type=radio] { margin-right: .4rem; width: auto; }
      button { cursor: pointer; font: inherit; margin: .3rem .3rem .3rem 0; padding: .55rem .85rem; }
      table { border-collapse: collapse; display: block; max-width: 100%; overflow-x: auto; width: 100%; }
      th, td { border-bottom: 1px solid #dce2ed; padding: .5rem; text-align: left; vertical-align: top; }
      img { height: auto; max-width: 100%; }
      .muted { color: #505b70; }
      .status { font-weight: 700; }
      .notice { background: #fff7da; border-left: 4px solid #b77900; padding: .75rem; }
      .grid { display: grid; gap: .75rem; grid-template-columns: repeat(auto-fit, minmax(15rem, 1fr)); }
      .actions { display: flex; flex-wrap: wrap; gap: .35rem; }
      .inline { display: inline-block; }
      [role=status], [role=alert] { min-height: 1.5em; }
    </style>
  </head>
  <body data-live-session="${escapeHtml(liveSessionId)}" data-student-id="${escapeHtml(studentId)}" data-checkins-enabled="${checkinsEnabled}">
    <main>${content}</main><script src="/student.js" defer></script>
  </body>
</html>`;
}

function csrfTokenFor(req) {
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(32).toString('hex');
  }
  return req.session.csrfToken;
}

function validCsrfToken(req) {
  const expected = req.session.csrfToken;
  const provided = req.body?.csrfToken;
  if (typeof expected !== 'string' || typeof provided !== 'string') return false;
  const expectedBuffer = Buffer.from(expected);
  const providedBuffer = Buffer.from(provided);
  return expectedBuffer.length === providedBuffer.length
    && crypto.timingSafeEqual(expectedBuffer, providedBuffer);
}

function requireCsrf(req, res, next) {
  if (!validCsrfToken(req)) {
    if (req.is('application/json')) return res.status(403).json({ error: 'The form expired. Reload the page and try again.' });
    return res.status(403).send('The form expired. Please reload and try again.');
  }
  next();
}

async function requireTeacher(req, res, next) {
  if (!req.session.teacherId) return res.redirect('/login');
  try {
    const result = await pool.query(
      'SELECT 1 FROM teacher_logins WHERE teacher_id = $1 AND session_id = $2',
      [req.session.teacherId, req.sessionID],
    );
    if (result.rowCount !== 1) {
      return req.session.destroy((error) => {
        if (error) return next(error);
        res.clearCookie('classteachweb.sid');
        res.redirect('/login');
      });
    }
    next();
  } catch (error) {
    next(error);
  }
}

async function requireManager(req, res, next) {
  if (!req.session.managerId) return res.redirect('/manager/login');
  try {
    const result = await pool.query(
      'SELECT 1 FROM manager_logins WHERE manager_id = $1 AND session_id = $2',
      [req.session.managerId, req.sessionID],
    );
    if (result.rowCount !== 1) {
      return req.session.destroy((error) => {
        if (error) return next(error);
        res.clearCookie('classteachweb.sid');
        res.redirect('/manager/login');
      });
    }
    next();
  } catch (error) {
    next(error);
  }
}

function requireStudent(req, res, next) {
  if (!req.session.studentId || !req.session.teachingSessionId) {
    return res.status(401).json({ error: 'Scan your class QR code and select your roster entry first.' });
  }
  next();
}

async function getOwnedSubject(teacherId, subjectId) {
  const result = await pool.query(
    'SELECT * FROM subjects WHERE id = $1 AND teacher_id = $2',
    [subjectId, teacherId],
  );
  return result.rows[0] || null;
}

function formCsrf(token) {
  return `<input type="hidden" name="csrfToken" value="${escapeHtml(token)}">`;
}

function teacherNavigation(name, token) {
  return `<header><p><a href="/teacher">ClassTeachWeb</a> · Signed in as ${escapeHtml(name)}</p>
    <form class="inline" method="post" action="/logout">${formCsrf(token)}<button type="submit">Log out</button></form></header>`;
}

function managerNavigation(name, token) {
  return `<header><p><a href="/manager">ClassTeachWeb management</a> · Signed in as ${escapeHtml(name)}</p>
    <form class="inline" method="post" action="/manager/logout">${formCsrf(token)}<button type="submit">Log out</button></form></header>`;
}

function values(value) {
  return Array.isArray(value) ? value : value === undefined ? [] : [value];
}

function validId(value) {
  const text = String(value);
  if (text.length > 19 || !/^[1-9]\d*$/.test(text)) return false;
  try {
    return BigInt(text) <= 9223372036854775807n;
  } catch {
    return false;
  }
}

function csvCell(value) {
  let text = String(value ?? '');
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

async function getAttendanceRows(sessionId) {
  const result = await pool.query(
    `SELECT st.id AS student_id, st.full_name, st.email,
       first_event.first_at, latest.recorded_at, latest.status AS event_status,
       latest.accuracy_meters, adjustment.status AS adjustment_status,
       adjustment.created_at AS adjustment_at, adjustment.reason, adjustment.teacher_name
     FROM teaching_sessions ts
     JOIN subjects sb ON sb.id = ts.subject_id
     JOIN subject_students ss ON ss.subject_id = sb.id
     JOIN students st ON st.id = ss.student_id
     LEFT JOIN LATERAL (
       SELECT MIN(recorded_at) AS first_at FROM attendance_events
       WHERE session_id = ts.id AND student_id = st.id
     ) first_event ON TRUE
     LEFT JOIN LATERAL (
       SELECT recorded_at, status, accuracy_meters FROM attendance_events
       WHERE session_id = ts.id AND student_id = st.id
       ORDER BY recorded_at DESC, id DESC LIMIT 1
     ) latest ON TRUE
     LEFT JOIN LATERAL (
       SELECT aa.status, aa.created_at, aa.reason, t.full_name AS teacher_name
       FROM attendance_adjustments aa JOIN teachers t ON t.id = aa.teacher_id
       WHERE aa.session_id = ts.id AND aa.student_id = st.id
       ORDER BY aa.created_at DESC, aa.id DESC LIMIT 1
     ) adjustment ON TRUE
     WHERE ts.id = $1
     ORDER BY lower(st.full_name)`,
    [sessionId],
  );
  return result.rows.map((row) => ({ ...row, ...attendanceStatus(row) }));
}

function renderAttendanceTable(rows, subjectSessionId, csrfToken) {
  if (rows.length === 0) return '<p>No students are enrolled in this subject yet.</p>';
  return `<table><thead><tr><th>Student</th><th>Status</th><th>First check-in</th><th>Last evidence</th><th>Accuracy</th><th>Teacher correction</th></tr></thead><tbody>
    ${rows.map((row) => `<tr><td>${escapeHtml(row.full_name)}<br><span class="muted">${escapeHtml(row.email)}</span></td>
      <td class="status">${escapeHtml(row.status)}${row.adjusted
    ? `<br><span class="muted">Teacher correction by ${escapeHtml(row.teacher_name)}: ${escapeHtml(row.reason)}</span>` : ''}</td>
      <td>${row.first_at ? escapeHtml(new Date(row.first_at).toLocaleString()) : '—'}</td>
      <td>${row.at ? escapeHtml(new Date(row.at).toLocaleString()) : '—'}</td>
      <td>${row.accuracy_meters ? `${Math.round(row.accuracy_meters)} m` : '—'}</td>
      <td><form method="post" action="/teacher/sessions/${subjectSessionId}/attendance/${row.student_id}">
        ${formCsrf(csrfToken)}        <select name="status" aria-label="Attendance status for ${escapeHtml(row.full_name)}" required>
          <option value="" selected disabled>Choose status</option>
          <option value="inside">Inside</option><option value="outside">Outside</option><option value="unavailable">Unavailable</option>
        </select><label for="reason-${subjectSessionId}-${row.student_id}">Correction reason</label>
        <input id="reason-${subjectSessionId}-${row.student_id}" name="reason" maxlength="500" required><button>Save correction</button>
      </form></td></tr>`).join('')}
    </tbody></table>`;
}

async function subjectPage(req, res, subject) {
  const token = csrfTokenFor(req);
  const [rosterResult, enrolledResult, sessionsResult, pollsResult, itemsResult,
    assignmentsResult, summariesResult] = await Promise.all([
    pool.query('SELECT id, full_name, email FROM students ORDER BY lower(full_name)'),
    pool.query('SELECT student_id FROM subject_students WHERE subject_id = $1', [subject.id]),
    pool.query('SELECT id, started_at, ended_at FROM teaching_sessions WHERE subject_id = $1 ORDER BY started_at DESC', [subject.id]),
    pool.query(
      `SELECT p.id, p.prompt, p.closed_at, p.session_id,
         json_agg(json_build_object('label', option_counts.label, 'votes', option_counts.votes)
           ORDER BY option_counts.id) AS results,
         SUM(option_counts.votes)::int AS vote_count
       FROM polls p
       JOIN (
         SELECT po.id, po.poll_id, po.label, COUNT(v.id)::int AS votes
         FROM poll_options po LEFT JOIN poll_votes v ON v.option_id = po.id
         GROUP BY po.id
       ) option_counts ON option_counts.poll_id = p.id
       JOIN teaching_sessions ts ON ts.id = p.session_id
       WHERE ts.subject_id = $1 GROUP BY p.id ORDER BY p.created_at DESC LIMIT 20`,
      [subject.id],
    ),
    pool.query(
      `SELECT di.*, st.full_name AS student_name
       FROM discussion_items di JOIN teaching_sessions ts ON ts.id = di.session_id
       JOIN students st ON st.id = di.student_id
       WHERE ts.subject_id = $1 ORDER BY di.created_at DESC LIMIT 100`,
      [subject.id],
    ),
    pool.query('SELECT * FROM assignments WHERE subject_id = $1 ORDER BY created_at DESC', [subject.id]),
    pool.query(
      `SELECT cs.*, ts.started_at FROM class_summaries cs
       JOIN teaching_sessions ts ON ts.id = cs.session_id
       WHERE ts.subject_id = $1 ORDER BY cs.created_at DESC LIMIT 20`,
      [subject.id],
    ),
  ]);
  const enrolled = new Set(enrolledResult.rows.map((row) => String(row.student_id)));
  const active = sessionsResult.rows.find((row) => !row.ended_at);
  let qrContent = '<p>No active session. Start one to create a QR code.</p>';
  const joinToken = req.session.qrTokens?.[String(subject.id)];
  if (active && joinToken) {
    const baseUrl = process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || `${req.protocol}://${req.get('host')}`;
    const joinUrl = new URL(`/join/${joinToken}`, baseUrl).toString();
    const qr = await QRCode.toDataURL(joinUrl, { errorCorrectionLevel: 'M', margin: 2, width: 320 });
    qrContent = `<p>Students scan this code to join <strong>${escapeHtml(subject.name)}</strong>.</p>
      <img src="${qr}" alt="QR code for ${escapeHtml(subject.name)}">
      <p>Join link: <a href="${escapeHtml(joinUrl)}">${escapeHtml(joinUrl)}</a></p>`;
  } else if (active) {
    qrContent = '<p>The previous browser no longer has the QR link. Create a replacement code to continue.</p>';
  }

  const attendanceContent = sessionsResult.rows.length
    ? (await Promise.all(sessionsResult.rows.map(async (classSession) => {
      const rows = await getAttendanceRows(classSession.id);
      return `<details id="attendance-session-${classSession.id}" ${String(classSession.id) === String(active?.id) ? 'open' : ''}>
        <summary>${escapeHtml(new Date(classSession.started_at).toLocaleString())} — ${classSession.ended_at ? 'ended' : 'active'}</summary>
        <p><a href="/teacher/sessions/${classSession.id}/attendance.csv">Download saved attendance CSV</a></p>
        ${renderAttendanceTable(rows, classSession.id, token)}
      </details>`;
    }))).join('')
    : '<p>Start a session to collect attendance.</p>';
  const allStudents = rosterResult.rows.length
    ? rosterResult.rows.map((student) => `<label><input type="checkbox" name="studentIds" value="${student.id}" ${enrolled.has(String(student.id)) ? 'checked' : ''}>
        ${escapeHtml(student.full_name)} (${escapeHtml(student.email)})</label>`).join('')
    : '<p>Add students using the roster importer before enrolling them.</p>';
  const polls = pollsResult.rows.map((poll) => `<li>${escapeHtml(poll.prompt)} — ${poll.vote_count} votes ${poll.closed_at ? '(closed)' : ''}
    <ul>${(poll.results || []).map((result) => `<li>${escapeHtml(result.label)}: ${result.votes}</li>`).join('')}</ul>
    ${!poll.closed_at ? `<form class="inline" method="post" action="/teacher/polls/${poll.id}/close">${formCsrf(token)}<button>Close poll</button></form>` : ''}</li>`).join('');
  const discussions = itemsResult.rows.map((item) => `<article><p><strong>${escapeHtml(item.student_name)}</strong>
    · ${escapeHtml(item.visibility)} · ${escapeHtml(new Date(item.created_at).toLocaleString())}</p>
    <p>${escapeHtml(item.body)}</p>${item.teacher_reply ? `<p><strong>Teacher reply:</strong> ${escapeHtml(item.teacher_reply)}</p>` : ''}
    <form method="post" action="/teacher/discussion/${item.id}">${formCsrf(token)}
      <label for="reply-${item.id}">Teacher reply</label><textarea id="reply-${item.id}" name="reply" maxlength="3000">${escapeHtml(item.teacher_reply || '')}</textarea>
      <button name="action" value="reply">Save reply</button>
      ${item.visibility === 'class' ? '<button name="action" value="hide">Hide from class</button>' : ''}
    </form></article>`).join('');
  const assignmentCards = await Promise.all(assignmentsResult.rows.map(async (assignment) => {
    const submissions = await pool.query(
      `SELECT s.id, s.content, s.submitted_at, st.full_name, sr.feedback, sr.status AS review_status, sr.similarity
       FROM submissions s JOIN students st ON st.id = s.student_id
       LEFT JOIN submission_reviews sr ON sr.submission_id = s.id
       WHERE s.assignment_id = $1 ORDER BY s.submitted_at DESC`,
      [assignment.id],
    );
    return `<article><h3>${escapeHtml(assignment.title)}</h3><p>${escapeHtml(assignment.instructions)}</p>
      <p class="muted">Due: ${assignment.due_at ? escapeHtml(new Date(assignment.due_at).toLocaleString()) : 'No deadline'}</p>
      ${submissions.rows.length ? submissions.rows.map((submission) => `<details id="submission-${submission.id}"><summary>${escapeHtml(submission.full_name)} — ${escapeHtml(new Date(submission.submitted_at).toLocaleString())}</summary>
        <p>${escapeHtml(submission.content)}</p>
        ${submission.feedback ? `<p><strong>AI feedback (suggestion, not a grade):</strong> ${escapeHtml(submission.feedback)}</p>` : `<p>AI review: ${escapeHtml(submission.review_status || 'not requested')}</p>`}
        ${Array.isArray(submission.similarity) && submission.similarity.length
    ? `<p>Text similarity review indicators (not a plagiarism finding):</p><ul>${submission.similarity.map((entry) =>
    `<li>${escapeHtml(entry.studentName)} — ${escapeHtml(entry.percent)}% overlap
       <blockquote>Your work: ${escapeHtml(entry.excerpt)}<br>Other work: ${escapeHtml(entry.comparisonExcerpt)}</blockquote></li>`).join('')}</ul>` : ''}
        <form method="post" action="/teacher/submissions/${submission.id}/review" data-ai-processing>${formCsrf(token)}
          <label><input type="checkbox" name="confirmExternalProcessing" required>
            Send this submission and assignment instructions to OpenAI for review.</label>
          <p data-ai-status role="status"></p><button>Generate AI review</button>
        </form></details>`).join('') : '<p>No submissions yet.</p>'}
    </article>`;
  }));
  const summaries = summariesResult.rows.map((summary) => `<article><h3>Summary — ${escapeHtml(new Date(summary.started_at).toLocaleString())}</h3>
    <p>Status: ${escapeHtml(summary.status)}</p>
    ${summary.summary ? `<form method="post" action="/teacher/summaries/${summary.id}/approve">${formCsrf(token)}
      <label for="summary-${summary.id}">Review and edit before students can see it</label><textarea id="summary-${summary.id}" name="summary" maxlength="20000" required>${escapeHtml(summary.summary)}</textarea>
      <button>Approve and publish</button></form>` : ''}
    ${summary.approved_at ? '<p class="status">Published to students</p>' : ''}
    </article>`).join('');
  const sessionOptions = sessionsResult.rows.map((row) =>
    `<option value="${row.id}">${escapeHtml(new Date(row.started_at).toLocaleString())}${row.ended_at ? ' (ended)' : ' (active)'}</option>`).join('');

  res.send(renderPage(`Subject ${subject.name}`, `${teacherNavigation(req.session.teacherName, token)}
    <h1>${escapeHtml(subject.name)}</h1>
    <p><a href="/teacher">Back to subjects</a></p>
    <section><h2>Classroom location</h2>
      <form method="post" action="/teacher/subjects/${subject.id}/location">${formCsrf(token)}
        <label for="latitude">Latitude</label><input id="latitude" name="latitude" type="number" step="any" min="-90" max="90" value="${escapeHtml(subject.classroom_latitude ?? '')}">
        <label for="longitude">Longitude</label><input id="longitude" name="longitude" type="number" step="any" min="-180" max="180" value="${escapeHtml(subject.classroom_longitude ?? '')}">
        <label for="radius">Geofence radius (meters)</label><input id="radius" name="radius" type="number" min="10" max="5000" value="${subject.geofence_radius_meters}" required>
        <button>Save classroom location</button></form>
      <p class="muted">GPS is checked in the student browser while the page is active. A browser cannot read the router MAC address.</p>
    </section>
    <section><h2>Roster</h2><form method="post" action="/teacher/subjects/${subject.id}/enrollments">
      ${formCsrf(token)}<p>Roster selection is demo-only identity verification.</p>${allStudents}<button>Save enrolled students</button>
    </form></section>
    <section><h2>Class session and QR code</h2>${qrContent}
      <form method="post" action="/teacher/subjects/${subject.id}/sessions">${formCsrf(token)}
        <button>${active ? 'Create replacement QR code' : 'Start class and create QR code'}</button>
      </form>
      ${active ? `<form method="post" action="/teacher/sessions/${active.id}/end">${formCsrf(token)}<button>End class session</button></form>` : ''}
    </section>
    <section><h2>Automatically saved attendance</h2>
      <p>Every accepted check-in and teacher correction is saved to PostgreSQL automatically. CSV is a convenience download only.</p>${attendanceContent}
    </section>
    <section><h2>Quick polls</h2>
      ${active ? `<form method="post" action="/teacher/sessions/${active.id}/polls">${formCsrf(token)}
        <label for="poll-prompt">Question</label><input id="poll-prompt" name="prompt" maxlength="500" required>
        <label for="poll-options">Options (one per line, 2–8)</label><textarea id="poll-options" name="options" required></textarea><button>Create poll</button></form>`
    : '<p>Start a session to create polls.</p>'}
      <ul>${polls || '<li>No polls yet.</li>'}</ul>
    </section>
    <section><h2>Questions and suggestions</h2>${discussions || '<p>No submissions yet.</p>'}</section>
    <section><h2>Class summary</h2>
      <p class="notice">The transcript is stored in this app. Generating a summary sends it to OpenAI. Review the generated draft before publishing.</p>
      ${sessionsResult.rows.length ? `<form method="post" action="/teacher/subjects/${subject.id}/summaries" data-ai-processing>${formCsrf(token)}
        <label for="summary-session">Class session</label><select id="summary-session" name="sessionId" required>${sessionOptions}</select>
        <label for="transcript">Class transcript (text only)</label><textarea id="transcript" name="transcript" maxlength="100000" required></textarea>
        <label><input type="checkbox" name="confirmExternalProcessing" required> Send this transcript to OpenAI for summarization.</label>
        <p data-ai-status role="status"></p><button>Generate summary draft</button></form>` : '<p>Start a class session before adding a transcript.</p>'}
      ${summaries || '<p>No summaries yet.</p>'}
    </section>
    <section><h2>Assignments and homework review</h2>
      <p class="notice">Homework text is stored in this app. Generating feedback sends the submission and assignment instructions to OpenAI. Similarity results are review signals, not plagiarism findings.</p>
      <form method="post" action="/teacher/subjects/${subject.id}/assignments" data-local-datetime>${formCsrf(token)}
        <label for="assignment-title">Title</label><input id="assignment-title" name="title" maxlength="150" required>
        <label for="assignment-instructions">Instructions</label><textarea id="assignment-instructions" name="instructions" maxlength="5000" required></textarea>
        <label for="assignment-deadline">Deadline (optional)</label><input id="assignment-deadline" type="datetime-local" name="dueAt"><button>Create assignment</button>
      </form>${assignmentCards.join('') || '<p>No assignments yet.</p>'}
    </section>`, token, active ? String(active.id) : 'teacher-live'));
}

app.get('/', (req, res) => {
  res.send(renderPage('ClassTeachWeb', `<h1>ClassTeachWeb</h1>
    <p>Class tools for attendance, discussion, polls, summaries, and homework feedback.</p>
    <p><a href="/login">Teacher login</a></p>
    <p><a href="/manager/login">Management login</a></p>`));
});

app.get('/manager/login', (req, res) => {
  const token = csrfTokenFor(req);
  const message = req.query.error === '1' ? '<p role="alert">Name or password is incorrect.</p>' : '';
  res.send(renderPage('Management login', `<h1>Management login</h1>${message}
    <form method="post" action="/manager/login">${formCsrf(token)}
      <label for="fullName">Manager full name</label><input id="fullName" name="fullName" autocomplete="username" required>
      <label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required>
      <button>Log in</button></form>
    <p><a href="/login">Teacher login</a></p>`, token));
});

app.post('/manager/login', loginLimiter, requireCsrf, async (req, res, next) => {
  try {
    const fullName = typeof req.body.fullName === 'string' ? req.body.fullName.trim() : '';
    const password = typeof req.body.password === 'string' ? req.body.password : '';
    const result = await pool.query(
      'SELECT id, full_name, password_hash FROM managers WHERE lower(full_name) = lower($1)',
      [fullName],
    );
    const manager = result.rows[0] ? new Manager({
      id: result.rows[0].id,
      fullName: result.rows[0].full_name,
      passwordHash: result.rows[0].password_hash,
    }) : null;
    if (!manager || !(await bcrypt.compare(password, manager.passwordHash))) {
      return res.redirect(303, '/manager/login?error=1');
    }
    req.session.regenerate(async (error) => {
      if (error) return next(error);
      try {
        req.session.managerId = manager.id;
        req.session.managerName = manager.fullName;
        req.session.csrfToken = crypto.randomBytes(32).toString('hex');
        await pool.query(
          `INSERT INTO manager_logins (manager_id, session_id) VALUES ($1, $2)
           ON CONFLICT (manager_id) DO UPDATE SET session_id = EXCLUDED.session_id, updated_at = NOW()`,
          [manager.id, req.sessionID],
        );
        req.session.save((saveError) => {
          if (saveError) return next(saveError);
          res.redirect(303, '/manager');
        });
      } catch (loginError) {
        next(loginError);
      }
    });
  } catch (error) {
    next(error);
  }
});

app.post('/manager/logout', requireManager, requireCsrf, async (req, res, next) => {
  try {
    await pool.query('DELETE FROM manager_logins WHERE manager_id = $1 AND session_id = $2', [
      req.session.managerId,
      req.sessionID,
    ]);
    req.session.destroy((error) => {
      if (error) return next(error);
      res.clearCookie('classteachweb.sid');
      res.redirect(303, '/manager/login');
    });
  } catch (error) {
    next(error);
  }
});

app.get('/manager', requireManager, async (req, res) => {
  const token = csrfTokenFor(req);
  const [teachersResult, studentsResult, subjectsResult, enrollmentsResult] = await Promise.all([
    pool.query('SELECT id, full_name FROM teachers ORDER BY lower(full_name)'),
    pool.query('SELECT id, full_name, email FROM students ORDER BY lower(full_name)'),
    pool.query(
      `SELECT sb.id, sb.name, sb.teacher_id, t.full_name AS teacher_name
       FROM subjects sb JOIN teachers t ON t.id = sb.teacher_id
       ORDER BY lower(sb.name), lower(t.full_name)`,
    ),
    pool.query(
      `SELECT ss.subject_id, st.id AS student_id, st.full_name, st.email
       FROM subject_students ss JOIN students st ON st.id = ss.student_id
       ORDER BY lower(st.full_name)`,
    ),
  ]);
  const enrollmentsBySubject = new Map();
  for (const enrollment of enrollmentsResult.rows) {
    const subjectId = String(enrollment.subject_id);
    if (!enrollmentsBySubject.has(subjectId)) enrollmentsBySubject.set(subjectId, []);
    enrollmentsBySubject.get(subjectId).push(enrollment);
  }

  const teacherOptions = teachersResult.rows.map((teacher) =>
    `<option value="${teacher.id}">${escapeHtml(teacher.full_name)}</option>`).join('');
  const subjectCards = subjectsResult.rows.map((subject) => {
    const subjectId = String(subject.id);
    const enrolled = enrollmentsBySubject.get(subjectId) || [];
    const enrolledIds = new Set(enrolled.map((student) => String(student.student_id)));
    const availableStudents = studentsResult.rows.filter((student) => !enrolledIds.has(String(student.id)));
    const enrollmentList = enrolled.length
      ? `<ul>${enrolled.map((student) => `<li>${escapeHtml(student.full_name)} <span class="muted">${escapeHtml(student.email)}</span></li>`).join('')}</ul>`
      : '<p>No students enrolled.</p>';
    const enrollmentForm = availableStudents.length
      ? `<form method="post" action="/manager/subjects/${subject.id}/enrollments">${formCsrf(token)}
          <label for="students-${subject.id}">Add students</label>
          <select id="students-${subject.id}" name="studentIds" multiple size="5">
            ${availableStudents.map((student) => `<option value="${student.id}">${escapeHtml(student.full_name)} (${escapeHtml(student.email)})</option>`).join('')}
          </select><button type="submit">Enroll selected students</button></form>`
      : '<p>All students are already enrolled.</p>';

    return `<article><h3>${escapeHtml(subject.name)}</h3>
      <p>Currently assigned to ${escapeHtml(subject.teacher_name)}.</p>
      <form method="post" action="/manager/subjects/${subject.id}/teacher">${formCsrf(token)}
        <label for="teacher-${subject.id}">Assign teacher</label>
        <select id="teacher-${subject.id}" name="teacherId" required>
          ${teachersResult.rows.map((teacher) => `<option value="${teacher.id}"${String(teacher.id) === String(subject.teacher_id) ? ' selected' : ''}>${escapeHtml(teacher.full_name)}</option>`).join('')}
        </select><button type="submit">Save teacher</button></form>
      <h4>Enrolled students</h4>${enrollmentList}${enrollmentForm}</article>`;
  }).join('');

  const content = `${managerNavigation(req.session.managerName, token)}
    <h1>Management dashboard</h1>
    <p>Create accounts and subjects, assign teachers, and enroll students. Reassigning a subject changes which teacher can manage it.</p>
    <section><h2>Add a teacher</h2>
      <form method="post" action="/manager/teachers">${formCsrf(token)}
        <label for="teacherName">Full name</label><input id="teacherName" name="fullName" maxlength="120" required>
        <label for="teacherPassword">Initial password (at least 12 characters)</label>
        <input id="teacherPassword" name="password" type="password" minlength="12" maxlength="72" autocomplete="new-password" required>
        <button type="submit">Add teacher</button></form>
      <h3>Current teachers</h3>${teachersResult.rows.length
    ? `<ul>${teachersResult.rows.map((teacher) => `<li>${escapeHtml(teacher.full_name)}</li>`).join('')}</ul>`
    : '<p>No teachers yet.</p>'}</section>
    <section><h2>Add a student</h2>
      <form method="post" action="/manager/students">${formCsrf(token)}
        <label for="studentName">Full name</label><input id="studentName" name="fullName" maxlength="120" required>
        <label for="studentEmail">Email address</label><input id="studentEmail" name="email" type="email" maxlength="254" required>
        <button type="submit">Add student</button></form>
      <h3>Current students</h3>${studentsResult.rows.length
    ? `<ul>${studentsResult.rows.map((student) => `<li>${escapeHtml(student.full_name)} <span class="muted">${escapeHtml(student.email)}</span></li>`).join('')}</ul>`
    : '<p>No students yet.</p>'}</section>
    <section><h2>Add a subject</h2>
      ${teachersResult.rows.length
    ? `<form method="post" action="/manager/subjects">${formCsrf(token)}
        <label for="subjectName">Subject name</label><input id="subjectName" name="name" maxlength="100" required>
        <label for="subjectTeacher">Assign teacher</label><select id="subjectTeacher" name="teacherId" required>${teacherOptions}</select>
        <label for="latitude">Classroom latitude (optional)</label><input id="latitude" name="latitude" type="number" step="any" min="-90" max="90">
        <label for="longitude">Classroom longitude (optional)</label><input id="longitude" name="longitude" type="number" step="any" min="-180" max="180">
        <label for="radius">Geofence radius (meters)</label><input id="radius" name="radius" type="number" min="10" max="5000" value="100" required>
        <button type="submit">Create subject</button></form>`
    : '<p>Add a teacher before creating a subject.</p>'}</section>
    <section><h2>Subjects and connections</h2>${subjectCards || '<p>No subjects yet.</p>'}</section>`;
  res.send(renderPage('Management dashboard', content, token));
});

app.post('/manager/teachers', requireManager, requireCsrf, async (req, res) => {
  let fullName;
  let password;
  try {
    fullName = Teacher.validateName(req.body.fullName);
    password = validateAccountPassword(req.body.password);
  } catch (error) {
    return res.status(400).send(escapeHtml(error.message));
  }
  const duplicate = await pool.query(
    'SELECT 1 FROM teachers WHERE lower(full_name) = lower($1)',
    [fullName],
  );
  if (duplicate.rowCount) return res.status(409).send('A teacher with that name already exists.');
  const passwordHash = await bcrypt.hash(password, 12);
  await pool.query(
    'INSERT INTO teachers (full_name, password_hash) VALUES ($1, $2)',
    [fullName, passwordHash],
  );
  res.redirect(303, '/manager');
});

app.post('/manager/students', requireManager, requireCsrf, async (req, res) => {
  let fullName;
  let email;
  try {
    fullName = Student.validateName(req.body.fullName);
    email = Student.validateEmail(req.body.email).toLocaleLowerCase('en');
  } catch (error) {
    return res.status(400).send(escapeHtml(error.message));
  }
  const duplicate = await pool.query(
    'SELECT 1 FROM students WHERE lower(email) = lower($1)',
    [email],
  );
  if (duplicate.rowCount) return res.status(409).send('A student with that email address already exists.');
  await pool.query('INSERT INTO students (full_name, email) VALUES ($1, $2)', [fullName, email]);
  res.redirect(303, '/manager');
});

app.post('/manager/subjects', requireManager, requireCsrf, async (req, res) => {
  let name;
  let radius;
  try {
    name = Subject.validateName(req.body.name);
    radius = Subject.validateRadius(req.body.radius);
  } catch (error) {
    return res.status(400).send(escapeHtml(error.message));
  }
  const teacherId = String(req.body.teacherId ?? '');
  if (!validId(teacherId)) return res.status(400).send('Choose a valid teacher.');
  const teacher = await pool.query('SELECT 1 FROM teachers WHERE id = $1', [teacherId]);
  if (!teacher.rowCount) return res.status(400).send('Choose an existing teacher.');

  const latitude = req.body.latitude === '' ? null : Number(req.body.latitude);
  const longitude = req.body.longitude === '' ? null : Number(req.body.longitude);
  if ((latitude === null) !== (longitude === null)
    || (latitude !== null && (!Number.isFinite(latitude) || latitude < -90 || latitude > 90))
    || (longitude !== null && (!Number.isFinite(longitude) || longitude < -180 || longitude > 180))) {
    return res.status(400).send('Enter both valid classroom coordinates, or leave both blank.');
  }
  const duplicate = await pool.query(
    'SELECT 1 FROM subjects WHERE teacher_id = $1 AND lower(name) = lower($2)',
    [teacherId, name],
  );
  if (duplicate.rowCount) return res.status(409).send('That teacher already has a subject with this name.');
  await pool.query(
    `INSERT INTO subjects (teacher_id, name, classroom_latitude, classroom_longitude, geofence_radius_meters)
     VALUES ($1, $2, $3, $4, $5)`,
    [teacherId, name, latitude, longitude, radius],
  );
  res.redirect(303, '/manager');
});

app.post('/manager/subjects/:subjectId/teacher', requireManager, requireCsrf, async (req, res) => {
  const subjectId = String(req.params.subjectId);
  const teacherId = String(req.body.teacherId ?? '');
  if (!validId(subjectId)) return res.status(404).send('Subject not found.');
  if (!validId(teacherId)) return res.status(400).send('Choose a valid teacher.');
  const [subject, teacher] = await Promise.all([
    pool.query('SELECT id, name FROM subjects WHERE id = $1', [subjectId]),
    pool.query('SELECT 1 FROM teachers WHERE id = $1', [teacherId]),
  ]);
  if (!subject.rowCount) return res.status(404).send('Subject not found.');
  if (!teacher.rowCount) return res.status(400).send('Choose an existing teacher.');
  const duplicate = await pool.query(
    'SELECT 1 FROM subjects WHERE teacher_id = $1 AND lower(name) = lower($2) AND id <> $3',
    [teacherId, subject.rows[0].name, subjectId],
  );
  if (duplicate.rowCount) return res.status(409).send('That teacher already has a subject with this name.');
  await pool.query('UPDATE subjects SET teacher_id = $1 WHERE id = $2', [teacherId, subjectId]);
  res.redirect(303, '/manager');
});

app.post('/manager/subjects/:subjectId/enrollments', requireManager, requireCsrf, async (req, res) => {
  const subjectId = String(req.params.subjectId);
  if (!validId(subjectId)) return res.status(404).send('Subject not found.');
  const subject = await pool.query('SELECT 1 FROM subjects WHERE id = $1', [subjectId]);
  if (!subject.rowCount) return res.status(404).send('Subject not found.');

  const submittedIds = values(req.body.studentIds).map(String);
  if (submittedIds.some((studentId) => !validId(studentId))) {
    return res.status(400).send('Choose valid students.');
  }
  const studentIds = [...new Set(submittedIds)];
  if (studentIds.length) {
    const students = await pool.query(
      'SELECT id FROM students WHERE id = ANY($1::bigint[])',
      [studentIds],
    );
    if (students.rowCount !== studentIds.length) return res.status(400).send('One or more students no longer exist.');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const studentId of studentIds) {
        await client.query(
          'INSERT INTO subject_students (subject_id, student_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
          [subjectId, studentId],
        );
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  res.redirect(303, '/manager');
});

app.get('/login', (req, res) => {
  const token = csrfTokenFor(req);
  const message = req.query.error === '1' ? '<p role="alert">Name or password is incorrect.</p>' : '';
  res.send(renderPage('Teacher login', `<h1>Teacher login</h1>${message}
    <form method="post" action="/login">${formCsrf(token)}
      <label for="fullName">Full name</label><input id="fullName" name="fullName" autocomplete="username" required>
      <label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required>
      <button>Log in</button></form>`, token));
});

app.post('/login', loginLimiter, requireCsrf, async (req, res, next) => {
  try {
    const fullName = typeof req.body.fullName === 'string' ? req.body.fullName.trim() : '';
    const password = typeof req.body.password === 'string' ? req.body.password : '';
    const result = await pool.query(
      'SELECT id, full_name, password_hash FROM teachers WHERE lower(full_name) = lower($1)',
      [fullName],
    );
    const teacher = result.rows[0] ? new Teacher({
      id: result.rows[0].id,
      fullName: result.rows[0].full_name,
      passwordHash: result.rows[0].password_hash,
    }) : null;
    if (!teacher || !(await bcrypt.compare(password, teacher.passwordHash))) {
      return res.redirect(303, '/login?error=1');
    }
    req.session.regenerate(async (error) => {
      if (error) return next(error);
      try {
        req.session.teacherId = teacher.id;
        req.session.teacherName = teacher.fullName;
        req.session.csrfToken = crypto.randomBytes(32).toString('hex');
        await pool.query(
          `INSERT INTO teacher_logins (teacher_id, session_id) VALUES ($1, $2)
           ON CONFLICT (teacher_id) DO UPDATE SET session_id = EXCLUDED.session_id, updated_at = NOW()`,
          [teacher.id, req.sessionID],
        );
        req.session.save((saveError) => {
          if (saveError) return next(saveError);
          res.redirect(303, '/teacher');
        });
      } catch (loginError) {
        next(loginError);
      }
    });
  } catch (error) {
    next(error);
  }
});

app.post('/logout', requireTeacher, requireCsrf, async (req, res, next) => {
  try {
    await pool.query('DELETE FROM teacher_logins WHERE teacher_id = $1 AND session_id = $2', [
      req.session.teacherId,
      req.sessionID,
    ]);
    req.session.destroy((error) => {
      if (error) return next(error);
      res.clearCookie('classteachweb.sid');
      res.redirect(303, '/login');
    });
  } catch (error) {
    next(error);
  }
});

app.get('/teacher', requireTeacher, async (req, res) => {
  const token = csrfTokenFor(req);
  const subjects = await pool.query(
    'SELECT id, name, created_at FROM subjects WHERE teacher_id = $1 ORDER BY lower(name)',
    [req.session.teacherId],
  );
  res.send(renderPage('Teacher dashboard', `${teacherNavigation(req.session.teacherName, token)}
    <h1>Your subjects</h1>
    <form method="post" action="/teacher/subjects">${formCsrf(token)}
      <label for="name">Subject name</label><input id="name" name="name" maxlength="100" required>
      <label for="latitude">Classroom latitude (optional)</label><input id="latitude" name="latitude" type="number" step="any" min="-90" max="90">
      <label for="longitude">Classroom longitude (optional)</label><input id="longitude" name="longitude" type="number" step="any" min="-180" max="180">
      <label for="radius">Geofence radius (meters)</label><input id="radius" name="radius" type="number" min="10" max="5000" value="100" required>
      <button>Create subject</button></form>
    <section><h2>Manage subjects</h2>${subjects.rows.length ? `<ul>${subjects.rows.map((subject) =>
    `<li><a href="/teacher/subjects/${subject.id}">${escapeHtml(subject.name)}</a></li>`).join('')}</ul>`
    : '<p>No subjects yet. Create one above.</p>'}</section>`, token));
});

app.post('/teacher/subjects', requireTeacher, requireCsrf, async (req, res) => {
  let name;
  let radius;
  try {
    name = Subject.validateName(req.body.name);
    radius = Subject.validateRadius(req.body.radius);
  } catch (error) {
    return res.status(400).send(error.message);
  }
  const latitude = req.body.latitude === '' ? null : Number(req.body.latitude);
  const longitude = req.body.longitude === '' ? null : Number(req.body.longitude);
  if ((latitude === null) !== (longitude === null)
    || (latitude !== null && (!Number.isFinite(latitude) || latitude < -90 || latitude > 90))
    || (longitude !== null && (!Number.isFinite(longitude) || longitude < -180 || longitude > 180))) {
    return res.status(400).send('Enter both valid classroom coordinates, or leave both blank.');
  }
  const duplicate = await pool.query(
    'SELECT 1 FROM subjects WHERE teacher_id = $1 AND lower(name) = lower($2)',
    [req.session.teacherId, name],
  );
  if (duplicate.rowCount) return res.status(409).send('You already have a subject with that name.');
  const result = await pool.query(
    `INSERT INTO subjects (teacher_id, name, classroom_latitude, classroom_longitude, geofence_radius_meters)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [req.session.teacherId, name, latitude, longitude, radius],
  );
  res.redirect(303, `/teacher/subjects/${result.rows[0].id}`);
});

app.get('/teacher/subjects/:subjectId', requireTeacher, async (req, res) => {
  if (!validId(req.params.subjectId)) return res.status(404).send('Subject not found.');
  const subject = await getOwnedSubject(req.session.teacherId, req.params.subjectId);
  if (!subject) return res.status(404).send('Subject not found.');
  await subjectPage(req, res, subject);
});

app.post('/teacher/subjects/:subjectId/location', requireTeacher, requireCsrf, async (req, res) => {
  if (!validId(req.params.subjectId)) return res.status(404).send('Subject not found.');
  const subject = await getOwnedSubject(req.session.teacherId, req.params.subjectId);
  if (!subject) return res.status(404).send('Subject not found.');
  const latitude = req.body.latitude === '' ? null : Number(req.body.latitude);
  const longitude = req.body.longitude === '' ? null : Number(req.body.longitude);
  let radius;
  try {
    radius = Subject.validateRadius(req.body.radius);
  } catch (error) {
    return res.status(400).send(error.message);
  }
  if ((latitude === null) !== (longitude === null)
    || (latitude !== null && (!Number.isFinite(latitude) || latitude < -90 || latitude > 90))
    || (longitude !== null && (!Number.isFinite(longitude) || longitude < -180 || longitude > 180))) {
    return res.status(400).send('Enter both valid classroom coordinates, or leave both blank.');
  }
  await pool.query(
    `UPDATE subjects SET classroom_latitude = $1, classroom_longitude = $2,
       geofence_radius_meters = $3 WHERE id = $4 AND teacher_id = $5`,
    [latitude, longitude, radius, subject.id, req.session.teacherId],
  );
  res.redirect(303, `/teacher/subjects/${subject.id}`);
});

app.post('/teacher/subjects/:subjectId/enrollments', requireTeacher, requireCsrf, async (req, res) => {
  if (!validId(req.params.subjectId)) return res.status(404).send('Subject not found.');
  const subject = await getOwnedSubject(req.session.teacherId, req.params.subjectId);
  if (!subject) return res.status(404).send('Subject not found.');
  const studentIds = [...new Set(values(req.body.studentIds).filter(validId).map(String))];
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      'DELETE FROM subject_students WHERE subject_id = $1 AND NOT (student_id = ANY($2::bigint[]))',
      [subject.id, studentIds],
    );
    for (const studentId of studentIds) {
      await client.query(
        'INSERT INTO subject_students (subject_id, student_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [subject.id, studentId],
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  res.redirect(303, `/teacher/subjects/${subject.id}`);
});

app.post('/teacher/subjects/:subjectId/sessions', requireTeacher, requireCsrf, async (req, res) => {
  if (!validId(req.params.subjectId)) return res.status(404).send('Subject not found.');
  const subject = await getOwnedSubject(req.session.teacherId, req.params.subjectId);
  if (!subject) return res.status(404).send('Subject not found.');
  if (subject.classroom_latitude === null || subject.classroom_longitude === null) {
    return res.status(400).send('Set both classroom coordinates before starting an attendance session.');
  }
  const enrollment = await pool.query(
    'SELECT 1 FROM subject_students WHERE subject_id = $1 LIMIT 1',
    [subject.id],
  );
  if (!enrollment.rowCount) return res.status(400).send('Enroll at least one student before starting the session.');
  const token = crypto.randomBytes(32).toString('base64url');
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE polls SET closed_at = NOW()
       WHERE session_id IN (SELECT id FROM teaching_sessions WHERE subject_id = $1 AND ended_at IS NULL)
         AND closed_at IS NULL`,
      [subject.id],
    );
    await client.query(
      'UPDATE teaching_sessions SET ended_at = NOW() WHERE subject_id = $1 AND ended_at IS NULL',
      [subject.id],
    );
    await client.query(
      'INSERT INTO teaching_sessions (subject_id, join_token_hash) VALUES ($1, $2)',
      [subject.id, hash],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  req.session.qrTokens = { ...(req.session.qrTokens || {}), [String(subject.id)]: token };
  req.session.save((error) => {
    if (error) return res.status(500).send('Could not save the session. Please try again.');
    res.redirect(303, `/teacher/subjects/${subject.id}`);
  });
});

app.post('/teacher/sessions/:sessionId/end', requireTeacher, requireCsrf, async (req, res) => {
  if (!validId(req.params.sessionId)) return res.status(404).send('Session not found.');
  const client = await pool.connect();
  let subjectId;
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `UPDATE teaching_sessions ts SET ended_at = NOW()
       FROM subjects sb WHERE ts.id = $1 AND ts.subject_id = sb.id AND sb.teacher_id = $2
       RETURNING sb.id AS subject_id`,
      [req.params.sessionId, req.session.teacherId],
    );
    if (!result.rowCount) {
      await client.query('ROLLBACK');
      return res.status(404).send('Session not found.');
    }
    subjectId = result.rows[0].subject_id;
    await client.query('UPDATE polls SET closed_at = NOW() WHERE session_id = $1 AND closed_at IS NULL', [
      req.params.sessionId,
    ]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  if (req.session.qrTokens) delete req.session.qrTokens[String(subjectId)];
  res.redirect(303, `/teacher/subjects/${subjectId}`);
});

app.get('/teacher/sessions/:sessionId/attendance.csv', requireTeacher, async (req, res) => {
  if (!validId(req.params.sessionId)) return res.status(404).send('Session not found.');
  const owned = await pool.query(
    `SELECT ts.id, sb.name FROM teaching_sessions ts JOIN subjects sb ON sb.id = ts.subject_id
     WHERE ts.id = $1 AND sb.teacher_id = $2`,
    [req.params.sessionId, req.session.teacherId],
  );
  if (!owned.rowCount) return res.status(404).send('Session not found.');
  const rows = await getAttendanceRows(req.params.sessionId);
  const csv = [
    ['Student', 'Email', 'Status', 'First check-in', 'Last evidence', 'GPS accuracy (m)'],
    ...rows.map((row) => [row.full_name, row.email, row.status,
      row.first_at ? new Date(row.first_at).toISOString() : '',
      row.at ? new Date(row.at).toISOString() : '',
      row.accuracy_meters ? Math.round(row.accuracy_meters) : '']),
  ].map((line) => line.map(csvCell).join(',')).join('\r\n');
  res.type('text/csv').set('Content-Disposition', `attachment; filename="attendance-${owned.rows[0].id}.csv"`)
    .send(`\uFEFF${csv}`);
});

app.post('/teacher/sessions/:sessionId/attendance/:studentId', requireTeacher, requireCsrf, async (req, res) => {
  if (!validId(req.params.sessionId) || !validId(req.params.studentId)) {
    return res.status(404).send('Attendance record not found.');
  }
  const status = req.body.status;
  const reason = typeof req.body.reason === 'string' ? req.body.reason.trim() : '';
  if (!['inside', 'outside', 'unavailable'].includes(status) || !reason || reason.length > 500) {
    return res.status(400).send('Choose a status and provide a reason of up to 500 characters.');
  }
  const result = await pool.query(
    `INSERT INTO attendance_adjustments (session_id, student_id, teacher_id, status, reason)
     SELECT ts.id, ss.student_id, $3, $4, $5 FROM teaching_sessions ts
     JOIN subjects sb ON sb.id = ts.subject_id JOIN subject_students ss ON ss.subject_id = sb.id
     WHERE ts.id = $1 AND ss.student_id = $2 AND sb.teacher_id = $3
     RETURNING session_id`,
    [req.params.sessionId, req.params.studentId, req.session.teacherId, status, reason],
  );
  if (!result.rowCount) return res.status(404).send('Attendance record not found.');
  const sessionResult = await pool.query('SELECT subject_id FROM teaching_sessions WHERE id = $1', [result.rows[0].session_id]);
  res.redirect(303, `/teacher/subjects/${sessionResult.rows[0].subject_id}`);
});

app.post('/teacher/sessions/:sessionId/polls', requireTeacher, requireCsrf, async (req, res) => {
  if (!validId(req.params.sessionId)) return res.status(404).send('Active session not found.');
  const prompt = typeof req.body.prompt === 'string' ? req.body.prompt.trim() : '';
  const options = typeof req.body.options === 'string'
    ? [...new Set(req.body.options.split(/\r?\n/).map((value) => value.trim()).filter(Boolean))]
    : [];
  if (!prompt || prompt.length > 500 || options.length < 2 || options.length > 8
    || options.some((option) => option.length > 100)) {
    return res.status(400).send('Polls need a prompt and 2–8 unique options of at most 100 characters.');
  }
  const sessionResult = await pool.query(
    `SELECT ts.id, sb.teacher_id FROM teaching_sessions ts JOIN subjects sb ON sb.id = ts.subject_id
     WHERE ts.id = $1 AND sb.teacher_id = $2 AND ts.ended_at IS NULL`,
    [req.params.sessionId, req.session.teacherId],
  );
  if (!sessionResult.rowCount) return res.status(404).send('Active session not found.');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const poll = await client.query(
      'INSERT INTO polls (session_id, prompt) VALUES ($1, $2) RETURNING id',
      [req.params.sessionId, prompt],
    );
    for (const option of options) {
      await client.query('INSERT INTO poll_options (poll_id, label) VALUES ($1, $2)', [poll.rows[0].id, option]);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  const subjectId = await pool.query('SELECT subject_id FROM teaching_sessions WHERE id = $1', [req.params.sessionId]);
  res.redirect(303, `/teacher/subjects/${subjectId.rows[0].subject_id}`);
});

app.post('/teacher/polls/:pollId/close', requireTeacher, requireCsrf, async (req, res) => {
  if (!validId(req.params.pollId)) return res.status(404).send('Poll not found.');
  const result = await pool.query(
    `UPDATE polls p SET closed_at = NOW() FROM teaching_sessions ts JOIN subjects sb ON sb.id = ts.subject_id
     WHERE p.id = $1 AND p.session_id = ts.id AND sb.teacher_id = $2 RETURNING sb.id AS subject_id`,
    [req.params.pollId, req.session.teacherId],
  );
  if (!result.rowCount) return res.status(404).send('Poll not found.');
  res.redirect(303, `/teacher/subjects/${result.rows[0].subject_id}`);
});

app.post('/teacher/discussion/:itemId', requireTeacher, requireCsrf, async (req, res) => {
  if (!validId(req.params.itemId)) return res.status(404).send('Discussion item not found.');
  const action = req.body.action;
  const reply = typeof req.body.reply === 'string' ? req.body.reply.trim() : '';
  if (action === 'reply' && reply.length > 3000) return res.status(400).send('Reply is too long.');
  const result = await pool.query(
    `UPDATE discussion_items di SET
       visibility = CASE WHEN $2 = 'hide' THEN 'private_to_teacher' ELSE di.visibility END,
       teacher_reply = CASE WHEN $2 = 'reply' THEN $3 ELSE di.teacher_reply END,
       moderated_at = NOW()
     FROM teaching_sessions ts JOIN subjects sb ON sb.id = ts.subject_id
     WHERE di.id = $1 AND di.session_id = ts.id AND sb.teacher_id = $4
       AND $2 IN ('reply', 'hide')
     RETURNING sb.id AS subject_id`,
    [req.params.itemId, action, reply, req.session.teacherId],
  );
  if (!result.rowCount) return res.status(404).send('Discussion item not found.');
  res.redirect(303, `/teacher/subjects/${result.rows[0].subject_id}`);
});

app.post('/teacher/subjects/:subjectId/assignments', requireTeacher, requireCsrf, async (req, res) => {
  if (!validId(req.params.subjectId)) return res.status(404).send('Subject not found.');
  const subject = await getOwnedSubject(req.session.teacherId, req.params.subjectId);
  if (!subject) return res.status(404).send('Subject not found.');
  const title = typeof req.body.title === 'string' ? req.body.title.trim() : '';
  const instructions = typeof req.body.instructions === 'string' ? req.body.instructions.trim() : '';
  if (!title || title.length > 150 || !instructions || instructions.length > 5000) {
    return res.status(400).send('Provide an assignment title and instructions within the stated limits.');
  }
  let dueAt = null;
  if (req.body.dueAt) {
    const localDate = new Date(`${req.body.dueAt}Z`);
    const offsetMinutes = req.body.dueAtOffsetMinutes === undefined
      ? 0 : Number(req.body.dueAtOffsetMinutes);
    if (Number.isNaN(localDate.getTime()) || !Number.isInteger(offsetMinutes)
      || offsetMinutes < -840 || offsetMinutes > 840) {
      return res.status(400).send('Invalid deadline.');
    }
    dueAt = new Date(localDate.getTime() + offsetMinutes * 60 * 1000);
  }
  await pool.query(
    'INSERT INTO assignments (subject_id, title, instructions, due_at) VALUES ($1, $2, $3, $4)',
    [subject.id, title, instructions, dueAt],
  );
  res.redirect(303, `/teacher/subjects/${subject.id}`);
});

app.post('/teacher/subjects/:subjectId/summaries', requireTeacher, requireCsrf, async (req, res) => {
  if (!validId(req.params.subjectId)) return res.status(404).send('Subject not found.');
  const subject = await getOwnedSubject(req.session.teacherId, req.params.subjectId);
  if (!subject) return res.status(404).send('Subject not found.');
  const transcript = typeof req.body.transcript === 'string' ? req.body.transcript.trim() : '';
  if (!transcript || transcript.length > 100000 || req.body.confirmExternalProcessing !== 'on') {
    return res.status(400).send('Provide a transcript (up to 100,000 characters) and confirm sending it to OpenAI.');
  }
  if (!validId(req.body.sessionId)) return res.status(404).send('Class session not found.');
  const sessionResult = await pool.query(
    'SELECT id FROM teaching_sessions WHERE id = $1 AND subject_id = $2',
    [req.body.sessionId, subject.id],
  );
  if (!sessionResult.rowCount) return res.status(404).send('Class session not found.');
  const saved = await pool.query(
    `INSERT INTO class_summaries (session_id, transcript, status, model)
     VALUES ($1, $2, 'pending', $3) RETURNING id`,
    [sessionResult.rows[0].id, transcript, process.env.OPENAI_MODEL || 'gpt-4o-mini'],
  );
  try {
    const summary = await generateText(
      'Summarize this class transcript for students. Organize key concepts, explanations, examples, and open questions. Do not invent facts.',
      transcript,
    );
    await pool.query(
      "UPDATE class_summaries SET summary = $1, status = 'ready' WHERE id = $2",
      [summary, saved.rows[0].id],
    );
  } catch (error) {
    await pool.query("UPDATE class_summaries SET status = 'failed' WHERE id = $1", [saved.rows[0].id]);
    return res.status(error.status || 502).send(renderPage('Summary generation failed',
      `<h1>Summary generation failed</h1><p role="alert">${escapeHtml(error.message)}</p>
       <p>The transcript remains saved in the database. Correct OpenAI configuration and retry with a new request.</p>
       <p><a href="/teacher/subjects/${subject.id}">Return to subject</a></p>`, csrfTokenFor(req)));
  }
  res.redirect(303, `/teacher/subjects/${subject.id}`);
});

app.post('/teacher/summaries/:summaryId/approve', requireTeacher, requireCsrf, async (req, res) => {
  if (!validId(req.params.summaryId)) return res.status(404).send('Summary not found.');
  const summary = typeof req.body.summary === 'string' ? req.body.summary.trim() : '';
  if (!summary || summary.length > 20000) return res.status(400).send('Summary must be 1–20,000 characters.');
  const result = await pool.query(
    `UPDATE class_summaries cs SET summary = $2, approved_at = NOW()
     FROM teaching_sessions ts JOIN subjects sb ON sb.id = ts.subject_id
     WHERE cs.id = $1 AND cs.session_id = ts.id AND sb.teacher_id = $3 AND cs.status = 'ready'
     RETURNING sb.id AS subject_id`,
    [req.params.summaryId, summary, req.session.teacherId],
  );
  if (!result.rowCount) return res.status(404).send('Summary not found or not ready.');
  res.redirect(303, `/teacher/subjects/${result.rows[0].subject_id}`);
});

app.post('/teacher/submissions/:submissionId/review', requireTeacher, requireCsrf, async (req, res) => {
  if (!validId(req.params.submissionId)) return res.status(404).send('Submission not found.');
  if (req.body.confirmExternalProcessing !== 'on') {
    return res.status(400).send('Confirm sending the student submission to OpenAI.');
  }
  const result = await pool.query(
    `SELECT s.id, s.assignment_id, s.student_id, s.content, a.instructions, a.subject_id
     FROM submissions s JOIN assignments a ON a.id = s.assignment_id
     JOIN subjects sb ON sb.id = a.subject_id
     WHERE s.id = $1 AND sb.teacher_id = $2`,
    [req.params.submissionId, req.session.teacherId],
  );
  if (!result.rowCount) return res.status(404).send('Submission not found.');
  const submission = result.rows[0];
  await pool.query(
    `INSERT INTO submission_reviews (submission_id, status, model) VALUES ($1, 'pending', $2)
     ON CONFLICT (submission_id) DO UPDATE SET status = 'pending', model = EXCLUDED.model, generated_at = NOW()`,
    [submission.id, process.env.OPENAI_MODEL || 'gpt-4o-mini'],
  );
  const otherSubmissions = await pool.query(
    `SELECT s.content, st.full_name FROM submissions s
     JOIN students st ON st.id = s.student_id
     WHERE s.assignment_id = $1 AND s.id <> $2`,
    [submission.assignment_id, submission.id],
  );
  const similarity = otherSubmissions.rows.map((other) => ({
    studentName: other.full_name,
    ...similarityDetails(submission.content, other.content),
  })).filter((entry) => entry.percent >= 35).sort((a, b) => b.percent - a.percent);
  await pool.query(
    'UPDATE submission_reviews SET similarity = $1::jsonb WHERE submission_id = $2',
    [JSON.stringify(similarity), submission.id],
  );
  try {
    const feedback = await generateText(
      'Give constructive, specific feedback on this student homework. Mention strengths, areas to improve, and questions the student should consider. Do not assign a grade or make an academic-integrity verdict.',
      `Assignment instructions:\n${submission.instructions}\n\nStudent work:\n${submission.content}`,
    );
    await pool.query(
      `UPDATE submission_reviews SET feedback = $1, status = 'ready', generated_at = NOW()
       WHERE submission_id = $2`,
      [feedback, submission.id],
    );
  } catch (error) {
    await pool.query("UPDATE submission_reviews SET status = 'failed' WHERE submission_id = $1", [submission.id]);
    return res.status(error.status || 502).send(renderPage('Review generation failed',
      `<h1>Review generation failed</h1><p role="alert">${escapeHtml(error.message)}</p>
       <p>The submission remains stored. <a href="/teacher/subjects/${submission.subject_id}">Return to subject</a></p>`,
      csrfTokenFor(req)));
  }
  res.redirect(303, `/teacher/subjects/${submission.subject_id}`);
});

app.get('/join/:token', async (req, res) => {
  if (typeof req.params.token !== 'string' || req.params.token.length > 100) {
    return res.status(404).send('This class QR code is no longer active.');
  }
  const tokenHash = crypto.createHash('sha256').update(req.params.token).digest('hex');
  const sessionResult = await pool.query(
    `SELECT ts.id, sb.name FROM teaching_sessions ts JOIN subjects sb ON sb.id = ts.subject_id
     WHERE ts.join_token_hash = $1 AND ts.ended_at IS NULL`,
    [tokenHash],
  );
  if (!sessionResult.rowCount) return res.status(404).send('This class QR code is no longer active.');
  const studentRows = await pool.query(
    `SELECT st.id, st.full_name, st.email FROM subject_students ss
     JOIN students st ON st.id = ss.student_id WHERE ss.subject_id = (
       SELECT subject_id FROM teaching_sessions WHERE id = $1)
     ORDER BY lower(st.full_name)`,
    [sessionResult.rows[0].id],
  );
  const token = csrfTokenFor(req);
  const options = studentRows.rows.map((student, index) =>
    `<option value="${student.id}">Student ${index + 1} — ${escapeHtml(student.full_name)}</option>`).join('');
  res.send(renderPage(`Join ${sessionResult.rows[0].name}`, `<h1>Join ${escapeHtml(sessionResult.rows[0].name)}</h1>
    <p class="notice">Student roster selection is demo-only identity verification. Do not use it as proof of identity for real attendance.</p>
    ${options ? `<form method="post" action="/join/${encodeURIComponent(req.params.token)}">${formCsrf(token)}
      <label for="studentId">Select your roster entry</label><select id="studentId" name="studentId" required>${options}</select>
      <button>Join class</button></form>` : '<p>No students are enrolled in this subject.</p>'}`, token));
});

app.post('/join/:token', requireCsrf, async (req, res) => {
  if (typeof req.params.token !== 'string' || req.params.token.length > 100 || !validId(req.body.studentId)) {
    return res.status(400).send('Invalid class join request.');
  }
  const tokenHash = crypto.createHash('sha256').update(String(req.params.token)).digest('hex');
  const result = await pool.query(
    `SELECT ts.id AS session_id, st.id AS student_id, st.full_name, st.email FROM teaching_sessions ts
     JOIN subjects sb ON sb.id = ts.subject_id
     JOIN subject_students ss ON ss.subject_id = sb.id
     JOIN students st ON st.id = ss.student_id
     WHERE ts.join_token_hash = $1 AND ts.ended_at IS NULL AND ss.student_id = $2`,
    [tokenHash, req.body.studentId],
  );
  if (!result.rowCount) return res.status(403).send('This student is not enrolled in the active subject.');
  req.session.regenerate((error) => {
    if (error) return res.status(500).send('Could not start the student session. Please try again.');
    const student = new Student({
      id: result.rows[0].student_id,
      fullName: result.rows[0].full_name,
      email: result.rows[0].email,
    });
    req.session.studentId = student.id;
    req.session.teachingSessionId = result.rows[0].session_id;
    req.session.csrfToken = crypto.randomBytes(32).toString('hex');
    req.session.save((saveError) => {
      if (saveError) return res.status(500).send('Could not save the student session.');
      res.redirect(303, '/student');
    });
  });
});

async function getStudentSession(req) {
  const result = await pool.query(
    `SELECT ts.id AS session_id, ts.ended_at, sb.id AS subject_id, sb.name AS subject_name,
       sb.classroom_latitude, sb.classroom_longitude, sb.geofence_radius_meters,
       st.full_name AS student_name
     FROM teaching_sessions ts JOIN subjects sb ON sb.id = ts.subject_id
     JOIN subject_students ss ON ss.subject_id = sb.id AND ss.student_id = $2
     JOIN students st ON st.id = ss.student_id
     WHERE ts.id = $1`,
    [req.session.teachingSessionId, req.session.studentId],
  );
  return result.rows[0] || null;
}

app.get('/student', async (req, res) => {
  if (!req.session.studentId || !req.session.teachingSessionId) return res.redirect('/');
  const context = await getStudentSession(req);
  if (!context) return res.status(403).send('Your student session is no longer available.');
  const token = csrfTokenFor(req);
  const [polls, assignments, summaries, discussions, attendance] = await Promise.all([
    pool.query(
      `SELECT p.id, p.prompt, p.closed_at, po.id AS option_id, po.label,
         COUNT(v.id)::int AS votes, own.option_id AS own_vote
       FROM polls p JOIN poll_options po ON po.poll_id = p.id
       LEFT JOIN poll_votes v ON v.option_id = po.id
       LEFT JOIN LATERAL (SELECT option_id FROM poll_votes WHERE poll_id = p.id AND student_id = $2) own ON TRUE
       WHERE p.session_id = $1 GROUP BY p.id, po.id, own.option_id ORDER BY p.created_at DESC, po.id`,
      [context.session_id, req.session.studentId],
    ),
    pool.query(
      `SELECT a.*, s.content AS own_content, sr.feedback, sr.status AS review_status
       FROM assignments a JOIN subject_students ss ON ss.subject_id = a.subject_id
       LEFT JOIN submissions s ON s.assignment_id = a.id AND s.student_id = ss.student_id
       LEFT JOIN submission_reviews sr ON sr.submission_id = s.id
       WHERE ss.student_id = $1 AND a.subject_id = $2 ORDER BY a.created_at DESC`,
      [req.session.studentId, context.subject_id],
    ),
    pool.query('SELECT summary FROM class_summaries WHERE session_id = $1 AND approved_at IS NOT NULL ORDER BY approved_at DESC', [context.session_id]),
    pool.query(
      `SELECT body, teacher_reply, visibility, created_at FROM discussion_items
       WHERE session_id = $1 AND (visibility = 'class' OR student_id = $2)
       ORDER BY created_at DESC LIMIT 50`,
      [context.session_id, req.session.studentId],
    ),
    pool.query(
      'SELECT status, recorded_at, accuracy_meters, detail FROM attendance_events WHERE session_id = $1 AND student_id = $2 ORDER BY recorded_at DESC LIMIT 1',
      [context.session_id, req.session.studentId],
    ),
  ]);
  const groupedPolls = new Map();
  for (const row of polls.rows) {
    if (!groupedPolls.has(String(row.id))) {
      groupedPolls.set(String(row.id), { ...row, options: [] });
    }
    groupedPolls.get(String(row.id)).options.push(row);
  }
  const pollMarkup = [...groupedPolls.values()].map((poll) =>
    `<article><h3>${escapeHtml(poll.prompt)}</h3>
     ${poll.own_vote
    ? `<p>Your vote is saved. ${poll.closed_at ? 'Poll closed.' : 'Results:'}</p>
       <ul>${poll.options.map((option) => `<li>${escapeHtml(option.label)} — ${option.votes}</li>`).join('')}</ul>`
    : poll.closed_at || context.ended_at
      ? `<p>Poll closed. Results:</p><ul>${poll.options.map((option) => `<li>${escapeHtml(option.label)} — ${option.votes}</li>`).join('')}</ul>`
      : `<form data-queue="/student/votes"><input type="hidden" name="pollId" value="${poll.id}">
         <label for="vote-option-${poll.id}">Choose an option</label><select id="vote-option-${poll.id}" name="optionId" required>${poll.options.map((option) =>
    `<option value="${option.option_id}">${escapeHtml(option.label)}</option>`).join('')}</select>
         <button>Submit vote</button><p id="vote-status-${poll.id}" data-submit-status role="status"></p></form>`}
     </article>`).join('');
  const assignmentMarkup = assignments.rows.map((assignment) => {
    const submissionOpen = !assignment.due_at || new Date(assignment.due_at).getTime() >= Date.now();
    return `<article><h3>${escapeHtml(assignment.title)}</h3><p>${escapeHtml(assignment.instructions)}</p>
      <p>Deadline: ${assignment.due_at ? escapeHtml(new Date(assignment.due_at).toLocaleString()) : 'No deadline'}</p>
      ${submissionOpen ? `<form data-queue="/student/assignments/${assignment.id}/submissions">
        <label for="homework-${assignment.id}">Your homework (plain text)</label><textarea id="homework-${assignment.id}" name="content" maxlength="50000" required>${escapeHtml(assignment.own_content || '')}</textarea>
        <button>Save/replace submission</button><p id="submission-status-${assignment.id}" data-submit-status role="status"></p>
      </form>` : '<p>The submission deadline has passed.</p>'}
      ${assignment.feedback ? `<p><strong>AI feedback (suggestion, not a grade):</strong> ${escapeHtml(assignment.feedback)}</p>`
    : assignment.review_status ? `<p>AI review status: ${escapeHtml(assignment.review_status)}</p>` : ''}
    </article>`;
  }).join('');
  const latest = attendance.rows[0];
  res.send(renderPage(`Student - ${context.subject_name}`, `<h1>${escapeHtml(context.subject_name)}</h1>
    <p>Signed in as ${escapeHtml(context.student_name)}.</p>
    <form class="inline" method="post" action="/student/leave" id="leave-class">${formCsrf(token)}<button>Leave this class</button></form>
  <p id="leave-status" role="status"></p>
    ${context.ended_at ? '<p class="notice">This class session has ended. New attendance checks and votes are disabled.</p>' : ''}
    <section><h2>Attendance</h2>
      <p id="checkin-status" role="status">${latest
    ? `Last saved status: ${escapeHtml(latest.status)}${latest.accuracy_meters ? ` — GPS accuracy ${Math.round(latest.accuracy_meters)} m` : latest.detail ? ` — ${escapeHtml(latest.detail.replaceAll('-', ' '))}` : ''} at ${escapeHtml(new Date(latest.recorded_at).toLocaleString())}`
    : 'Waiting for first GPS check-in.'}</p>
      ${!context.ended_at ? '<button id="check-location" type="button">Check location now</button>' : ''}
      <p class="muted">With permission, GPS is checked now and every 10 minutes while this page is open and active. Browser GPS may be inaccurate or unavailable.</p>
    </section>
    <section><h2>Questions and suggestions</h2>
      <form data-queue="/student/questions">
        <label for="question-message">Message</label><textarea id="question-message" name="body" maxlength="3000" required></textarea>
        <label for="question-visibility">Visibility</label><select id="question-visibility" name="visibility"><option value="private_to_teacher">Private to teacher</option><option value="class">Visible to class</option></select>
        <button>Save message</button><p id="question-status" data-submit-status role="status"></p>
      </form>
      ${discussions.rows.map((item) => `<article><p>${escapeHtml(item.visibility)} · ${escapeHtml(new Date(item.created_at).toLocaleString())}</p>
        <p>${escapeHtml(item.body)}</p>${item.teacher_reply ? `<p><strong>Teacher reply:</strong> ${escapeHtml(item.teacher_reply)}</p>` : ''}</article>`).join('')}
    </section>
    <section><h2>Polls</h2>${pollMarkup || '<p>No polls available.</p>'}</section>
    <section><h2>Class summaries</h2>${summaries.rows.length
    ? summaries.rows.map((row) => `<article><p><strong>Teacher-approved AI-generated summary</strong></p>${escapeHtml(row.summary)}</article>`).join('')
    : '<p>No teacher-approved summaries are available.</p>'}</section>
    <section><h2>Homework</h2>${assignmentMarkup || '<p>No assignments are available.</p>'}</section>`,
  token, String(context.session_id), !context.ended_at, String(req.session.studentId)));
});

app.post('/student/leave', requireCsrf, (req, res) => {
  if (req.session.studentId) {
    delete req.session.studentId;
    delete req.session.teachingSessionId;
  }
  res.redirect('/');
});

app.post('/student/checkin', requireStudent, requireCsrf, async (req, res) => {
  const context = await getStudentSession(req);
  if (!context || context.ended_at) return res.status(410).json({ error: 'This class session has ended.' });
  const latitude = typeof req.body.latitude === 'number' ? req.body.latitude : NaN;
  const longitude = typeof req.body.longitude === 'number' ? req.body.longitude : NaN;
  const accuracy = typeof req.body.accuracyMeters === 'number' ? req.body.accuracyMeters : NaN;
  const subject = new Subject({
    id: context.subject_id,
    teacherId: null,
    name: context.subject_name,
    classroomLatitude: context.classroom_latitude,
    classroomLongitude: context.classroom_longitude,
    geofenceRadiusMeters: context.geofence_radius_meters,
  });
  const evaluation = evaluateLocation(subject, latitude, longitude, accuracy, maximumAccuracyMeters);
  const reason = ['permission-denied', 'timeout', 'unavailable'].includes(req.body.reason)
    ? req.body.reason : null;
  const detail = evaluation.status === 'unavailable'
    ? reason || 'location-or-accuracy-unavailable' : null;
  const result = await pool.query(
    `INSERT INTO attendance_events
       (session_id, student_id, latitude, longitude, accuracy_meters, status, detail)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING recorded_at, detail`,
    [context.session_id, req.session.studentId,
      null, null,
      Number.isFinite(accuracy) && accuracy >= 0 ? accuracy : null,
      evaluation.status, detail],
  );
  res.json({
    status: evaluation.status,
    recordedAt: result.rows[0].recorded_at,
    accuracyMeters: Number.isFinite(accuracy) && accuracy >= 0 ? Math.round(accuracy) : null,
    detail: result.rows[0].detail,
  });
});

app.post('/student/questions', requireStudent, requireCsrf, async (req, res) => {
  const context = await getStudentSession(req);
  const body = typeof req.body.body === 'string' ? req.body.body.trim() : '';
  const visibility = req.body.visibility;
  const dedupeKey = typeof req.body.idempotencyKey === 'string' && /^[a-f0-9-]{36}$/i.test(req.body.idempotencyKey)
    ? req.body.idempotencyKey : null;
  if (!context || context.ended_at) return res.status(410).json({ error: 'This class session has ended.' });
  if (!body || body.length > 3000 || !['class', 'private_to_teacher'].includes(visibility) || !dedupeKey) {
    return res.status(400).json({ error: 'Provide a message and valid visibility setting.' });
  }
  await pool.query(
    `INSERT INTO discussion_items (session_id, student_id, visibility, body, dedupe_key)
     VALUES ($1, $2, $3, $4, $5) ON CONFLICT (student_id, dedupe_key) DO NOTHING`,
    [context.session_id, req.session.studentId, visibility, body, dedupeKey],
  );
  res.json({ saved: true });
});

app.post('/student/votes', requireStudent, requireCsrf, async (req, res) => {
  const context = await getStudentSession(req);
  if (!context || context.ended_at) return res.status(410).json({ error: 'This class session has ended.' });
  if (!validId(req.body.pollId) || !validId(req.body.optionId)) {
    return res.status(400).json({ error: 'Choose a valid poll option.' });
  }
  const poll = await pool.query(
    `SELECT p.id, po.id AS option_id FROM polls p JOIN poll_options po ON po.poll_id = p.id
     WHERE p.id = $1 AND po.id = $2 AND p.session_id = $3 AND p.closed_at IS NULL`,
    [req.body.pollId, req.body.optionId, context.session_id],
  );
  if (!poll.rowCount) return res.status(400).json({ error: 'This poll or option is no longer available.' });
  const inserted = await pool.query(
    `INSERT INTO poll_votes (poll_id, option_id, student_id) VALUES ($1, $2, $3)
     ON CONFLICT (poll_id, student_id) DO NOTHING RETURNING option_id`,
    [poll.rows[0].id, poll.rows[0].option_id, req.session.studentId],
  );
  if (!inserted.rowCount) {
    const existing = await pool.query(
      'SELECT option_id FROM poll_votes WHERE poll_id = $1 AND student_id = $2',
      [poll.rows[0].id, req.session.studentId],
    );
    if (String(existing.rows[0]?.option_id) !== String(poll.rows[0].option_id)) {
      return res.status(409).json({ error: 'You have already voted in this poll.' });
    }
  }
  res.json({ saved: true });
});

app.post('/student/assignments/:assignmentId/submissions', requireStudent, requireCsrf, async (req, res) => {
  if (!validId(req.params.assignmentId)) return res.status(404).json({ error: 'Assignment not found.' });
  const context = await getStudentSession(req);
  const content = typeof req.body.content === 'string' ? req.body.content.trim() : '';
  if (!context || !content || content.length > 50000) {
    return res.status(400).json({ error: 'Submission text must be 1–50,000 characters.' });
  }
  const assignment = await pool.query(
    `SELECT a.id FROM assignments a JOIN subject_students ss ON ss.subject_id = a.subject_id
     WHERE a.id = $1 AND a.subject_id = $2 AND ss.student_id = $3
       AND (a.due_at IS NULL OR a.due_at >= NOW())`,
    [req.params.assignmentId, context.subject_id, req.session.studentId],
  );
  if (!assignment.rowCount) return res.status(404).json({ error: 'Assignment not found or deadline has passed.' });
  await pool.query(
    `INSERT INTO submissions (assignment_id, student_id, content) VALUES ($1, $2, $3)
     ON CONFLICT (assignment_id, student_id) DO UPDATE SET content = EXCLUDED.content, submitted_at = NOW()`,
    [assignment.rows[0].id, req.session.studentId, content],
  );
  res.json({ saved: true });
});

app.get('/health', async (req, res) => {
  await pool.query('SELECT 1');
  res.status(200).json({ status: 'ok' });
});

app.use((error, req, res, next) => {
  console.error(error);
  if (res.headersSent) return next(error);
  if (error.code === '23505') {
    return res.status(409).send('This record already exists. Refresh the page and review the current data.');
  }
  const status = Number.isInteger(error.status) && error.status >= 400 && error.status < 600
    ? error.status : 500;
  res.status(status).send(status === 500
    ? 'An unexpected server error occurred. Please try again.'
    : escapeHtml(error.message));
});

initializeDatabase()
  .then(() => {
    app.listen(port, '0.0.0.0', () => {
      console.log(`ClassTeachWeb listening on port ${port}`);
    });
  })
  .catch((error) => {
    console.error('Failed to initialize the database:', error);
    process.exitCode = 1;
  });

module.exports = { app, csvCell };
