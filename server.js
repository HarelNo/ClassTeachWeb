require('dotenv').config();

const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const express = require('express');
const session = require('express-session');
const { rateLimit } = require('express-rate-limit');
const PgSession = require('connect-pg-simple')(session);
const QRCode = require('qrcode');
const { initializeDatabase, pool } = require('./database');

const app = express();
const port = Number(process.env.PORT) || 3000;

if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32) {
  throw new Error('SESSION_SECRET must be set to at least 32 characters.');
}

app.set('trust proxy', 1);
app.use(express.urlencoded({ extended: false, limit: '10kb' }));
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

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
});

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character]);
}

function renderPage(title, content) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(title)}</title>
    <style>
      body { font: 16px system-ui, sans-serif; margin: 2rem auto; max-width: 40rem; padding: 0 1rem; }
      button { cursor: pointer; font: inherit; padding: .6rem 1rem; }
      input { box-sizing: border-box; display: block; font: inherit; margin: .4rem 0 1rem; max-width: 24rem; padding: .5rem; width: 100%; }
      img { display: block; height: auto; margin: 1rem 0; max-width: 100%; }
      code { overflow-wrap: anywhere; }
    </style>
  </head>
  <body>${content}</body>
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
  const provided = req.body.csrfToken;
  if (typeof expected !== 'string' || typeof provided !== 'string') {
    return false;
  }

  const expectedBuffer = Buffer.from(expected);
  const providedBuffer = Buffer.from(provided);
  return expectedBuffer.length === providedBuffer.length
    && crypto.timingSafeEqual(expectedBuffer, providedBuffer);
}

function requireCsrf(req, res, next) {
  if (!validCsrfToken(req)) {
    return res.status(403).send('The form expired. Please try again.');
  }
  next();
}

async function requireTeacher(req, res, next) {
  if (!req.session.teacherId) {
    return res.redirect('/login');
  }

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

app.get('/', (req, res) => {
  res.send(renderPage('ClassTeachWeb', '<h1>ClassTeachWeb</h1><p><a href="/login">Teacher login</a></p>'));
});

app.get('/login', (req, res) => {
  const message = req.query.error === '1'
    ? '<p role="alert">Name or password is incorrect.</p>'
    : '';
  res.send(renderPage('Teacher login - ClassTeachWeb', `<h1>Teacher login</h1>
    ${message}
    <form method="post" action="/login">
      <input type="hidden" name="csrfToken" value="${csrfTokenFor(req)}">
      <label for="fullName">Full name</label>
      <input id="fullName" name="fullName" autocomplete="username" required>
      <label for="password">Password</label>
      <input id="password" name="password" type="password" autocomplete="current-password" required>
      <button type="submit">Log in</button>
    </form>`));
});

app.post('/login', loginLimiter, requireCsrf, async (req, res, next) => {
  try {
    const fullName = typeof req.body.fullName === 'string' ? req.body.fullName.trim() : '';
    const password = typeof req.body.password === 'string' ? req.body.password : '';
    const result = await pool.query(
      'SELECT id, full_name, password_hash FROM teachers WHERE lower(full_name) = lower($1)',
      [fullName],
    );
    const teacher = result.rows[0];
    const passwordMatches = teacher
      ? await bcrypt.compare(password, teacher.password_hash)
      : false;

    if (!passwordMatches) {
      return res.redirect(303, '/login?error=1');
    }

    req.session.regenerate(async (error) => {
      if (error) return next(error);

      try {
        req.session.teacherId = teacher.id;
        req.session.teacherName = teacher.full_name;
        req.session.csrfToken = crypto.randomBytes(32).toString('hex');
        await pool.query(
          `INSERT INTO teacher_logins (teacher_id, session_id)
           VALUES ($1, $2)
           ON CONFLICT (teacher_id) DO UPDATE
           SET session_id = EXCLUDED.session_id, updated_at = NOW()`,
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
    await pool.query(
      'DELETE FROM teacher_logins WHERE teacher_id = $1 AND session_id = $2',
      [req.session.teacherId, req.sessionID],
    );
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
  const result = await pool.query(
    'SELECT token FROM class_sessions WHERE teacher_id = $1',
    [req.session.teacherId],
  );
  let sessionContent = '<p>No active session. Create a QR code to start one.</p>';

  if (result.rowCount === 1) {
    const baseUrl = process.env.PUBLIC_URL
      || process.env.RENDER_EXTERNAL_URL
      || `${req.protocol}://${req.get('host')}`;
    const joinUrl = new URL(`/join/${result.rows[0].token}`, baseUrl).toString();
    const qrCode = await QRCode.toDataURL(joinUrl, {
      errorCorrectionLevel: 'M',
      margin: 2,
      width: 320,
    });
    sessionContent = `<p>Students scan this QR code to open the student page:</p>
      <img src="${qrCode}" alt="QR code for the active class session">
      <p>Student link: <a href="${escapeHtml(joinUrl)}">${escapeHtml(joinUrl)}</a></p>`;
  }

  res.send(renderPage('Teacher - ClassTeachWeb', `<h1>Teacher</h1>
    <p>Signed in as ${escapeHtml(req.session.teacherName)}.</p>
    ${sessionContent}
    <form method="post" action="/teacher/sessions">
      <input type="hidden" name="csrfToken" value="${csrfTokenFor(req)}">
      <button type="submit">${result.rowCount ? 'Create a new session QR code' : 'Create session QR code'}</button>
    </form>
    <p>Creating a new code invalidates your previous one.</p>
    <form method="post" action="/logout">
      <input type="hidden" name="csrfToken" value="${csrfTokenFor(req)}">
      <button type="submit">Log out</button>
    </form>`));
});

app.post('/teacher/sessions', requireTeacher, requireCsrf, async (req, res) => {
  const token = crypto.randomBytes(24).toString('base64url');
  await pool.query(
    `INSERT INTO class_sessions (teacher_id, token)
     VALUES ($1, $2)
     ON CONFLICT (teacher_id) DO UPDATE
     SET token = EXCLUDED.token, created_at = NOW()`,
    [req.session.teacherId, token],
  );
  res.redirect(303, '/teacher');
});

app.get('/join/:sessionId', async (req, res) => {
  const result = await pool.query(
    'SELECT 1 FROM class_sessions WHERE token = $1',
    [req.params.sessionId],
  );
  if (result.rowCount !== 1) {
    return res.status(404).send('This class QR code is no longer active.');
  }
  res.redirect('/test');
});

app.get('/test', (req, res) => {
  res.send(renderPage('Student page - ClassTeachWeb', `<h1>Student page</h1>
    <p>You have reached the student destination.</p>`));
});

app.get('/health', async (req, res) => {
  await pool.query('SELECT 1');
  res.status(200).json({ status: 'ok' });
});

app.use((error, req, res, next) => {
  console.error(error);
  if (res.headersSent) return next(error);
  res.status(500).send('An unexpected server error occurred.');
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
