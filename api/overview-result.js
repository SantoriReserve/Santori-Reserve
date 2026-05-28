import { cacheOverview, hasRenderableOverview, normalizeOverviewResponse } from './lib/overview-cache.js';

function extractSubmissionId(raw) {
  if (!raw || typeof raw !== 'object') return '';
  return (
    raw.submissionId ||
    raw.submission_id ||
    raw.submissionUuid ||
    raw.id ||
    ''
  );
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const expectedToken = process.env.OVERVIEW_RESULT_TOKEN;
  if (expectedToken) {
    const token = req.headers['x-santori-token'] || req.body?.token || req.query?.token;
    if (token !== expectedToken) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  try {
    const body = req.body?.overview ?? req.body ?? {};
    const submissionId = extractSubmissionId(body) || extractSubmissionId(req.body);
    const normalized = normalizeOverviewResponse(body);

    if (!hasRenderableOverview(normalized)) {
      return res.status(400).json({
        error: 'Invalid overview payload',
        message: 'Overview must include at least four substantive strategic fields.'
      });
    }

    const cacheKey = submissionId || '__latest_submission__';
    cacheOverview(cacheKey, normalized);
    if (submissionId) cacheOverview('__latest_submission__', normalized);

    console.log('[Santori Overview Result] Cached overview from Make callback', { cacheKey });

    return res.status(200).json({
      ok: true,
      submissionId: cacheKey,
      message: 'Strategic overview stored for client retrieval.'
    });
  } catch (error) {
    console.error('[Santori Overview Result] Error', error.message);
    return res.status(500).json({
      error: 'Failed to store overview',
      message: error.message
    });
  }
}
