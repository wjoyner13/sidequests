import { generateDigest, isTimeout } from '../../lib/digest.js';
import { insertDigest } from '../../lib/digestStore.js';

const encoder = new TextEncoder();

export default async () => {
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
        const digest = await generateDigest();
        controller.enqueue(encoder.encode(JSON.stringify({ digest: await insertDigest(digest) })));
        controller.close();
      } catch (err) {
        console.error('digest failed', err);
        try {
          controller.enqueue(
            encoder.encode(
              JSON.stringify({
                error: isTimeout(err) ? 'The web search took too long. Try pulling again.' : err.message ?? 'Digest failed',
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
  path: '/api/digest',
  method: 'POST',
};
