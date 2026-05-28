import {
  LATEST_CACHE_KEY,
  cacheOverview,
  getCachedOverview,
  hasRenderableOverview,
  resolveFilloutPayload,
  tryGenerateOverview
} from './lib/overview-cache.js';

function log(label, value) {
  console.log(`[Santori Assessment API] ${label}:`, value);
}

function extractSubmissionId(raw) {
  if (!raw || typeof raw !== 'object') return '';
  const nested = raw.submission && typeof raw.submission === 'object' ? raw.submission : null;
  return (
    raw.submissionId ||
    raw.submission_id ||
    raw.submissionUuid ||
    raw.submission_uuid ||
    (nested && nested.submissionId) ||
    (nested && nested.submission_id) ||
    (nested && nested.submissionUuid) ||
    (nested && nested.submission_uuid) ||
    raw.id ||
    (nested && nested.id) ||
    ''
  );
}

function missingConfigMessage() {
  if (process.env.FILLOUT_API_KEY || process.env.OPENAI_API_KEY) return null;
  return 'Server configuration required: add FILLOUT_API_KEY (recommended) or OPENAI_API_KEY in Vercel project settings, then redeploy.';
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const rawAssessment = req.body?.assessment ?? req.body ?? {};
    let submissionId = extractSubmissionId(rawAssessment);
    if (!submissionId && rawAssessment.submitted) submissionId = LATEST_CACHE_KEY;

    log('Incoming request', { submissionId, keys: Object.keys(rawAssessment) });

    const cacheKeys = [submissionId, LATEST_CACHE_KEY].filter(Boolean);
    for (const key of cacheKeys) {
      const immediate = getCachedOverview(key);
      if (immediate && hasRenderableOverview(immediate)) {
        return res.status(200).json(immediate);
      }
    }

    const filloutPayload = await resolveFilloutPayload(rawAssessment);
    if (filloutPayload) {
      const resolvedId =
        submissionId ||
        filloutPayload.submission?.submissionId ||
        filloutPayload.submissionId ||
        LATEST_CACHE_KEY;

      const generated = await tryGenerateOverview(filloutPayload);
      if (generated && hasRenderableOverview(generated)) {
        cacheOverview(resolvedId, generated);
        cacheOverview(LATEST_CACHE_KEY, generated);
        return res.status(200).json(generated);
      }

      log('Generation returned insufficient overview', { resolvedId });
    } else {
      log('No Fillout payload resolved yet', { submissionId });
    }

    const configMessage = missingConfigMessage();
    if (configMessage && rawAssessment.submitted) {
      return res.status(503).json({
        error: 'Configuration required',
        message: configMessage,
        status: 'config_required'
      });
    }

    return res.status(202).json({
      status: 'pending',
      message: 'Strategic overview is still being generated from your submission.',
      submissionId: submissionId && submissionId !== LATEST_CACHE_KEY ? submissionId : null
    });
  } catch (error) {
    log('Handler error', error.message);
    return res.status(500).json({
      error: 'Failed to generate strategic overview',
      message: error.message
    });
  }
}
