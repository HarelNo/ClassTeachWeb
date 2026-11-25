# ClassTeachWeb

A mobile-friendly class web service for teachers and students. The current
requirements, architecture, phased scope, and test strategy are in [SPEC.md](./SPEC.md).

## Features

- Teacher sign-in, subject creation, roster enrollment, and QR-based class sessions.
- Management sign-in for creating teacher and student accounts, creating subjects,
  assigning teachers, and enrolling students.
- A collapsed QR-code panel and a separate live-class page for polls,
  questions/suggestions, and a database-backed chat available during active sessions.
- Student roster selection and GPS geofence check-ins every 10 minutes while the
  student page is open and active. Check-in status and accuracy are saved
  automatically to PostgreSQL; raw GPS coordinates are evaluated but not retained.
- Teacher attendance view, manual corrections with audit records, and optional
  CSV download generated from saved attendance.
- Quick polls with one saved vote per student, public/private questions, teacher
  replies/moderation, and a browser-side offline queue for participation drafts.
- Teacher-approved AI class summaries from pasted transcripts, plus text homework
  submissions, teacher-triggered AI feedback, and local text-similarity indicators.

Students currently identify themselves by selecting their roster entry after
scanning a QR code. This is demo-only identity verification, not proof of identity.
The browser cannot read the classroom router's MAC address. The app uses GPS
instead and cannot guarantee that browser location is accurate or unspoofed.

## Run locally

Requirements: Node.js 20+ and a reachable PostgreSQL database.

```sh
npm install
npm test
```

Copy `.env.example` to `.env`, set `DATABASE_URL` to a PostgreSQL connection
string, and set `SESSION_SECRET` to a random secret of at least 32 characters.
Then run:

```sh
npm start
```

The service listens on port `3000` by default (`PORT` can override it).
`/health` checks application-to-database connectivity.

## Live class participation

Start a session from the teacher's subject page. The QR code stays hidden until
you open **Show student QR code**; its link opens the student join page in a new
tab. From the subject page, choose **Open live class tools** for live chat, polls,
and questions/suggestions. Students scan the QR code, join, then choose **Open
live class participation** from their class page. Chat messages are saved to
PostgreSQL and appear for other participants within a few seconds. Chat, polls,
and questions stop accepting new activity when the teacher ends the session.

Teacher login and management login link to each other from their respective
login pages.

## Management account

The first management account is bootstrapped from a terminal; management accounts
cannot be created through public self-registration. Set `DATABASE_URL` in the
local `.env` to the Render database's **External Database URL**, then run:

```powershell
$env:NODE_ENV = 'production'
npm run create:manager -- "Class Manager"
Remove-Item Env:\NODE_ENV
```

The command prompts for the manager password without echoing it. Use a password
of at least 12 characters. Running it again with the same full name resets that
manager's password and invalidates their existing sessions. Open `/manager/login`
to sign in. Managers can add teachers, students, and subjects, assign teachers
to subjects, and enroll students. Teacher login uses the teacher's full name and
the password set by the manager.

## Load teacher and student rosters

The example CSV headers are:

- `data/teachers.csv`: `full name,password`
- `data/students.csv`: `full name,email address`

Copy the example files in `data/` and populate them locally. Teacher passwords
are plaintext in the import file and converted to bcrypt hashes in PostgreSQL.
Do not commit or share populated roster files; real CSV files in `data/` are
excluded from Git.

Import both rosters:

```sh
npm run import:rosters -- ./data/teachers.csv ./data/students.csv
```

Sign in at `/login`, create a subject, enroll students from the roster, and set
the classroom coordinates/radius before starting a session. The teacher page
shows the QR code. Students scan it, select their roster entry, and allow
location access. Keep the student page open and active for periodic checks;
mobile browsers may throttle background pages.

## AI features and student data

Set `OPENAI_API_KEY` (and optionally `OPENAI_MODEL`) in the local environment or
Render service settings to enable AI. AI generation is initiated by a teacher
and requires explicit confirmation in the UI. Class transcripts and student
homework text are stored in PostgreSQL; confirmed AI requests send that text to
OpenAI. Summaries remain teacher-only drafts until approved. Homework feedback
is a suggestion, not a grade, and similarity percentages are review indicators,
not plagiarism findings.

Only transcript text and plain-text homework are supported; video and document
file uploads are not implemented. If OpenAI is not configured, source text is
still stored, the app reports the AI feature as unavailable, and no content is
sent to a provider.

## Render deployment

Connect the repository to Render and deploy the included `render.yaml` Blueprint.
It configures the Node.js web service and Render PostgreSQL. Render supplies
`DATABASE_URL` and `SESSION_SECRET`; set `OPENAI_API_KEY` in the Render dashboard
only if you want to enable AI features. The app must use HTTPS in deployment for
secure session cookies and browser geolocation.

The Blueprint uses Render's free PostgreSQL plan for testing. It has a 1 GB limit
and expires 30 days after creation. Render provides a 14-day grace period to
upgrade it; after that, the database and its data are deleted. The free plan has
no backups, so use a persistent paid database before relying on these accounts
for real classes.
