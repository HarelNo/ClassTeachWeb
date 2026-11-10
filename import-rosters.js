require('dotenv').config();

const fs = require('node:fs/promises');
const path = require('node:path');
const { parse } = require('csv-parse/sync');
const bcrypt = require('bcryptjs');
const { initializeDatabase, pool } = require('./database');

function readCsv(filePath, allowedHeaders) {
  return fs.readFile(filePath, 'utf8').then((contents) => parse(contents, {
    columns: (headers) => {
      const normalizedHeaders = headers.map((header) => header.trim().toLowerCase());
      const hasExpectedHeaders = allowedHeaders.some((required) =>
        required.every((header) => normalizedHeaders.includes(header)));
      if (!hasExpectedHeaders) {
        throw new Error(`${path.basename(filePath)} has unexpected headers.`);
      }
      return normalizedHeaders;
    },
    skip_empty_lines: true,
    trim: true,
    bom: true,
    strict: true,
  }));
}

function validateTeachers(rows) {
  const seenNames = new Set();
  return rows.map((row, index) => {
    const fullName = row['full name']?.trim();
    const password = row.password;
    const nameKey = fullName?.toLocaleLowerCase('en');

    if (!fullName || !password) {
      throw new Error(`Teacher CSV row ${index + 2} must contain full name and password.`);
    }
    if (Buffer.byteLength(password, 'utf8') > 72) {
      throw new Error(`Teacher CSV row ${index + 2} has a password longer than bcrypt's 72-byte limit.`);
    }
    if (seenNames.has(nameKey)) {
      throw new Error(`Teacher CSV contains duplicate name "${fullName}".`);
    }
    seenNames.add(nameKey);
    return { fullName, password };
  });
}

function validateStudents(rows) {
  const seenEmails = new Set();
  return rows.map((row, index) => {
    const fullName = row['full name']?.trim();
    const email = (row['email address'] || row['email adress'] || '').trim();
    const emailKey = email.toLocaleLowerCase('en');

    if (!fullName || !email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new Error(`Student CSV row ${index + 2} must contain a full name and valid email address.`);
    }
    if (seenEmails.has(emailKey)) {
      throw new Error(`Student CSV contains duplicate email "${email}".`);
    }
    seenEmails.add(emailKey);
    return { fullName, email };
  });
}

async function main() {
  const teachersPath = path.resolve(process.argv[2] || 'data/teachers.csv');
  const studentsPath = path.resolve(process.argv[3] || 'data/students.csv');
  const teachers = validateTeachers(await readCsv(teachersPath, [['full name', 'password']]));
  const students = validateStudents(await readCsv(studentsPath, [
    ['full name', 'email address'],
    ['full name', 'email adress'],
  ]));
  if (teachers.length === 0) {
    throw new Error('Teacher CSV must contain at least one teacher.');
  }
  const hashedTeachers = await Promise.all(teachers.map(async (teacher) => ({
    fullName: teacher.fullName,
    passwordHash: await bcrypt.hash(teacher.password, 12),
  })));

  await initializeDatabase();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const teacher of hashedTeachers) {
      await client.query(
        `INSERT INTO teachers (full_name, password_hash)
         VALUES ($1, $2)
         ON CONFLICT (lower(full_name)) DO UPDATE
         SET full_name = EXCLUDED.full_name, password_hash = EXCLUDED.password_hash`,
        [teacher.fullName, teacher.passwordHash],
      );
      await client.query(
        `DELETE FROM teacher_logins
         WHERE teacher_id = (SELECT id FROM teachers WHERE lower(full_name) = lower($1))`,
        [teacher.fullName],
      );
    }
    for (const student of students) {
      await client.query(
        `INSERT INTO students (full_name, email)
         VALUES ($1, $2)
         ON CONFLICT (lower(email)) DO UPDATE
         SET full_name = EXCLUDED.full_name, email = EXCLUDED.email`,
        [student.fullName, student.email],
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  console.log(`Imported ${teachers.length} teachers and ${students.length} students.`);
}

main()
  .catch((error) => {
    console.error('Roster import failed:', error);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
