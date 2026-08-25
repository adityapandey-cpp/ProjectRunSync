/**
 * Thin wrapper around Google's Gemini REST API (generateContent) using
 * native fetch. No SDK dependency, per spec.
 */

const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models';

class GeminiError extends Error {
  constructor(message, statusCode = 502) {
    super(message);
    this.name = 'GeminiError';
    this.statusCode = statusCode;
  }
}

/**
 * Builds a coaching-plan prompt from a user's recent run history.
 */
function buildCoachingPrompt(runs, userName) {
  const runSummary = runs.length
    ? runs
        .map((r, i) => {
          const paceMin = Math.floor(r.avgPace / 60);
          const paceSec = Math.round(r.avgPace % 60);
          return `${i + 1}. ${r.type} run — ${r.distance}km in ${Math.round(r.time / 60)} min (pace ${paceMin}:${String(paceSec).padStart(2, '0')}/km) on ${new Date(r.date).toISOString().slice(0, 10)}`;
        })
        .join('\n')
    : 'No runs logged yet.';

  return `You are an expert, encouraging running coach inside the RunSync app.
Athlete: ${userName || 'Runner'}

Recent run history (most recent first):
${runSummary}

Based on this history, generate a personalized 7-day training plan. Respond ONLY with valid JSON, no markdown fences, no preamble, matching exactly this shape:
{
  "summary": "1-2 sentence overview of the athlete's current fitness trend",
  "days": [
    { "day": "Monday", "workout": "string description", "type": "easy|long|tempo|speed|rest", "targetDistanceKm": number, "notes": "string" }
  ],
  "focusAreas": ["string", "string"]
}
The "days" array must contain exactly 7 entries, one per day of the week starting Monday.`;
}

/**
 * Calls Gemini's generateContent endpoint and returns the parsed JSON plan.
 */
async function generateCoachingPlan(runs, userName) {
  const apiKey = process.env.GEMINI_API_KEY;
  const model = process.env.GEMINI_MODEL || 'gemini-1.5-flash';

  if (!apiKey) {
    throw new GeminiError('GEMINI_API_KEY is not configured on the server.', 500);
  }

  const prompt = buildCoachingPrompt(runs, userName);
  const url = `${GEMINI_BASE_URL}/${model}:generateContent?key=${apiKey}`;

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.7,
          responseMimeType: 'application/json',
        },
      }),
    });
  } catch (err) {
    throw new GeminiError(`Failed to reach Gemini API: ${err.message}`, 502);
  }

  if (!response.ok) {
    let details = '';
    try {
      const errBody = await response.json();
      details = errBody?.error?.message || '';
    } catch (_) {
      // ignore parse failure of error body
    }
    throw new GeminiError(
      `Gemini API returned ${response.status}${details ? `: ${details}` : ''}`,
      response.status === 429 ? 429 : 502,
    );
  }

  let data;
  try {
    data = await response.json();
  } catch (err) {
    throw new GeminiError('Gemini API returned an unparseable response.', 502);
  }

  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;

  if (!text) {
    throw new GeminiError('Gemini API returned an empty response.', 502);
  }

  try {
    const cleaned = text.replace(/^```json\s*|```$/g, '').trim();
    return JSON.parse(cleaned);
  } catch (err) {
    throw new GeminiError('Failed to parse Gemini API response as JSON.', 502);
  }
}

module.exports = { generateCoachingPlan, GeminiError };
