const OPENAI_ENDPOINT = 'https://api.openai.com/v1/responses';

async function generateText(instructions, input) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    const error = new Error('OpenAI is not configured. Set OPENAI_API_KEY to enable AI features.');
    error.status = 503;
    throw error;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60000);
  try {
    const response = await fetch(OPENAI_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
        instructions,
        input,
      }),
      signal: controller.signal,
    });
    const result = await response.json();
    if (!response.ok) {
      const error = new Error(`OpenAI request failed (${response.status}).`);
      error.status = 502;
      throw error;
    }
    const text = result.output_text || (Array.isArray(result.output)
      ? result.output.flatMap((item) => item.content || [])
        .filter((part) => part.type === 'output_text')
        .map((part) => part.text)
        .join('\n')
      : '');
    if (typeof text !== 'string' || !text.trim()) {
      const error = new Error('OpenAI returned no text output.');
      error.status = 502;
      throw error;
    }
    return text.trim();
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = { generateText };
