const MAKE_WEBHOOK_URL =
  process.env.MAKE_WEBHOOK_URL ||
  'https://hook.us2.make.com/278a8h6hk8mfurlmgin8k50to0mwe4h5';

const FILLOUT_API_BASE = process.env.FILLOUT_API_BASE || 'https://api.fillout.com/v1/api';
const FILLOUT_FORM_ID = process.env.FILLOUT_FORM_ID || 'rQVdTg5Eo6us';
const FILLOUT_FETCH_ATTEMPTS = 4;
const FILLOUT_FETCH_DELAY_MS = 1500;

function log(label, value) {
  console.log(`[Santori Assessment API] ${label}:`, value);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function flattenObject(source, acc) {
  if (!source || typeof source !== 'object') return;
  if (Array.isArray(source)) {
    source.forEach((item) => flattenObject(item, acc));
    return;
  }

  Object.entries(source).forEach(([key, value]) => {
    if (key.startsWith('_')) return;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      if ('value' in value || 'answer' in value || 'text' in value) {
        const text = asText(value.value ?? value.answer ?? value.text);
        if (text) acc[slugify(key)] = text;
      } else {
        flattenObject(value, acc);
      }
    } else {
      const text = asText(value);
      if (text) acc[slugify(key)] = text;
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

function countAssessmentFields(assessment, filloutSubmission) {
  const meaningfulKeys = Object.keys(assessment || {}).filter(
    (key) => !key.startsWith('_') && key !== 'submission_id' && key !== 'submitted' && assessment[key]
  );
  let count = meaningfulKeys.length;
  if (filloutSubmission?.questions?.length) {
    const answered = filloutSubmission.questions.filter((q) => asText(q.value ?? q.answer)).length;
    count = Math.max(count, answered);
  }
  return count;
}

function extractSubmissionId(rawAssessment) {
  if (!rawAssessment || typeof rawAssessment !== 'object') return '';
  return (
    rawAssessment.submissionId ||
    rawAssessment.submission_id ||
    rawAssessment.submissionUuid ||
    rawAssessment.submission_uuid ||
    rawAssessment.id ||
    ''
  );
}

function formatAssessmentForPrompt(assessment, filloutSubmission) {
  const lines = [];
  if (filloutSubmission?.questions?.length) {
    filloutSubmission.questions.forEach((question) => {
      const answer = asText(question.value ?? question.answer);
      if (answer) lines.push(`${question.name}: ${answer}`);
    });
  }
  Object.entries(assessment || {}).forEach(([key, value]) => {
    if (key.startsWith('_') || key === 'submission_id' || key === 'submitted') return;
    if (value) lines.push(`${key}: ${value}`);
  });
  return lines.join('\n');
}

async function fetchFilloutSubmission(submissionId) {
  const apiKey = process.env.FILLOUT_API_KEY;
  if (!apiKey || !submissionId) return null;

  const url = `${FILLOUT_API_BASE}/forms/${FILLOUT_FORM_ID}/submissions/${submissionId}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${apiKey}` }
  });
  const text = await res.text();
  log('Fillout submission fetch', { submissionId, status: res.status, text: text.slice(0, 800) });

  if (!res.ok) return null;
  try {
    return JSON.parse(text);
  } catch (error) {
    log('Fillout JSON parse failed', error.message);
    return null;
  }
}

async function fetchLatestFilloutSubmission() {
  const apiKey = process.env.FILLOUT_API_KEY;
  if (!apiKey) return null;

  const url = `${FILLOUT_API_BASE}/forms/${FILLOUT_FORM_ID}/submissions?limit=1&sort=desc`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${apiKey}` }
  });
  const text = await res.text();
  log('Fillout latest submission fetch', { status: res.status, text: text.slice(0, 800) });

  if (!res.ok) return null;
  try {
    const data = JSON.parse(text);
    const submissions = data.responses || data.submissions || data.results || data;
    if (Array.isArray(submissions) && submissions.length) return submissions[0];
    return null;
  } catch (error) {
    log('Fillout latest parse failed', error.message);
    return null;
  }
}

async function resolveFilloutSubmission(submissionId, allowLatest) {
  for (let attempt = 0; attempt < FILLOUT_FETCH_ATTEMPTS; attempt += 1) {
    if (submissionId) {
      const byId = await fetchFilloutSubmission(submissionId);
      if (byId?.questions?.length) return byId;
    }
    if (allowLatest) {
      const latest = await fetchLatestFilloutSubmission();
      if (latest?.questions?.length) return latest;
    }
    if (attempt < FILLOUT_FETCH_ATTEMPTS - 1) {
      await sleep(FILLOUT_FETCH_DELAY_MS);
    }
  }
  return null;
}

async function enrichAssessment(rawAssessment) {
  const assessment = {};
  flattenObject(rawAssessment, assessment);

  const submissionId = extractSubmissionId(rawAssessment) || extractSubmissionId(assessment);
  const submittedFlag = Boolean(rawAssessment.submitted || assessment.submitted);
  if (submissionId) assessment.submission_id = String(submissionId);

  let filloutSubmission = null;

  if (countAssessmentFields(assessment, null) >= 4) {
    log('Assessment already populated from frontend', assessment);
    return { assessment, filloutSubmission };
  }

  if (!process.env.FILLOUT_API_KEY) {
    log('FILLOUT_API_KEY missing on server');
    return { assessment, filloutSubmission };
  }

  filloutSubmission = await resolveFilloutSubmission(
    submissionId,
    submittedFlag || !submissionId
  );

  if (!filloutSubmission) {
    log('Could not resolve Fillout submission', { submissionId, submittedFlag });
    return { assessment, filloutSubmission };
  }

  const fromQuestions = flattenFilloutQuestions(filloutSubmission.questions);
  const fromSubmission = {};
  flattenObject(filloutSubmission, fromSubmission);
  const resolvedId = submissionId || filloutSubmission.submissionId || filloutSubmission.submission_id || '';

  const enriched = {
    ...fromSubmission,
    ...fromQuestions,
    ...assessment,
    submission_id: resolvedId ? String(resolvedId) : assessment.submission_id
  };

  log('Enriched assessment', enriched);
  return { assessment: enriched, filloutSubmission };
}

function buildMakePayload(assessment, filloutSubmission) {
  if (filloutSubmission) {
    const payload = { ...filloutSubmission };
    if (filloutSubmission.questions?.length) {
      filloutSubmission.questions.forEach((question) => {
        if (question.name != null && question.value != null) {
          payload[question.name] = question.value;
        }
      });
    }
    payload.source = 'santori-reserve-web';
    payload.timestamp = new Date().toISOString();
    payload.assessment = assessment;
    return payload;
  }

  return {
    source: 'santori-reserve-web',
    timestamp: new Date().toISOString(),
    assessment,
    ...assessment
  };
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
  if (fenced) return JSON.parse(fenced[1].trim());

  const objectMatch = trimmed.match(/\{[\s\S]*\}/);
  if (objectMatch) return JSON.parse(objectMatch[0]);

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

  return {
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
}

function isInsufficientOverview(json) {
  const combined = Object.values(json).join(' ').toLowerCase();
  return (
    combined.includes('insufficient') ||
    combined.includes('please provide') ||
    combined.includes('please supply') ||
    combined.includes('please resubmit') ||
    combined.includes('awaiting') ||
    combined.includes('pending –') ||
    combined.includes('pending -') ||
    combined.includes('undefined until') ||
    combined.includes('undetermined without') ||
    combined.includes('cannot estimate') ||
    combined.includes('not calculable') ||
    combined.includes('tbd') ||
    combined.includes('n/a')
  );
}

function hasRenderableOverview(json) {
  const filled = Object.values(json).filter((value) => String(value || '').trim().length > 25);
  return filled.length >= 4 && !isInsufficientOverview(json);
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
  return normalizeOverviewResponse(parsed);
}

async function generateViaOpenAI(assessment, filloutSubmission) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;

  const formattedAnswers = formatAssessmentForPrompt(assessment, filloutSubmission);
  const prompt = [
    'You are a principal strategist at Santori Reserve, a private luxury intelligence house.',
    'Generate a premium strategic business assessment from these onboarding responses.',
    'Return ONLY valid JSON with exactly these keys:',
    '{"overview":"","positioning_priority":"","expansion_priority":"","visibility_priority":"","market_potential":"","revenue_potential":"","blueprint":""}',
    'Rules:',
    '- Never say insufficient data, TBD, pending, or ask for more fields.',
    '- Use the provided answers directly and infer intelligently where needed.',
    '- overview: 90-120 words, executive luxury consulting tone.',
    '- each priority field: 40-70 words with specific strategic direction.',
    '- market_potential and revenue_potential must include realistic commercial ranges.',
    '- blueprint: concrete 60-day strategic architecture.',
    'Assessment responses:',
    formattedAnswers
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

async function generateOverview(assessment, filloutSubmission) {
  if (process.env.OPENAI_API_KEY) {
    const openAiFirst = await generateViaOpenAI(assessment, filloutSubmission);
    if (hasRenderableOverview(openAiFirst)) return openAiFirst;
  }

  const makeOverview = await callMakeWebhook(assessment, filloutSubmission);
  if (hasRenderableOverview(makeOverview)) return makeOverview;

  if (process.env.OPENAI_API_KEY) {
    const openAiFallback = await generateViaOpenAI(assessment, filloutSubmission);
    if (hasRenderableOverview(openAiFallback)) return openAiFallback;
  }

  return makeOverview;
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
    const fieldCount = countAssessmentFields(assessment, filloutSubmission);

    if (fieldCount < 2) {
      return res.status(422).json({
        error: 'Assessment data missing',
        message:
          'Could not load your Fillout answers. Confirm FILLOUT_API_KEY is set in Vercel, redeploy, then submit the form again.'
      });
    }

    const overview = await generateOverview(assessment, filloutSubmission);

    if (!hasRenderableOverview(overview)) {
      return res.status(502).json({
        error: 'Overview generation failed',
        message:
          'AI generation returned incomplete content. Add OPENAI_API_KEY in Vercel for reliable generation, or update your Make webhook field mapping.',
        debug: overview
      });
    }

    return res.status(200).json(overview);
  } catch (error) {
    log('Handler error', error.message);
    return res.status(500).json({
      error: 'Failed to generate strategic overview',
      message: error.message
    });
  }
}
