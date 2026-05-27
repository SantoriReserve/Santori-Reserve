function json(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

function withMeta(result, source) {
  return {
    status: 'ready',
    source,
    generatedAt: new Date().toISOString(),
    summary: result.summary,
    cards: result.cards
  };
}

function parseGeneratedResult(data) {
  if (!data || typeof data !== 'object') return null;

  const candidates = [
    data,
    data.result,
    data.output,
    data.data,
    data.overview,
    data.strategicOverview,
    data.aiResponse
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (candidate && typeof candidate.summary === 'string' && Array.isArray(candidate.cards)) {
      return {
        summary: candidate.summary,
        cards: candidate.cards.map((card) => ({
          title: String(card.title || 'Strategic Lens'),
          body: String(card.body || '')
        }))
      };
    }
  }
  return null;
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

function asText(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(asText).filter(Boolean).join(', ');
  if (typeof value === 'object') {
    if (value.label) return asText(value.label);
    if (value.value) return asText(value.value);
    if (value.text) return asText(value.text);
    return '';
  }
  return '';
}

function flattenAnswers(source, acc) {
  if (!source) return;
  if (Array.isArray(source)) {
    source.forEach((item) => flattenAnswers(item, acc));
    return;
  }
  if (typeof source !== 'object') return;

  const key = asText(source.question || source.title || source.name || source.key || source.id).toLowerCase();
  const value = asText(source.answer || source.value || source.response || source.text);
  if (key && value) acc[key] = value;

  Object.keys(source).forEach((field) => {
    const nested = source[field];
    if (nested && typeof nested === 'object') flattenAnswers(nested, acc);
  });
}

function pickField(flat, aliases) {
  for (const [key, value] of Object.entries(flat)) {
    if (aliases.some((alias) => key.includes(alias))) return value;
  }
  return '';
}

function normalizeAssessment(rawAssessment) {
  const flat = {};
  flattenAnswers(rawAssessment, flat);
  return {
    industry: pickField(flat, ['industry', 'category', 'vertical']),
    market: pickField(flat, ['market', 'region', 'geograph', 'country']),
    visibilityLevel: pickField(flat, ['visibility', 'awareness', 'presence', 'exposure']),
    revenueGoals: pickField(flat, ['revenue', 'sales', 'target']),
    expansionInterest: pickField(flat, ['expansion', 'new market', 'international']),
    currentStage: pickField(flat, ['stage', 'phase', 'current']),
    audience: pickField(flat, ['audience', 'customer', 'client', 'buyer']),
    platforms: pickField(flat, ['platform', 'channel', 'social', 'site']),
    timeCommitment: pickField(flat, ['time', 'hours', 'commitment']),
    biggestChallenges: pickField(flat, ['challenge', 'obstacle', 'pain']),
    fullPayload: rawAssessment || {}
  };
}

async function generateViaOpenAI(assessment) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;

  const normalized = normalizeAssessment(assessment);

  const prompt = [
    'You are a principal strategist at Santori Reserve, a private luxury intelligence house.',
    'Generate a premium, believable strategic overview from real onboarding responses.',
    'Avoid generic motivation. Sound like a luxury consulting intelligence memo.',
    'Output strict JSON with this shape:',
    '{"summary":"...", "cards":[{"title":"Positioning Observation","body":"..."},{"title":"Visibility Gap","body":"..."},{"title":"Expansion Priority","body":"..."},{"title":"Revenue Potential Range","body":"..."},{"title":"Strategic Next-Step Architecture","body":"..."}]}',
    'Constraints:',
    '- summary: 70-110 words',
    '- each card body: 30-60 words',
    '- card insights must directly reference provided inputs where available',
    '- include realistic revenue range language in the Revenue Potential Range card',
    '- if data is missing, state uncertainty elegantly without inventing specifics',
    `Normalized assessment fields: ${JSON.stringify(normalized)}`,
    `Raw assessment payload: ${JSON.stringify(assessment || {})}`
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
  return parseGeneratedResult(data);
}

function fallbackResult() {
  return {
    summary:
      'Your submission indicates meaningful luxury growth potential, with immediate upside tied to stronger positioning clarity, tighter visibility architecture, and disciplined market sequencing. The next phase should prioritize converting brand perception into measurable commercial momentum while preserving exclusivity and pricing power across expansion channels.',
    cards: [
      {
        title: 'Positioning Observation',
        body: 'Current brand signals appear directionally strong but insufficiently codified across channels. A more explicit authority narrative should anchor messaging, pricing confidence, and differentiation at every high-intent touchpoint.'
      },
      {
        title: 'Visibility Gap',
        body: 'Visibility appears present but not yet architecture-led. Focus should shift from activity volume to selective placements, editorial leverage, and partnership sequencing that compounds credibility in priority markets.'
      },
      {
        title: 'Expansion Priority',
        body: 'Expansion should be staged by market readiness and cultural fit rather than broad rollout. A two-wave model typically improves conversion quality and reduces acquisition inefficiency in premium segments.'
      },
      {
        title: 'Revenue Potential Range',
        body: 'With disciplined execution, near-term uplift commonly sits within a measured 12-28% revenue opportunity band over 60-90 days, contingent on positioning consistency and high-quality visibility activation.'
      },
      {
        title: 'Strategic Next-Step Architecture',
        body: 'Recommended next step: lock a 60-day strategic blueprint spanning narrative refinement, market-entry sequencing, partnership mapping, and an execution cadence with weekly intelligence checkpoints.'
      }
    ]
  };
}

export default async function handler(req, res) {
  if (!['POST', 'GET'].includes(req.method)) {
    res.setHeader('Allow', 'POST, GET');
    return json(res, 405, { error: 'Method not allowed' });
  }

  try {
    if (req.method === 'GET') {
      const requestId = req.query && req.query.requestId ? String(req.query.requestId) : '';
      const jobId = req.query && req.query.jobId ? String(req.query.jobId) : '';
      if (!requestId) {
        return json(res, 400, { error: 'Missing requestId' });
      }

      const makeStatusUrl = process.env.MAKE_STATUS_URL;
      const makeWebhookUrl = process.env.MAKE_WEBHOOK_URL;

      if (makeStatusUrl) {
        const statusUrl = new URL(makeStatusUrl);
        statusUrl.searchParams.set('requestId', requestId);
        if (jobId) statusUrl.searchParams.set('jobId', jobId);

        const statusRes = await fetch(statusUrl.toString(), { method: 'GET' });
        const statusData = await statusRes.json().catch(() => ({}));
        const readyFromStatus = parseGeneratedResult(statusData);
        if (readyFromStatus) return json(res, 200, withMeta(readyFromStatus, 'make'));
      } else if (makeWebhookUrl) {
        // Fallback polling path: call the same Make webhook in status mode.
        const statusRes = await fetch(makeWebhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mode: 'status', requestId, jobId })
        });
        const statusData = await statusRes.json().catch(() => ({}));
        const readyFromWebhook = parseGeneratedResult(statusData);
        if (readyFromWebhook) return json(res, 200, withMeta(readyFromWebhook, 'make'));
      }

      return json(res, 202, {
        status: 'pending',
        requestId,
        jobId: jobId || null,
        message: 'Strategic overview is still being generated. Please retry shortly.'
      });
    }

    const assessment = req.body && req.body.assessment ? req.body.assessment : req.body;
    const requestId =
      (req.body && req.body.requestId && String(req.body.requestId)) ||
      `sr_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    const makeWebhookUrl = process.env.MAKE_WEBHOOK_URL;

    if (makeWebhookUrl) {
      const makeStartRes = await fetch(makeWebhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source: 'santori-reserve-web',
          mode: 'start',
          requestId,
          timestamp: new Date().toISOString(),
          assessment
        })
      });
      const makeStartData = await makeStartRes.json().catch(() => ({}));
      const readyFromStart = parseGeneratedResult(makeStartData);
      if (readyFromStart) return json(res, 200, withMeta(readyFromStart, 'make'));

      return json(res, 202, {
        status: 'pending',
        requestId: String(makeStartData.requestId || requestId),
        jobId: makeStartData.jobId ? String(makeStartData.jobId) : null,
        message: 'Strategic overview generation started.'
      });
    }

    const openAiResult = await generateViaOpenAI(assessment);
    if (openAiResult) return json(res, 200, withMeta(openAiResult, 'openai'));

    if (process.env.ALLOW_LOCAL_FALLBACK_OVERVIEW === 'true') {
      return json(res, 200, withMeta(fallbackResult(), 'fallback'));
    }
    return json(res, 202, {
      status: 'pending',
      message: 'Strategic overview is still being generated. Please retry shortly.'
    });
  } catch (_error) {
    return json(res, 202, {
      status: 'pending',
      message: 'Strategic overview generation is in progress. Please retry shortly.'
    });
  }
}
