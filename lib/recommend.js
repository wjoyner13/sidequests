import Anthropic from '@anthropic-ai/sdk';

// What each mood should actually surface, in the listener's own words.
const MOOD_GUIDANCE = {
  excited:
    'They have a lot of energy and are trying to figure out what to do with it. Surface high-energy, momentum-building episodes that suggest a direction or a concrete idea to act on.',
  focused:
    'They are locked in and already know what they want to work on. Surface substantive, deep-dive episodes that reward sustained attention and feed the work rather than distract from it.',
  basic:
    'They are doing a mindless task and want something fun that requires little thinking: narrative stories, interesting history, or genuinely fun conversations between people. Avoid dense, technical, or instructional episodes.',
  worried:
    'They are nervous about something and need support and encouragement. Surface warm, reassuring, steadying episodes. Avoid anything alarming, high-pressure, or doom-laden.',
  curious:
    'They are motivated and seeking something to learn. Surface episodes that explain or explore an idea and teach them something new.',
  bored: 'They need a pick-me-up. Surface lively, surprising, delightful episodes that re-energize them.',
  distracted:
    'Their mind is scattered and they need something that helps them focus. Surface calm, well-paced, single-thread episodes that pull attention back together. Avoid chaotic, over-stimulating, or many-guest formats.',
};

const MODEL = 'claude-sonnet-5';

// Netlify allows 60s per synchronous invocation; a search normally takes 15-25s.
export const SEARCH_TIMEOUT_MS = 50_000;

export function buildPrompt({ mood, topics, query }) {
  const topicLine = topics.length ? `Topics of interest: ${topics.join(', ')}.` : '';
  const queryLine = query ? `In their words: "${query}".` : '';
  const guidance = MOOD_GUIDANCE[mood] ?? '';
  return `Someone is feeling "${mood}" and wants a podcast episode to listen to right now. ${guidance} ${topicLine} ${queryLine}

Search the web for real, currently available podcast episodes that fit. Verify each episode actually exists and that the link points at the episode or its show page. Prefer episodes released in the last two years unless an older one is a clearly better fit. Two or three searches is plenty.

Respond with ONLY a JSON array of at most 3 objects, no prose and no markdown fences:
[{"title": "episode title", "podcast": "show name", "summary": "one or two sentences on why it fits this mood", "link": "https://..."}]

Use null for link if you cannot find a real URL. Do not invent episodes.`;
}

export function extractEpisodes(message) {
  const text = message.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n');

  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) {
    throw new Error('The model replied without a JSON array. Try the search again.');
  }

  const parsed = JSON.parse(text.slice(start, end + 1));
  if (!Array.isArray(parsed)) throw new Error('The model reply was not a JSON array.');

  return parsed
    .filter((ep) => ep && typeof ep.title === 'string' && typeof ep.podcast === 'string')
    .slice(0, 3)
    .map((ep) => ({
      title: ep.title.trim(),
      podcast: ep.podcast.trim(),
      summary: typeof ep.summary === 'string' ? ep.summary.trim() : '',
      link: typeof ep.link === 'string' && ep.link.trim().startsWith('http') ? ep.link.trim() : null,
    }));
}

export function normalizeRequest(body) {
  return {
    mood: typeof body?.mood === 'string' ? body.mood.trim() : '',
    topics: Array.isArray(body?.topics)
      ? body.topics.filter((t) => typeof t === 'string' && t.trim()).map((t) => t.trim())
      : [],
    query: typeof body?.query === 'string' ? body.query.trim() : '',
  };
}

// Runs the web search. `onAbort` receives an abort callback so callers can
// cancel the upstream request when their own client disconnects.
export async function searchEpisodes({ mood, topics, query }, onAbort) {
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const stream = anthropic.messages.stream(
    {
      model: MODEL,
      max_tokens: 2048,
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }],
      messages: [{ role: 'user', content: buildPrompt({ mood, topics, query }) }],
    },
    { timeout: SEARCH_TIMEOUT_MS }
  );

  onAbort?.(() => stream.abort());
  return extractEpisodes(await stream.finalMessage());
}

export function isTimeout(err) {
  return err?.name === 'APIConnectionTimeoutError' || /timeout/i.test(err?.message ?? '');
}
