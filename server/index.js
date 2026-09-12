import 'dotenv/config';
import express from 'express';
import Anthropic from '@anthropic-ai/sdk';

const missing = ['ANTHROPIC_API_KEY', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'].filter(
  (k) => !process.env[k]
);
if (missing.length) {
  console.error(`Missing env vars: ${missing.join(', ')}. Copy .env.example to .env and fill it in.`);
  process.exit(1);
}

const { insertEpisodes, rateEpisode, deleteEpisode, listEpisodes, storeMode } = await import('./store.js');

// What each mood should actually surface, in the listener's own words.
const MOOD_GUIDANCE = {
  excited:
    "They have a lot of energy and are trying to figure out what to do with it. Surface high-energy, momentum-building episodes that suggest a direction or a concrete idea to act on.",
  focused:
    "They are locked in and already know what they want to work on. Surface substantive, deep-dive episodes that reward sustained attention and feed the work rather than distract from it.",
  basic:
    "They are doing a mindless task and want something fun that requires little thinking: narrative stories, interesting history, or genuinely fun conversations between people. Avoid dense, technical, or instructional episodes.",
  worried:
    "They are nervous about something and need support and encouragement. Surface warm, reassuring, steadying episodes. Avoid anything alarming, high-pressure, or doom-laden.",
  curious:
    "They are motivated and seeking something to learn. Surface episodes that explain or explore an idea and teach them something new.",
  bored: "They need a pick-me-up. Surface lively, surprising, delightful episodes that re-energize them.",
  distracted:
    "Their mind is scattered and they need something that helps them focus. Surface calm, well-paced, single-thread episodes that pull attention back together. Avoid chaotic, over-stimulating, or many-guest formats.",
};

const MODEL = 'claude-sonnet-5';
const RATINGS = ['positive', 'neutral', 'negative'];
const SEARCH_TIMEOUT_MS = 120_000;

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const app = express();
app.use(express.json());

function buildPrompt({ mood, topics, query }) {
  const topicLine = topics.length ? `Topics of interest: ${topics.join(', ')}.` : '';
  const queryLine = query ? `In their words: "${query}".` : '';
  const guidance = MOOD_GUIDANCE[mood] ?? '';
  return `Someone is feeling "${mood}" and wants a podcast episode to listen to right now. ${guidance} ${topicLine} ${queryLine}

Search the web for real, currently available podcast episodes that fit. Verify each episode actually exists and that the link points at the episode or its show page. Prefer episodes released in the last two years unless an older one is a clearly better fit. Two or three searches is plenty.

Respond with ONLY a JSON array of at most 3 objects, no prose and no markdown fences:
[{"title": "episode title", "podcast": "show name", "summary": "one or two sentences on why it fits this mood", "link": "https://..."}]

Use null for link if you cannot find a real URL. Do not invent episodes.`;
}

function extractEpisodes(message) {
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

app.get('/api/status', (_req, res) => res.json({ store: storeMode() }));

app.post('/api/recommend', async (req, res) => {
  const mood = typeof req.body?.mood === 'string' ? req.body.mood.trim() : '';
  const topics = Array.isArray(req.body?.topics)
    ? req.body.topics.filter((t) => typeof t === 'string' && t.trim()).map((t) => t.trim())
    : [];
  const query = typeof req.body?.query === 'string' ? req.body.query.trim() : '';

  if (!mood) return res.status(400).json({ error: 'Pick a mood first.' });

  try {
    // Streamed so a slow multi-search turn keeps the connection alive.
    const stream = anthropic.messages.stream(
      {
        model: MODEL,
        max_tokens: 2048,
        tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }],
        messages: [{ role: 'user', content: buildPrompt({ mood, topics, query }) }],
      },
      { timeout: SEARCH_TIMEOUT_MS }
    );
    res.on('close', () => {
      if (!res.writableEnded) stream.abort();
    });

    const episodes = extractEpisodes(await stream.finalMessage());
    if (!episodes.length) {
      return res.status(502).json({ error: 'The search came back empty. Try a different topic or query.' });
    }

    const saved = await insertEpisodes(
      episodes.map((ep) => ({
        ...ep,
        mood,
        topics: topics.length ? topics : null,
        query: query || null,
        rating: null,
      }))
    );
    res.json({ episodes: saved, store: storeMode() });
  } catch (err) {
    console.error('POST /api/recommend', err);
    const timedOut = err.name === 'APIConnectionTimeoutError' || /timeout/i.test(err.message ?? '');
    res.status(timedOut ? 504 : 500).json({
      error: timedOut ? 'The web search took too long. Try again with a narrower topic.' : err.message ?? 'Recommendation failed',
    });
  }
});

app.post('/api/rate', async (req, res) => {
  const { id, rating } = req.body ?? {};
  if (typeof id !== 'string' || !id) return res.status(400).json({ error: 'id is required' });
  if (!RATINGS.includes(rating)) {
    return res.status(400).json({ error: `rating must be one of ${RATINGS.join(', ')}` });
  }

  try {
    res.json({ episode: await rateEpisode(id, rating) });
  } catch (err) {
    console.error('POST /api/rate', err);
    res.status(500).json({ error: err.message ?? 'Rating failed' });
  }
});

app.delete('/api/episodes/:id', async (req, res) => {
  try {
    await deleteEpisode(req.params.id);
    res.status(204).end();
  } catch (err) {
    console.error('DELETE /api/episodes/:id', err);
    res.status(500).json({ error: err.message ?? 'Delete failed' });
  }
});

// rating=not.null returns only rated episodes; rating=null only unrated.
app.get('/api/episodes', async (req, res) => {
  const { rating, mood } = req.query;
  try {
    const episodes = await listEpisodes({
      rating: typeof rating === 'string' ? rating : undefined,
      mood: typeof mood === 'string' && mood && mood !== 'all' ? mood : undefined,
    });
    res.json({ episodes, store: storeMode() });
  } catch (err) {
    console.error('GET /api/episodes', err);
    res.status(500).json({ error: err.message ?? 'Fetch failed' });
  }
});

const port = Number(process.env.PORT) || 8787;
// Express fires the listen callback even when the bind fails (address() is
// null), so only claim success once the socket is really ours.
const server = app.listen(port);
server.on('listening', () => {
  const address = server.address();
  if (address) console.log(`API listening on http://localhost:${address.port} (pid ${process.pid})`);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(
      `Port ${port} is already in use — an older API process is probably still running. ` +
        `Run \`npm run stop\` (or lsof -ti tcp:${port} | xargs kill) and start again.`
    );
    process.exit(1);
  }
  throw err;
});

// A silent "listening, then gone" almost always means something signalled us
// (e.g. SIGHUP when the launching shell exits). Say so instead of vanishing.
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    console.log(`Received ${signal} — shutting down.`);
    server.close(() => process.exit(0));
  });
}

process.on('beforeExit', () => console.warn('Event loop drained; the server is no longer listening.'));
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
  process.exit(1);
});
process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err);
  process.exit(1);
});
