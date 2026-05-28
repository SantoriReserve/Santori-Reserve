const MAKE_WEBHOOK_URL =
  process.env.MAKE_WEBHOOK_URL ||
  'https://hook.us2.make.com/278a8h6hk8mfurlmgin8k50to0mwe4h5';

const FILLOUT_API_BASE = process.env.FILLOUT_API_BASE || 'https://api.fillout.com/v1/api';
const FILLOUT_FORM_ID = process.env.FILLOUT_FORM_ID || 'rQVdTg5Eo6us';

const CACHE_TTL_MS = 15 * 60 * 1000;
export const LATEST_CACHE_KEY = '__latest_submission__';

function getCacheStore() {
  if (!globalThis.__santoriOverviewCache) {
    globalThis.__santoriOverviewCache = new Map();
  }
  return globalThis.__santoriOverviewCache;
}

function getEntry(submissionId) {
  if (!submissionId) return null;
  const entry = getCacheStore().get(String(submissionId));
  if (!entry) return null;
  if (Date.now() - entry.cachedAt > CACHE_TTL_MS) {
    getCacheStore().delete(String(submissionId));
    return null;
  }
  return entry;
}

export function cacheOverview(submissionId, overview) {
  if (!submissionId || !overview) return;
  const key = String(submissionId);
  const existing = getEntry(key) || { cachedAt: Date.now() };
  getCacheStore().set(key, { ...existing, overview, cachedAt: Date.now() });
}

export function cacheRawSubmission(submissionId, rawPayload) {
  if (!rawPayload) return;
  const keys = new Set([String(submissionId || ''), LATEST_CACHE_KEY].filter(Boolean));
  keys.forEach((key) => {
    const existing = getEntry(key) || { cachedAt: Date.now() };
    getCacheStore().set(key, { ...existing, rawPayload, cachedAt: Date.now() });
  });
}

export function getCachedOverview(submissionId) {
  return getEntry(submissionId)?.overview || null;
}

export function getRawSubmission(submissionId) {
  return getEntry(submissionId)?.rawPayload || getEntry(LATEST_CACHE_KEY)?.rawPayload || null;
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

export function countMeaningfulAnswers(questions) {
  if (!Array.isArray(questions)) return 0;
  return questions.filter((question) => {
    const value = question?.value ?? question?.answer;
    if (value == null || value === '') return false;
    if (typeof value === 'object' && !Array.isArray(value)) {
      return Object.values(value).some((part) => part != null && String(part).trim() !== '');
    }
    return true;
  }).length;
}

export function formatQuestionsFromPayload(payload) {
  const submission = payload?.submission && typeof payload.submission === 'object' ? payload.submission : payload;
  const questions = submission?.questions || payload?.questions || [];
  if (!Array.isArray(questions)) return '';
  return questions
    .map((question) => {
      const answer = asText(question.value ?? question.answer);
      if (!question.name || !answer) return null;
      return `${question.name}: ${answer}`;
    })
    .filter(Boolean)
    .join('\n');
}

export function extractJsonFromText(text) {
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

export function normalizeOverviewResponse(data) {
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

export function isInsufficientOverview(json) {
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

export function hasRenderableOverview(json) {
  if (!json) return false;
  const filled = Object.values(json).filter((value) => String(value || '').trim().length > 25);
  return filled.length >= 4 && !isInsufficientOverview(json);
}

function buildMakePayloadVariants(payload) {
  const submission = payload?.submission && typeof payload.submission === 'object' ? payload.submission : payload;
  const questions = submission?.questions || payload?.questions || [];
  const flat = {};

  questions.forEach((question) => {
    const value = question?.value ?? question?.answer;
    if (question?.name && value != null && value !== '') {
      flat[question.name] = typeof value === 'object' ? JSON.stringify(value) : value;
    }
  });

  return [
    flat,
    { ...flat, formId: payload?.formId, formName: payload?.formName, submission },
    payload,
    { source: 'santori-reserve-web', timestamp: new Date().toISOString(), assessment: flat, ...flat }
  ];
}

async function callMakeVariant(payload) {
  const makeRes = await fetch(MAKE_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const text = await makeRes.text();
  console.log('[Santori Make Forward] Response', { status: makeRes.status, text: text.slice(0, 1200) });
  if (!makeRes.ok) return null;
  const normalized = normalizeOverviewResponse(extractJsonFromText(text));
  return hasRenderableOverview(normalized) ? normalized : null;
}

async function generateViaOpenAI(formattedAnswers) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey || !formattedAnswers) return null;

  const prompt = [
    'You are a principal strategist at Santori Reserve, a private luxury intelligence house.',
    'Generate a premium strategic business assessment from these onboarding responses.',
    'Return ONLY valid JSON with exactly these keys:',
    '{"overview":"","positioning_priority":"","expansion_priority":"","visibility_priority":"","market_potential":"","revenue_potential":"","blueprint":""}',
    'Never say insufficient data, TBD, pending, or ask for more fields.',
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
  if (!response.ok) return null;
  const payload = JSON.parse(text);
  const content = payload?.choices?.[0]?.message?.content || '';
  const normalized = normalizeOverviewResponse(extractJsonFromText(content));
  return hasRenderableOverview(normalized) ? normalized : null;
}

export async function tryGenerateOverview(rawPayload) {
  const formatted = formatQuestionsFromPayload(rawPayload);
  if (formatted && process.env.OPENAI_API_KEY) {
    const openAiOverview = await generateViaOpenAI(formatted);
    if (openAiOverview) return openAiOverview;
  }

  const variants = buildMakePayloadVariants(rawPayload);
  for (const variant of variants) {
    try {
      const result = await callMakeVariant(variant);
      if (result) return result;
    } catch (error) {
      console.log('[Santori Generate] Make variant failed', error.message);
    }
  }

  if (formatted && process.env.OPENAI_API_KEY) {
    return generateViaOpenAI(formatted);
  }

  return null;
}

function wrapFilloutRecord(record) {
  if (!record) return null;

  const questions = record.submission?.questions || record.questions || [];
  if (!Array.isArray(questions) || questions.length === 0) {
    if (record.submission?.questions || record.questions) return record;
    return null;
  }

  if (record.submission?.questions) return record;

  return {
    formId: record.formId || FILLOUT_FORM_ID,
    submission: {
      submissionId:
        record.submissionId ||
        record.submission_id ||
        record.id ||
        record.submission?.submissionId,
      submissionTime:
        record.submissionTime ||
        record.createdAt ||
        record.lastUpdatedAt ||
        record.submission?.submissionTime ||
        new Date().toISOString(),
      questions
    }
  };
}

export async function fetchSubmissionFromFilloutApi(submissionId) {
  const apiKey = process.env.FILLOUT_API_KEY;
  if (!apiKey || !submissionId) return null;

  const url = `${FILLOUT_API_BASE}/forms/${FILLOUT_FORM_ID}/submissions/${submissionId}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });
  const text = await res.text();
  console.log('[Santori Fillout API] fetch by id', { submissionId, status: res.status });
  if (!res.ok) return null;
  try {
    return wrapFilloutRecord(JSON.parse(text));
  } catch (_error) {
    return null;
  }
}

export async function fetchLatestSubmissionFromFilloutApi(maxAgeMs = 5 * 60 * 1000) {
  const apiKey = process.env.FILLOUT_API_KEY;
  if (!apiKey) return null;

  const url = `${FILLOUT_API_BASE}/forms/${FILLOUT_FORM_ID}/submissions?limit=5&sort=desc`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });
  const text = await res.text();
  console.log('[Santori Fillout API] fetch latest', { status: res.status, text: text.slice(0, 400) });
  if (!res.ok) return null;

  try {
    const data = JSON.parse(text);
    const submissions = data.responses || data.submissions || data.results || data;
    if (!Array.isArray(submissions)) return null;

    const now = Date.now();
    for (const record of submissions) {
      const wrapped = wrapFilloutRecord(record);
      const questions = wrapped?.submission?.questions || wrapped?.questions || [];
      if (countMeaningfulAnswers(questions) < 3) continue;

      const timeStr =
        record.submissionTime ||
        record.createdAt ||
        record.submission?.submissionTime ||
        wrapped?.submission?.submissionTime;
      if (timeStr) {
        const age = now - new Date(timeStr).getTime();
        if (Number.isFinite(age) && age > maxAgeMs) continue;
      }
      return wrapped;
    }
    return null;
  } catch (_error) {
    return null;
  }
}

export async function resolveFilloutPayload(rawAssessment) {
  if (!rawAssessment || typeof rawAssessment !== 'object') return null;

  if (rawAssessment.filloutPayload) return rawAssessment.filloutPayload;
  if (rawAssessment.questions?.length >= 3) {
    return wrapFilloutRecord(rawAssessment);
  }

  const submissionId =
    rawAssessment.submissionId ||
    rawAssessment.submission_id ||
    rawAssessment.submissionUuid ||
    rawAssessment.submission_uuid ||
    rawAssessment.id ||
    '';

  const cachedRaw = getRawSubmission(submissionId || LATEST_CACHE_KEY);
  if (cachedRaw && countMeaningfulAnswers(cachedRaw.submission?.questions || cachedRaw.questions) >= 3) {
    return cachedRaw;
  }

  if (submissionId) {
    const byId = await fetchSubmissionFromFilloutApi(submissionId);
    if (byId) return byId;
  }

  if (rawAssessment.submitted || submissionId) {
    return fetchLatestSubmissionFromFilloutApi();
  }

  return null;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitForCachedOverview(submissionId, attempts = 15, delayMs = 2000) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const cached = getCachedOverview(submissionId);
    if (cached && hasRenderableOverview(cached)) return cached;

    const rawPayload = getRawSubmission(submissionId);
    if (rawPayload && countMeaningfulAnswers(rawPayload.submission?.questions || rawPayload.questions) >= 3) {
      const generated = await tryGenerateOverview(rawPayload);
      if (generated) {
        cacheOverview(submissionId, generated);
        cacheOverview(LATEST_CACHE_KEY, generated);
        return generated;
      }
    }

    if (attempt < attempts - 1) await sleep(delayMs);
  }
  return null;
}
