function validateChatMessage(value) {
  const message = typeof value === 'string' ? value.trim() : '';
  if (!message || message.length > 1000) {
    throw new Error('Chat messages must contain 1-1,000 characters.');
  }
  return message;
}

module.exports = { validateChatMessage };
