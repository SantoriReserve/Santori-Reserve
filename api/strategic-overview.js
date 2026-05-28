const MAKE_WEBHOOK_URL =
  process.env.MAKE_WEBHOOK_URL ||
  'https://hook.us2.make.com/278a8h6hk8mfurlmgin8k50to0mwe4h5';

function parseMakeResponse(text) {
  let data = JSON.parse(text);
  if (Array.isArray(data) && data.length) data = data[0];
  if (data && typeof data.body === 'string') {
    try {
      data = JSON.parse(data.body);
    } catch (_error) {
      /* keep original */
    }
  }
  return data;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const assessment = req.body?.assessment ?? req.body ?? {};

    const makeRes = await fetch(MAKE_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source: 'santori-reserve-web',
        timestamp: new Date().toISOString(),
        assessment
      })
    });

    const text = await makeRes.text();
    if (!makeRes.ok) {
      return res.status(makeRes.status).json({ error: 'Make webhook failed', detail: text });
    }

    const json = parseMakeResponse(text);
    return res.status(200).json(json);
  } catch (error) {
    return res.status(500).json({ error: 'Failed to generate strategic overview' });
  }
}
