# ClassTeachWeb
Web service application for teachers and students.

A Web applications that allows attendance tracking, polling and raising question to the teacher. (scope might extend.)

Students will connect through a QR code which will then start an automatic time tracking based on gps.
Students will have an online/offline chat to raise questions to the teacher privately or publicly.
Students will have access to an AI written summery of the class after it is over.
Students will be able to upload homework and compare its integrity compared to other students.

## Run locally

Install the dependencies and start the web service:

```sh
npm install
npm start
```

For local development, copy `.env.example` to `.env`, set `DATABASE_URL` to a
PostgreSQL connection string, and replace `SESSION_SECRET` with a random secret
of at least 32 characters. Render sets these values for the deployed service.

The service listens on port `3000` by default. Set `PORT` to use a different port.
The `/health` endpoint returns a status response for health checks.

## Teacher and student CSVs

The example files in `data/` show the required headers:

- `teachers.csv`: `full name,password`
- `students.csv`: `full name,email address` (the importer also accepts `email adress`)

Copy the example files to those names and fill them with your roster. Real CSV
files in `data/` are excluded from Git. Keep them private: teacher passwords
exist in plain text in the source CSV, but are converted to bcrypt hashes when
imported into PostgreSQL. Do not commit or share the populated teacher file.

After creating the Render Blueprint, copy the PostgreSQL **External Database URL**
from the Render dashboard into your local `.env` as `DATABASE_URL`, then import:

```sh
npm install
npm run import:rosters -- ./data/teachers.csv ./data/students.csv
```

The import creates the tables and inserts or updates teachers and students.
The app also creates any missing tables at startup. Remove the populated CSV
files from your computer when you no longer need them.

The Blueprint uses Render's free PostgreSQL plan for testing; free databases
are temporary and may be deleted by Render. Choose a persistent paid database
before relying on these accounts for real classes.

## Teacher login and class QR code

After importing teachers, visit `/login` and sign in with the teacher's full name
and password. The authenticated browser can open `/teacher` and create a QR code.
Each teacher has one active login: signing in on another browser invalidates the
previous browser's session. This identifies the logged-in browser session, not
the physical device itself. Session cookies are HTTP-only and restricted to
secure connections in production.

Students can scan the QR code to reach `/test`. Creating another code replaces
that teacher's previous code. The student list is stored as a roster only;
students do not sign in yet.

## Deploy to Render

Connect this repository to Render and create a Web Service using the included
`render.yaml` Blueprint. It configures the web service and a free PostgreSQL
database for testing. Render installs the dependencies and runs `npm start`.
