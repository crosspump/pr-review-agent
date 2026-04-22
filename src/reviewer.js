export async function runReviewWithOpenAICompatible({ model, prompt, apiKey, baseUrl }) {
  if (!apiKey) {
    throw new Error('Missing OPENAI_API_KEY for reviewer model call');
  }

  const endpoint = new URL('/v1/responses', baseUrl || 'https://api.openai.com');
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      input: [
        {
          role: 'system',
          content: [{ type: 'input_text', text: 'Return only strict JSON, no markdown.' }],
        },
        {
          role: 'user',
          content: [{ type: 'input_text', text: prompt }],
        },
      ],
      text: {
        format: {
          type: 'json_object',
        },
      },
    }),
  });

  const raw = await response.text();
  const data = raw ? JSON.parse(raw) : null;

  if (!response.ok) {
    throw new Error(`Reviewer API ${response.status}: ${raw}`);
  }

  const outputText = extractOutputText(data);
  if (!outputText) {
    throw new Error('Reviewer API returned no output text');
  }

  return JSON.parse(outputText);
}

function extractOutputText(response) {
  if (typeof response.output_text === 'string' && response.output_text.trim()) {
    return response.output_text;
  }

  const texts = [];
  for (const item of response.output || []) {
    for (const content of item.content || []) {
      if (content.type === 'output_text' && typeof content.text === 'string') {
        texts.push(content.text);
      }
    }
  }

  return texts.join('\n').trim();
}
