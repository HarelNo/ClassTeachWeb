function validateAccountPassword(value) {
  if (typeof value !== 'string' || Array.from(value).length < 12) {
    throw new Error('Password must be at least 12 characters.');
  }
  if (Buffer.byteLength(value, 'utf8') > 72) {
    throw new Error("Password must not exceed bcrypt's 72-byte limit.");
  }
  return value;
}

module.exports = { validateAccountPassword };
