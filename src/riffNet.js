// Room transport for Riff Master. Every phone in a room shares one channel:
// presence tells us who's here, broadcast carries game messages.
//
// With VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY set, rooms run over Supabase
// Realtime so phones anywhere can play together. Without them we fall back to
// BroadcastChannel, which only links tabs in the same browser — handy for dev.

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const isOnline = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);

/**
 * Joins room `code` as `me` ({ id, name, joinedAt }).
 * Handlers: onPlayers(list), onMessage(payload), onError(message).
 * Resolves to { send(payload), leave() }. Broadcasts never echo back to the sender.
 */
export function joinRoom(code, me, handlers) {
  return isOnline ? joinSupabase(code, me, handlers) : joinLocal(code, me, handlers);
}

async function joinSupabase(code, me, { onPlayers, onMessage, onError }) {
  // Loaded on demand so the MoodFlo/digest bundles never pull in the realtime client.
  const { createClient } = await import('@supabase/supabase-js');
  const client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const channel = client.channel(`riff-${code}`, {
    config: { broadcast: { self: false }, presence: { key: me.id } },
  });

  channel
    .on('broadcast', { event: 'msg' }, ({ payload }) => onMessage(payload))
    .on('presence', { event: 'sync' }, () => {
      onPlayers(Object.values(channel.presenceState()).map((metas) => metas[0]));
    })
    .subscribe((status) => {
      if (status === 'SUBSCRIBED') channel.track(me);
      else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        onError("Couldn't reach the game server. Check your connection and try again.");
      }
    });

  return {
    send: (payload) => channel.send({ type: 'broadcast', event: 'msg', payload }),
    leave: () => client.removeChannel(channel),
  };
}

const HEARTBEAT_MS = 1000;
const PEER_TIMEOUT_MS = 3500;

async function joinLocal(code, me, { onPlayers, onMessage }) {
  const bc = new BroadcastChannel(`riff-${code}`);
  const peers = new Map(); // id -> { player, seen }

  const emitPlayers = () => onPlayers([me, ...[...peers.values()].map((p) => p.player)]);

  bc.onmessage = ({ data }) => {
    if (data.kind === 'hb') {
      const isNew = !peers.has(data.player.id);
      peers.set(data.player.id, { player: data.player, seen: Date.now() });
      if (isNew) {
        emitPlayers();
        // Answer right away so the newcomer sees us without waiting a beat.
        bc.postMessage({ kind: 'hb', player: me });
      }
    } else if (data.kind === 'bye') {
      if (peers.delete(data.id)) emitPlayers();
    } else if (data.kind === 'msg') {
      onMessage(data.payload);
    }
  };

  const beat = () => {
    bc.postMessage({ kind: 'hb', player: me });
    let changed = false;
    for (const [id, p] of peers) {
      if (Date.now() - p.seen > PEER_TIMEOUT_MS) changed = peers.delete(id);
    }
    if (changed) emitPlayers();
  };
  const timer = setInterval(beat, HEARTBEAT_MS);
  beat();
  emitPlayers();

  return {
    send: (payload) => bc.postMessage({ kind: 'msg', payload }),
    leave: () => {
      clearInterval(timer);
      bc.postMessage({ kind: 'bye', id: me.id });
      bc.close();
    },
  };
}
