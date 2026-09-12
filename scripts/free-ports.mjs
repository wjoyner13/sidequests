// Kills anything still listening on the dev ports. Orphaned API/Vite processes
// outlive their parent when a launching shell dies, and then the next `npm run
// dev` fails with EADDRINUSE.
import { execFileSync } from 'node:child_process';

for (const port of [8787, 5174]) {
  let pids = [];
  try {
    pids = execFileSync('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' })
      .split('\n')
      .filter(Boolean);
  } catch {
    continue; // lsof exits non-zero when nothing is listening
  }

  for (const pid of pids) {
    try {
      process.kill(Number(pid), 'SIGTERM');
      console.log(`Freed port ${port} (killed pid ${pid})`);
    } catch (err) {
      console.warn(`Could not kill pid ${pid} on port ${port}: ${err.message}`);
    }
  }
}
