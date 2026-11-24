require('dotenv').config();

const bcrypt = require('bcryptjs');
const { Manager } = require('./models');
const { validateAccountPassword } = require('./accounts');

function promptHidden(label) {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') {
    throw new Error('Run this command in an interactive terminal so the password can be entered privately.');
  }

  return new Promise((resolve, reject) => {
    let passwordBytes = Buffer.alloc(0);
    const cleanup = () => {
      process.stdin.removeListener('data', onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write('\n');
    };
    const onData = (chunk) => {
      for (const byte of chunk) {
        if (byte === 3) {
          cleanup();
          reject(new Error('Password entry cancelled.'));
          return;
        }
        if (byte === 13 || byte === 10) {
          cleanup();
          resolve(passwordBytes.toString('utf8'));
          return;
        }
        if (byte === 8 || byte === 127) {
          let start = Math.max(0, passwordBytes.length - 1);
          while (start > 0 && (passwordBytes[start] & 0xc0) === 0x80) start -= 1;
          passwordBytes = passwordBytes.subarray(0, start);
        } else if (byte >= 32) {
          passwordBytes = Buffer.concat([passwordBytes, Buffer.from([byte])]);
        }
      }
    };

    process.stdout.write(label);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', onData);
  });
}

async function main() {
  const fullName = Manager.validateName(process.argv.slice(2).join(' '));
  const password = validateAccountPassword(await promptHidden('Password (hidden): '));
  const confirmation = await promptHidden('Confirm password (hidden): ');
  if (password !== confirmation) throw new Error('Passwords do not match.');

  const { initializeDatabase, pool } = require('./database');
  await initializeDatabase();
  const passwordHash = await bcrypt.hash(password, 12);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `INSERT INTO managers (full_name, password_hash) VALUES ($1, $2)
       ON CONFLICT (lower(full_name)) DO UPDATE
       SET full_name = EXCLUDED.full_name, password_hash = EXCLUDED.password_hash
       RETURNING id`,
      [fullName, passwordHash],
    );
    await client.query('DELETE FROM manager_logins WHERE manager_id = $1', [result.rows[0].id]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  console.log(`Manager account "${fullName}" created or updated.`);
}

if (require.main === module) {
  let pool;
  main()
    .catch((error) => {
      console.error('Manager account setup failed:', error.message);
      process.exitCode = 1;
    })
    .finally(() => {
      if (process.env.DATABASE_URL) {
        pool = require('./database').pool;
        return pool.end();
      }
      return undefined;
    });
}

module.exports = { promptHidden };
