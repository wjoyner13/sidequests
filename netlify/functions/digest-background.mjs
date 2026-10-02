import { runDigestJob } from '../../lib/digest.js';

// Netlify treats any function file ending in "-background" specially: it
// responds 202 immediately and lets this run for up to 15 minutes, instead
// of the ~60s ceiling on a regular function. That's what lets a slow,
// multi-source web search survive without the client holding a connection
// open or the platform killing it mid-response.
export default async (req) => {
  const { id } = await req.json().catch(() => ({}));
  if (typeof id === 'string' && id) {
    await runDigestJob(id);
  }
};
