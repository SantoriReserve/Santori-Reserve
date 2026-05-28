import { cacheRawSubmission, countMeaningfulAnswers } from './lib/overview-cache.js';

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

function normalizeFilloutWebhook(rawPayload) {
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
  const meaningfulAnswers = countMeaningfulAnswers(questions);

  return {
    payload,
    submission,
    submissionId: submissionId ? String(submissionId) : '',
    questions,
    meaningfulAnswers,
    isLikelyTestPing: !submissionId && meaningfulAnswers === 0
  };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const normalized = normalizeFilloutWebhook(req.body);
    const { payload, submissionId, meaningfulAnswers, isLikelyTestPing } = normalized;

    console.log('[Santori Fillout Ingest] Received webhook', {
      submissionId,
      meaningfulAnswers,
      isLikelyTestPing
    });

    if (isLikelyTestPing || meaningfulAnswers < 3) {
      return res.status(200).json({
        ok: true,
        message: 'Santori Reserve webhook connected successfully. Real submissions will generate strategic overviews.'
      });
    }

    const cacheKey =
      submissionId ||
      String(normalized.submission.submissionTime || normalized.submission.lastUpdatedAt || Date.now());

    cacheRawSubmission(cacheKey, payload);

    return res.status(200).json({
      ok: true,
      received: true,
      submissionId: cacheKey,
      message: 'Submission received and queued for strategic overview generation.'
    });
  } catch (error) {
    console.error('[Santori Fillout Ingest] Error', error.message);
    return res.status(200).json({
      ok: true,
      message: 'Webhook received. Santori Reserve ingest endpoint is active.'
    });
  }
}
