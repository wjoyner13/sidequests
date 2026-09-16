import { isTimeout, normalizeRequest, searchEpisodes } from '../../lib/recommend.js';
import { episodeRows, insertEpisodes } from '../../lib/store.js';

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const encoder = new TextEncoder();

export default async (req) => {
  const { mood, topics, query } = normalizeRequest(await req.json().catch(() => ({})));
  if (!mood) return json({ error: 'Pick a mood first.' }, 400);

  // Write bytes while Anthropic searches so the CDN does not close an idle
  // connection (that used to surface as a 404/504 HTML page in the app).
  const stream = new ReadableStream({
    async start(controller) {
      const beat = () => {
        try {
          controller.enqueue(encoder.encode(' '));
        } catch {
          /* stream already closed */
        }
      };
      beat();
      const heartbeat = setInterval(beat, 4000);
      try {
        const episodes = await searchEpisodes({ mood, topics, query });
        if (!episodes.length) {
          controller.enqueue(
            encoder.encode(JSON.stringify({ error: 'The search came back empty. Try a different topic or query.' }))
          );
        } else {
          controller.enqueue(
            encoder.encode(
              JSON.stringify({ episodes: await insertEpisodes(episodeRows({ episodes, mood, topics, query })) })
            )
          );
        }
        controller.close();
      } catch (err) {
        console.error('recommend failed', err);
        try {
          controller.enqueue(
            encoder.encode(
              JSON.stringify({
                error: isTimeout(err)
                  ? 'The web search took too long. Try again with a narrower topic.'
                  : err.message ?? 'Recommendation failed',
              })
            )
          );
          controller.close();
        } catch {
          controller.error(err);
        }
      } finally {
        clearInterval(heartbeat);
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-cache',
      'X-Accel-Buffering': 'no',
    },
  });
};

export const config = {
  path: '/api/recommend',
  method: 'POST',
};
