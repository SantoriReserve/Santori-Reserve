import {
  cacheOverview,
  extractJsonFromText,
  forwardFilloutPayloadToMake,
  getCachedOverview,
  hasRenderableOverview,
  normalizeOverviewResponse,
  waitForCachedOverview
} from './lib/overview-cache.js';

const FILLOUT_API_BASE = process.env.FILLOUT_API_BASE || 'https://api.fillout.com/v1/api';
const FILLOUT_FORM_ID = process.env.FILLOUT_FORM_ID || 'rQVdTg5Eo6us';

function log(label, value) {
  console.log(`[Santori Assessment API] ${label}:`, value);
}

function extractSubmissionId(raw) {
  if (!raw || typeof raw !== 'object') return '';
  return (
    raw.submissionId ||
    raw.submission_id ||
    raw.submissionUuid ||
    raw.submission_uuid ||
    raw.id ||
    ''
  );
}

async function fetchFilloutSubmission(submissionId) {
  const apiKey = process.env.FILLOUT_API_KEY;
  if (!apiKey || !submissionId) return null;

  const url = `${FILLOUT_API_BASE}/forms/${FILLOUT_FORM_ID}/submissions/${submissionId}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });
  const text = await res.text();
  log('Fillout fetch', { submissionId, status: res.status, text: text.slice(0, 500) });
  if (!res.ok) return null;
  try {
    return JSON.parse(text);
  } catch (_error) {
    return null;
  }
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
  return normalizeOverviewResponse(extractJsonFromText(content));
}

function formatQuestions(questions) {
  if (!Array.isArray(questions)) return '';
  return questions
    .map((q) => {
      const answer = q.value ?? q.answer;
      if (!answer) return null;
      return `${q.name}: ${answer}`;
    })
    .filter(Boolean)
    .join('\n');
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const rawAssessment = req.body?.assessment ?? req.body ?? {};
    const submissionId = extractSubmissionId(rawAssessment);
    log('Incoming request', { submissionId, rawAssessment });

    if (submissionId) {
      const immediate = getCachedOverview(submissionId);
      if (immediate && hasRenderableOverview(immediate)) {
        log('Returning immediately cached overview', submissionId);
        return res.status(200).json(immediate);
      }

      const cached = await waitForCachedOverview(submissionId, 15, 2000);
      if (cached && hasRenderableOverview(cached)) {
        log('Returning cached overview after wait', submissionId);
        return res.status(200).json(cached);
      }
    }

    if (process.env.FILLOUT_API_KEY && submissionId) {
      const filloutSubmission = await fetchFilloutSubmission(submissionId);
      if (filloutSubmission?.questions?.length) {
        try {
          const overview = await forwardFilloutPayloadToMake(filloutSubmission);
          cacheOverview(submissionId, overview);
          return res.status(200).json(overview);
        } catch (error) {
          log('Make forward from Fillout API failed', error.message);
        }

        const formatted = formatQuestions(filloutSubmission.questions);
        const openAiOverview = await generateViaOpenAI(formatted);
        if (openAiOverview && hasRenderableOverview(openAiOverview)) {
          cacheOverview(submissionId, openAiOverview);
          return res.status(200).json(openAiOverview);
        }
      }
    }

    return res.status(202).json({
      status: 'pending',
      message:
        'Strategic overview is still processing. Ensure Fillout webhook points to /api/fillout-ingest on this site.',
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
