import { cacheOverview, forwardFilloutPayloadToMake } from './lib/overview-cache.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const payload = req.body ?? {};
    const submissionId =
      payload.submissionId ||
      payload.submission_id ||
      payload.submissionUuid ||
      payload.submission_uuid ||
      payload.id ||
      '';

    console.log('[Santori Fillout Ingest] Received submission', {
      submissionId,
      keys: Object.keys(payload)
    });

    if (!submissionId) {
      return res.status(400).json({ error: 'Missing submissionId in Fillout webhook payload' });
    }

    const overview = await forwardFilloutPayloadToMake(payload);
    cacheOverview(String(submissionId), overview);

    return res.status(200).json({ ok: true, submissionId: String(submissionId) });
  } catch (error) {
    console.error('[Santori Fillout Ingest] Error', error.message);
    return res.status(500).json({ error: 'Failed to process Fillout submission', message: error.message });
  }
}
