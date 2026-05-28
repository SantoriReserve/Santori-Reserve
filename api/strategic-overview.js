const MAKE_WEBHOOK_URL =
  process.env.MAKE_WEBHOOK_URL ||
  'https://hook.us2.make.com/278a8h6hk8mfurlmgin8k50to0mwe4h5';

const FILLOUT_API_BASE = process.env.FILLOUT_API_BASE || 'https://api.fillout.com/v1/api';
const FILLOUT_FORM_ID = process.env.FILLOUT_FORM_ID || 'rQVdTg5Eo6us';

function log(label, value) {
  console.log(`[Santori Assessment API] ${label}:`, value);
}

function slugify(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function asText(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(asText).filter(Boolean).join(', ');
  if (typeof value === 'object') {
    if (value.label) return asText(value.label);
    if (value.value != null) return asText(value.value);
    if (value.text) return asText(value.text);
  }
  return '';
}

function flattenObject(source, acc, prefix) {
  if (!source || typeof source !== 'object') return;
  if (Array.isArray(source)) {
    source.forEach((item) => flattenObject(item, acc, prefix));
    return;
  }

  Object.entries(source).forEach(([key, value]) => {
    if (key.startsWith('_')) return;
    const normalizedKey = slugify(key);
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      if ('value' in value || 'answer' in value || 'text' in value) {
        const text = asText(value.value ?? value.answer ?? value.text);
        if (text) acc[normalizedKey] = text;
      } else {
        flattenObject(value, acc, normalizedKey);
      }
    } else {
      const text = asText(value);
      if (text) acc[normalizedKey] = text;
    }
  });
}

function flattenFilloutQuestions(questions) {
  const flat = {};
  if (!Array.isArray(questions)) return flat;
  questions.forEach((question) => {
    const key = slugify(question.name || question.id);
    const value = asText(question.value ?? question.answer);
    if (key && value) flat[key] = value;
  });
  return flat;
}

function countAssessmentFields(assessment) {
  return Object.keys(assessment || {}).filter((key) => !key.startsWith('_') && assessment[key]).length;
}

function extractSubmissionId(assessment) {
  if (!assessment || typeof assessment !== 'object') return '';
  return (
    assessment.submissionId ||
    assessment.submission_id ||
    assessment.submissionUuid ||
    assessment.submission_uuid ||
    assessment.id ||
    ''
  );
}

async function fetchFilloutSubmission(submissionId) {
  const apiKey = process.env.FILLOUT_API_KEY;
  if (!apiKey || !submissionId) return null;

  const url = `${FILLOUT_API_BASE}/forms/${FILLOUT_FORM_ID}/submissions/${submissionId}`;
  log('Fetching Fillout submission', url);

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${apiKey}` }
  });
  const text = await res.text();
  log('Fillout raw response', text.slice(0, 1200));

  if (!res.ok) {
    log('Fillout fetch failed', { status: res.status, text });
    return null;
  }

  try {
    return JSON.parse(text);
  } catch (error) {
    log('Fillout JSON parse failed', error.message);
    return null;
  }
}

async function enrichAssessment(rawAssessment) {
  const assessment = {};
  flattenObject(rawAssessment, assessment);

  const submissionId = extractSubmissionId(rawAssessment) || extractSubmissionId(assessment);
  if (submissionId) assessment.submission_id = String(submissionId);

  let filloutSubmission = null;

  if (countAssessmentFields(assessment) >= 3) {
    log('Assessment already populated', assessment);
    return { assessment, filloutSubmission };
  }

  if (!submissionId) {
    log('Assessment sparse and no submissionId', assessment);
    return { assessment, filloutSubmission };
  }

  filloutSubmission = await fetchFilloutSubmission(submissionId);
  if (!filloutSubmission) return { assessment, filloutSubmission };

  const fromQuestions = flattenFilloutQuestions(filloutSubmission.questions);
  const fromSubmission = {};
  flattenObject(filloutSubmission, fromSubmission);

  const enriched = { ...fromSubmission, ...fromQuestions, ...assessment, submission_id: String(submissionId) };
  log('Enriched assessment', enriched);
  return { assessment: enriched, filloutSubmission };
}

function buildMakePayload(assessment, filloutSubmission) {
  const payload = {
    source: 'santori-reserve-web',
    timestamp: new Date().toISOString()
  };

  if (filloutSubmission?.questions?.length) {
    payload.questions = filloutSubmission.questions;
    filloutSubmission.questions.forEach((question) => {
      if (question.name != null && question.value != null) {
        payload[question.name] = question.value;
      }
    });
  }

  Object.assign(payload, assessment);
  payload.assessment = assessment;
  return payload;
}

function extractJsonFromText(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) throw new Error('Empty response body');

  try {
    return JSON.parse(trimmed);
  } catch (_directError) {
    /* continue */
  }

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    return JSON.parse(fenced[1].trim());
  }

  const objectMatch = trimmed.match(/\{[\s\S]*\}/);
  if (objectMatch) {
    return JSON.parse(objectMatch[0]);
  }

  throw new Error('Unable to parse JSON from response text');
}

function unwrapResponse(data) {
  let current = data;
  for (let depth = 0; depth < 6; depth += 1) {
    if (!current) break;
    if (typeof current === 'string') {
      current = extractJsonFromText(current);
      continue;
    }
    if (Array.isArray(current) && current.length) {
      current = current[0];
      continue;
    }
    if (typeof current !== 'object') break;

    if (current.overview || current.positioning_priority || current.summary) break;

    const nested =
      current.body ??
      current.result ??
      current.output ??
      current.data ??
      current.response ??
      current.aiResponse ??
      current.strategicOverview ??
      null;

    if (nested == null) break;
    current = nested;
  }
  return current;
}

function normalizeOverviewResponse(data) {
  const source = unwrapResponse(data);
  if (!source || typeof source !== 'object') {
    throw new Error('Response is not an object after unwrapping');
  }

  const normalized = {
    overview: asText(source.overview ?? source.summary ?? source.executive_summary),
    positioning_priority: asText(
      source.positioning_priority ?? source.positioningPriority ?? source.positioning
    ),
    expansion_priority: asText(
      source.expansion_priority ?? source.expansionPriority ?? source.expansion
    ),
    visibility_priority: asText(
      source.visibility_priority ?? source.visibilityPriority ?? source.visibility
    ),
    market_potential: asText(source.market_potential ?? source.marketPotential ?? source.market),
    revenue_potential: asText(source.revenue_potential ?? source.revenuePotential ?? source.revenue),
    blueprint: asText(source.blueprint ?? source.strategic_blueprint ?? source.next_steps)
  };

  log('Normalized overview fields', normalized);
  return normalized;
}

function isInsufficientOverview(json) {
  const combined = Object.values(json).join(' ').toLowerCase();
  return (
    combined.includes('insufficient data') ||
    combined.includes('please provide') ||
    combined.includes('please supply') ||
    combined.includes('awaiting core brand') ||
    combined.includes('awaiting full business') ||
    combined.includes('tbd – awaiting') ||
    combined.includes('tbd - awaiting')
  );
}

function hasRenderableOverview(json) {
  const filled = Object.values(json).filter((value) => String(value || '').trim().length > 20);
  return filled.length >= 3 && !isInsufficientOverview(json);
}

async function callMakeWebhook(assessment, filloutSubmission) {
  const makePayload = buildMakePayload(assessment, filloutSubmission);
  log('POST Make webhook payload', makePayload);

  const makeRes = await fetch(MAKE_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(makePayload)
  });

  const text = await makeRes.text();
  log('Make raw response', text.slice(0, 2000));

  if (!makeRes.ok) {
    throw new Error(`Make webhook failed (${makeRes.status}): ${text}`);
  }

  const parsed = extractJsonFromText(text);
  const normalized = normalizeOverviewResponse(parsed);
  return normalized;
}

async function generateViaOpenAI(assessment) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;

  const prompt = [
    'You are a principal strategist at Santori Reserve, a private luxury intelligence house.',
    'Generate a premium strategic business assessment from the provided onboarding responses.',
    'Return ONLY valid JSON. No markdown. No commentary.',
    'Use exactly these keys:',
    '{"overview":"","positioning_priority":"","expansion_priority":"","visibility_priority":"","market_potential":"","revenue_potential":"","blueprint":""}',
    'Requirements:',
    '- overview: 80-120 words, executive intelligence tone',
    '- each priority field: 35-70 words with concrete strategic direction',
    '- market_potential and revenue_potential must include realistic ranges and commercial logic',
    '- blueprint: actionable 60-day strategic architecture',
    '- never say insufficient data; infer carefully from available inputs when partial',
    '- tone: luxury consulting memo, not startup coach',
    `Assessment data: ${JSON.stringify(assessment)}`
  ].join('\n');

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
      temperature: 0.4,
      response_format: { type: 'json_object' },
      messages: [{ role: 'user', content: prompt }]
    })
  });

  const text = await response.text();
  log('OpenAI raw response', text.slice(0, 2000));
  if (!response.ok) return null;

  const payload = JSON.parse(text);
  const content = payload?.choices?.[0]?.message?.content || '';
  return normalizeOverviewResponse(extractJsonFromText(content));
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const rawAssessment = req.body?.assessment ?? req.body ?? {};
    log('Incoming request body', rawAssessment);

    const { assessment, filloutSubmission } = await enrichAssessment(rawAssessment);
    if (countAssessmentFields(assessment) < 2) {
      log('Missing assessment fields after enrichment', assessment);
      return res.status(422).json({
        error: 'Assessment data missing',
        message: 'Unable to retrieve Fillout submission answers. Add FILLOUT_API_KEY in Vercel and ensure submissionId is sent.'
      });
    }

    let overview = await callMakeWebhook(assessment, filloutSubmission);
    if (!hasRenderableOverview(overview)) {
      log('Make returned insufficient overview, attempting OpenAI fallback', overview);
      const openAiOverview = await generateViaOpenAI(assessment);
      if (openAiOverview && hasRenderableOverview(openAiOverview)) {
        overview = openAiOverview;
      }
    }

    if (!hasRenderableOverview(overview)) {
      log('Final overview still insufficient', overview);
      return res.status(502).json({
        error: 'Overview generation failed',
        message: 'AI response did not contain enough strategic content.',
        debug: overview
      });
    }

    return res.status(200).json(overview);
  } catch (error) {
    log('Handler error', error.message);
    return res.status(500).json({ error: 'Failed to generate strategic overview', message: error.message });
  }
}
