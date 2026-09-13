import { isTimeout, normalizeRequest, searchEpisodes } from '../../lib/recommend.js';
import { episodeRows, insertEpisodes } from '../../lib/store.js';

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

export default async (req) => {
  const { mood, topics, query } = normalizeRequest(await req.json().catch(() => ({})));
  if (!mood) return json({ error: 'Pick a mood first.' }, 400);

  try {
    const episodes = await searchEpisodes({ mood, topics, query });
    if (!episodes.length) {
      return json({ error: 'The search came back empty. Try a different topic or query.' }, 502);
    }
    return json({ episodes: await insertEpisodes(episodeRows({ episodes, mood, topics, query })) });
  } catch (err) {
    console.error('recommend failed', err);
    return json(
      {
        error: isTimeout(err)
          ? 'The web search took too long. Try again with a narrower topic.'
          : err.message ?? 'Recommendation failed',
      },
      isTimeout(err) ? 504 : 500
    );
  }
};

export const config = {
  path: '/api/recommend',
  method: 'POST',
};
