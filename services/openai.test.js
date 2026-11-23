const test = require('node:test');
const assert = require('node:assert/strict');
const { generateText } = require('./openai');

test('AI features fail explicitly when no API key is configured', async () => {
  const previous = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    await assert.rejects(generateText('instructions', 'input'), {
      message: /Set OPENAI_API_KEY/,
      status: 503,
    });
  } finally {
    if (previous === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previous;
  }
});

test('AI adapter returns provider output without making a real network request', async () => {
  const previousKey = process.env.OPENAI_API_KEY;
  const previousFetch = global.fetch;
  process.env.OPENAI_API_KEY = 'test-key';
  global.fetch = async (url, options) => {
    assert.equal(url, 'https://api.openai.com/v1/responses');
    assert.equal(options.headers.Authorization, 'Bearer test-key');
    return {
      ok: true,
      json: async () => ({ output: [{ content: [{ type: 'output_text', text: '  A concise summary.  ' }] }] }),
    };
  };
  try {
    assert.equal(await generateText('summarize', 'transcript'), 'A concise summary.');
  } finally {
    global.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
  }
});
