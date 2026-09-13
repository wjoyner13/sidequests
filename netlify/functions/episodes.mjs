import { deleteEpisode, listEpisodes } from '../../lib/store.js';

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

export default async (req, context) => {
  try {
    if (req.method === 'DELETE') {
      const id = context.params?.id;
      if (!id) return json({ error: 'id is required' }, 400);
      await deleteEpisode(id);
      return new Response(null, { status: 204 });
    }

    const { searchParams } = new URL(req.url);
    const mood = searchParams.get('mood');
    return json({
      episodes: await listEpisodes({
        rating: searchParams.get('rating') ?? undefined,
        mood: mood && mood !== 'all' ? mood : undefined,
      }),
    });
  } catch (err) {
    console.error('episodes failed', err);
    return json({ error: err.message ?? 'Request failed' }, 500);
  }
};

export const config = {
  path: ['/api/episodes', '/api/episodes/:id'],
  method: ['GET', 'DELETE'],
};
