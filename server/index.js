import 'dotenv/config';
import express from 'express';

import { isTimeout, normalizeRequest, searchEpisodes } from '../lib/recommend.js';
import {
  RATINGS,
  deleteEpisode,
  episodeRows,
  insertEpisodes,
  listEpisodes,
  openEpisode,
  rateEpisode,
  storeStatus,
} from '../lib/store.js';

const missing = ['ANTHROPIC_API_KEY', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'].filter(
  (k) => !process.env[k]
);
if (missing.length) {
  console.error(`Missing env vars: ${missing.join(', ')}. Copy .env.example to .env and fill it in.`);
  process.exit(1);
}

const app = express();
app.use(express.json());

// The route handlers below are deliberately thin: every bit of real logic lives
// in lib/ so the Netlify functions in netlify/functions/ run the same code.

app.get('/api/status', async (_req, res) => {
  const status = await storeStatus();
  res.status(status.ok ? 200 : 500).json(status);
});

app.post('/api/recommend', async (req, res) => {
  const { mood, topics, query } = normalizeRequest(req.body);
  if (!mood) return res.status(400).json({ error: 'Pick a mood first.' });

  res.status(200);
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no');
  res.write(' ');
  const heartbeat = setInterval(() => {
    try {
      if (!res.writableEnded) res.write(' ');
    } catch {
      /* client disconnected */
    }
  }, 4000);

  try {
    // Cancel the upstream search if the browser gives up first.
    const episodes = await searchEpisodes({ mood, topics, query }, (abort) => {
      res.on('close', () => {
        if (!res.writableEnded) abort();
      });
    });
    if (!episodes.length) {
      return res.end(JSON.stringify({ error: 'The search came back empty. Try a different topic or query.' }));
    }
    res.end(JSON.stringify({ episodes: await insertEpisodes(episodeRows({ episodes, mood, topics, query })) }));
  } catch (err) {
    console.error('POST /api/recommend', err);
    if (res.writableEnded) return;
    res.end(
      JSON.stringify({
        error: isTimeout(err)
          ? 'The web search took too long. Try again with a narrower topic.'
          : err.message ?? 'Recommendation failed',
      })
    );
  } finally {
    clearInterval(heartbeat);
  }
});

app.post('/api/rate', async (req, res) => {
  const { id, rating, feedback } = req.body ?? {};
  if (typeof id !== 'string' || !id) return res.status(400).json({ error: 'id is required' });
  if (!RATINGS.includes(rating)) {
    return res.status(400).json({ error: `rating must be one of ${RATINGS.join(', ')}` });
  }
  if (feedback !== undefined && typeof feedback !== 'string') {
    return res.status(400).json({ error: 'feedback must be a string' });
  }

  try {
    res.json({ episode: await rateEpisode(id, rating, feedback) });
  } catch (err) {
    console.error('POST /api/rate', err);
    res.status(500).json({ error: err.message ?? 'Rating failed' });
  }
});

app.post('/api/open', async (req, res) => {
  const { id } = req.body ?? {};
  if (typeof id !== 'string' || !id) return res.status(400).json({ error: 'id is required' });

  try {
    res.json({ episode: await openEpisode(id) });
  } catch (err) {
    console.error('POST /api/open', err);
    res.status(500).json({ error: err.message ?? 'Open failed' });
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

// history=1 returns rated episodes plus anything the listener opened.
// rating=not.null returns only rated episodes; rating=null only unrated.
app.get('/api/episodes', async (req, res) => {
  const { rating, mood, history } = req.query;
  try {
    const episodes = await listEpisodes({
      history: history === '1' || history === 'true',
      rating: typeof rating === 'string' ? rating : undefined,
      mood: typeof mood === 'string' && mood && mood !== 'all' ? mood : undefined,
    });
    res.json({ episodes });
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
