import {
  cacheOverview,
  getCachedOverview,
  getRawSubmission,
  hasRenderableOverview,
  tryGenerateOverview,
  waitForCachedOverview
} from './lib/overview-cache.js';

const LATEST_CACHE_KEY = '__latest_submission__';

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

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const rawAssessment = req.body?.assessment ?? req.body ?? {};
    let submissionId = extractSubmissionId(rawAssessment);
    if (!submissionId && rawAssessment.submitted) submissionId = LATEST_CACHE_KEY;

    log('Incoming request', { submissionId, rawAssessment });

    if (submissionId) {
      const immediate = getCachedOverview(submissionId);
      if (immediate && hasRenderableOverview(immediate)) {
        return res.status(200).json(immediate);
      }

      const cached = await waitForCachedOverview(submissionId, 18, 2000);
      if (cached && hasRenderableOverview(cached)) {
        return res.status(200).json(cached);
      }
    }

    const rawPayload = getRawSubmission(submissionId || LATEST_CACHE_KEY);
    if (rawPayload) {
      const generated = await tryGenerateOverview(rawPayload);
      if (generated) {
        const cacheKey = submissionId || LATEST_CACHE_KEY;
        cacheOverview(cacheKey, generated);
        return res.status(200).json(generated);
      }
    }

    return res.status(202).json({
      status: 'pending',
      message: 'Strategic overview is still being generated from your submission.',
      submissionId: submissionId || null
    });
  } catch (error) {
    log('Handler error', error.message);
    return res.status(500).json({
      error: 'Failed to generate strategic overview',
      message: error.message
    });
  }
}
