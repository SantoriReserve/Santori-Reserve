function json(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

function parseAiResponse(content) {
  try {
    const parsed = JSON.parse(content);
    if (!parsed || typeof parsed.summary !== 'string' || !Array.isArray(parsed.cards)) {
      return null;
    }
    return {
      summary: parsed.summary,
      cards: parsed.cards.map((card) => ({
        title: String(card.title || 'Strategic Lens'),
        body: String(card.body || '')
      }))
    };
  } catch (_error) {
    return null;
  }
}

async function generateViaOpenAI(assessment) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;

  const prompt = [
    'You are a luxury brand strategist for Santori Reserve.',
    'Generate a concise strategic overview from assessment data.',
    'Output strict JSON with this shape:',
    '{"summary":"...", "cards":[{"title":"...", "body":"..."},{"title":"...", "body":"..."},{"title":"...", "body":"..."}]}',
    'Keep summary under 90 words and each card body under 45 words.',
    `Assessment payload: ${JSON.stringify(assessment || {})}`
  ].join('\n');

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
      temperature: 0.5,
      messages: [{ role: 'user', content: prompt }]
    })
  });

  if (!response.ok) return null;
  const data = await response.json();
  const content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  return parseAiResponse(content || '');
}

async function generateViaMake(assessment) {
  const webhookUrl = process.env.MAKE_WEBHOOK_URL;
  if (!webhookUrl) return null;

  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      source: 'santori-reserve-web',
      timestamp: new Date().toISOString(),
      assessment
    })
  });

  if (!response.ok) return null;
  const data = await response.json().catch(() => null);
  if (!data || typeof data.summary !== 'string' || !Array.isArray(data.cards)) return null;

  return {
    summary: data.summary,
    cards: data.cards.map((card) => ({
      title: String(card.title || 'Strategic Lens'),
      body: String(card.body || '')
    }))
  };
}

function fallbackResult() {
  return {
    summary:
      'Your brand demonstrates high luxury positioning potential. Priority focus should center on narrative precision, market-entry sequencing, and premium visibility partnerships to accelerate expansion outcomes over the next 60 days.',
    cards: [
      {
        title: 'Narrative Architecture',
        body: 'Unify your brand story around one dominant authority signal and reinforce it across all public touchpoints.'
      },
      {
        title: 'Market Sequence',
        body: 'Stage expansion by readiness score and cultural fit to reduce entry friction and increase early traction.'
      },
      {
        title: 'Visibility Strategy',
        body: 'Prioritize editorial and strategic partnerships that compound perception, trust, and qualified demand.'
      }
    ]
  };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return json(res, 405, { error: 'Method not allowed' });
  }

  try {
    const assessment = req.body && req.body.assessment ? req.body.assessment : req.body;
    const makeResult = await generateViaMake(assessment);
    if (makeResult) return json(res, 200, makeResult);

    const openAiResult = await generateViaOpenAI(assessment);
    if (openAiResult) return json(res, 200, openAiResult);

    return json(res, 200, fallbackResult());
  } catch (_error) {
    return json(res, 200, fallbackResult());
  }
}
