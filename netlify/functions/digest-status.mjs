import { digestStoreStatus } from '../../lib/digestStore.js';

export default async () => {
  const status = await digestStoreStatus();
  return new Response(JSON.stringify(status), {
    status: status.ok ? 200 : 500,
    headers: { 'Content-Type': 'application/json' },
  });
};

export const config = {
  path: '/api/digest-status',
  method: 'GET',
};
