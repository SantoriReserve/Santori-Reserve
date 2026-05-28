import { cacheOverview, forwardFilloutPayloadToMake } from './lib/overview-cache.js';

function parseBody(body) {
  if (!body) return {};
  if (typeof body === 'string') {
    try {
      return JSON.parse(body);
    } catch (_error) {
      return {};
    }
  }
  return body;
}

export function normalizeFilloutWebhook(rawPayload) {
  const payload = parseBody(rawPayload);
  const submission = payload.submission && typeof payload.submission === 'object' ? payload.submission : payload;

  const submissionId =
    submission.submissionId ||
    submission.submission_id ||
    submission.submissionUuid ||
    submission.submission_uuid ||
    payload.submissionId ||
    payload.submission_id ||
    payload.submissionUuid ||
    payload.submission_uuid ||
    submission.id ||
    payload.id ||
    '';

  const questions = submission.questions || payload.questions || [];
  const hasAnswers = Array.isArray(questions) && questions.some((q) => q && (q.value != null && q.value !== ''));

  return {
    payload,
    submission,
    submissionId: submissionId ? String(submissionId) : '',
    questions,
    hasAnswers,
    isLikelyTestPing: !submissionId && !hasAnswers
  };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const normalized = normalizeFilloutWebhook(req.body);
    const { payload, submissionId, questions, hasAnswers, isLikelyTestPing } = normalized;

    console.log('[Santori Fillout Ingest] Received webhook', {
      submissionId,
      hasAnswers,
      isLikelyTestPing,
      topLevelKeys: Object.keys(payload || {}),
      submissionKeys: Object.keys(normalized.submission || {})
    });

    if (isLikelyTestPing) {
      return res.status(200).json({
        ok: true,
        message: 'Santori Reserve webhook endpoint is ready. Submit the form to generate a strategic overview.'
      });
    }

    const cacheKey =
      submissionId ||
      String(normalized.submission.submissionTime || normalized.submission.lastUpdatedAt || Date.now());

    const makePayload = payload.submission ? payload : { ...payload, questions };

    const overview = await forwardFilloutPayloadToMake(makePayload);
    cacheOverview(cacheKey, overview);

    return res.status(200).json({ ok: true, submissionId: cacheKey });
  } catch (error) {
    console.error('[Santori Fillout Ingest] Error', error.message);
    return res.status(500).json({ error: 'Failed to process Fillout submission', message: error.message });
  }
}
