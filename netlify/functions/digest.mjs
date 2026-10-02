import { failDigest, insertPendingDigest } from '../../lib/digestStore.js';

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

// Fast and synchronous: create the pending row and hand off to the
// background function, which has up to 15 minutes instead of the ~60s
// ceiling on a regular request. Must await the handoff fetch — any work
// still in flight when this function returns isn't guaranteed to finish.
export default async (req) => {
  let pending;
  try {
    pending = await insertPendingDigest();
  } catch (err) {
    console.error('could not create pending digest', err);
    return json({ error: err.message ?? 'Could not start the search.' }, 500);
  }

  try {
    const base = process.env.URL || new URL(req.url).origin;
    await fetch(`${base}/.netlify/functions/digest-background`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: pending.id }),
    });
  } catch (err) {
    console.error('could not start digest-background', err);
    await failDigest(pending.id, 'Could not start the search. Try again.');
    return json({ error: 'Could not start the search. Try again.' }, 500);
  }

  return json({ digest: pending });
};

export const config = {
  path: '/api/digest',
  method: 'POST',
};
