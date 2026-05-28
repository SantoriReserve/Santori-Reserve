const MAKE_WEBHOOK_URL =
  process.env.MAKE_WEBHOOK_URL ||
  'https://hook.us2.make.com/278a8h6hk8mfurlmgin8k50to0mwe4h5';

const CACHE_TTL_MS = 15 * 60 * 1000;

function getCacheStore() {
  if (!globalThis.__santoriOverviewCache) {
    globalThis.__santoriOverviewCache = new Map();
  }
  return globalThis.__santoriOverviewCache;
}

export function cacheOverview(submissionId, overview) {
  if (!submissionId || !overview) return;
  getCacheStore().set(String(submissionId), {
    overview,
    cachedAt: Date.now()
  });
}

export function getCachedOverview(submissionId) {
  if (!submissionId) return null;
  const entry = getCacheStore().get(String(submissionId));
  if (!entry) return null;
  if (Date.now() - entry.cachedAt > CACHE_TTL_MS) {
    getCacheStore().delete(String(submissionId));
    return null;
  }
  return entry.overview;
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
  const filled = Object.values(json).filter((value) => String(value || '').trim().length > 25);
  return filled.length >= 4 && !isInsufficientOverview(json);
}

export async function forwardFilloutPayloadToMake(payload) {
  console.log('[Santori Make Forward] Sending native Fillout payload to Make');

  const makeRes = await fetch(MAKE_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  const text = await makeRes.text();
  console.log('[Santori Make Forward] Raw response', text.slice(0, 2000));

  if (!makeRes.ok) {
    throw new Error(`Make webhook failed (${makeRes.status}): ${text}`);
  }

  const parsed = extractJsonFromText(text);
  const normalized = normalizeOverviewResponse(parsed);

  if (!hasRenderableOverview(normalized)) {
    throw new Error('Make returned incomplete strategic overview');
  }

  return normalized;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitForCachedOverview(submissionId, attempts = 12, delayMs = 2000) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const cached = getCachedOverview(submissionId);
    if (cached && hasRenderableOverview(cached)) return cached;
    if (attempt < attempts - 1) await sleep(delayMs);
  }
  return null;
}
