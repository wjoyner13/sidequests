import { storeStatus } from '../../lib/store.js';

export default async () => {
  const status = await storeStatus();
  return new Response(JSON.stringify(status), {
    status: status.ok ? 200 : 500,
    headers: { 'Content-Type': 'application/json' },
  });
};

export const config = {
  path: '/api/status',
  method: 'GET',
};
