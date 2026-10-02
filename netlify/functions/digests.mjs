import { deleteDigest, getDigest, listDigests } from '../../lib/digestStore.js';

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

export default async (req, context) => {
  try {
    const id = context.params?.id;

    if (req.method === 'DELETE') {
      if (!id) return json({ error: 'id is required' }, 400);
      await deleteDigest(id);
      return new Response(null, { status: 204 });
    }

    if (id) return json({ digest: await getDigest(id) });

    return json({ digests: await listDigests() });
  } catch (err) {
    console.error('digests failed', err);
    return json({ error: err.message ?? 'Request failed' }, 500);
  }
};

export const config = {
  path: ['/api/digests', '/api/digests/:id'],
  method: ['GET', 'DELETE'],
};
