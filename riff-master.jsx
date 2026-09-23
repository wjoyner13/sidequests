import { useCallback, useEffect, useRef, useState } from 'react';
import { isOnline, joinRoom } from './src/riffNet.js';

const colors = {
  bg: '#2C3531',
  surface: '#353F3A',
  surfaceRaised: '#3F4A44',
  text: '#F2F0EA',
  textMuted: '#BCC5BF',
  accent: '#D9A441',
  border: 'rgba(242,240,234,0.14)',
  danger: '#E39B87',
};

// One pad per note. Notes climb a C-major arpeggio so any sequence sounds musical.
const PADS = [
  { id: 'green', note: 'C4', freq: 261.63, base: '#2E8B57', lit: '#6FE3A0', key: '1' },
  { id: 'red', note: 'E4', freq: 329.63, base: '#B23A3A', lit: '#FF7A7A', key: '2' },
  { id: 'yellow', note: 'G4', freq: 392.0, base: '#C9A227', lit: '#FFE066', key: '3' },
  { id: 'blue', note: 'C5', freq: 523.25, base: '#2F5FA8', lit: '#74A8FF', key: '4' },
];

const ROUNDS = 10;
const TAP_MS = 180;
// Grace window after the first finish, so a near-tie decided by network lag
// still goes to whoever was actually faster.
const RESULTS_GRACE_MS = 1200;
// No 0/O/1/I so codes survive being read aloud across a room.
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Deterministic PRNG: every phone that gets the same seed builds the same riff.
function makeSequence(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return Array.from({ length: ROUNDS }, () => Math.floor(next() * PADS.length));
}

// Playback gets brisker as the riff grows.
const noteMsForRound = (round) => Math.max(260, 520 - round * 26);

function randomCode() {
  return Array.from({ length: 4 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');
}

function loadName() {
  try {
    return localStorage.getItem('riff:name') || '';
  } catch {
    return '';
  }
}

function saveName(name) {
  try {
    localStorage.setItem('riff:name', name);
  } catch {
    // Private mode etc. — the name just won't be remembered.
  }
}

function formatMs(ms) {
  return `${(ms / 1000).toFixed(1)}s`;
}

// The AudioContext must be created (or resumed) inside a user gesture, or
// iOS Safari keeps it silent — so it's built lazily on the first press.
function useSynth() {
  const ctxRef = useRef(null);

  return useCallback((freq, ms = 450, type = 'triangle') => {
    if (!ctxRef.current) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      ctxRef.current = new Ctx();
    }
    const ctx = ctxRef.current;
    if (ctx.state === 'suspended') ctx.resume();

    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.value = freq;

    // Quick attack, smooth decay — avoids the click of a hard start/stop.
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(type === 'triangle' ? 0.35 : 0.12, now + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + ms / 1000);

    osc.connect(gain).connect(ctx.destination);
    osc.start(now);
    osc.stop(now + ms / 1000 + 0.05);
  }, []);
}

export default function RiffMaster() {
  const synth = useSynth();
  const [me] = useState(() => ({ id: crypto.randomUUID(), joinedAt: Date.now() }));
  const [name, setName] = useState(loadName);
  const [codeInput, setCodeInput] = useState(
    () => new URLSearchParams(window.location.search).get('room')?.toUpperCase() || ''
  );
  const [room, setRoom] = useState(null); // joined room code
  const [error, setError] = useState('');
  const [players, setPlayers] = useState([]);

  // 'lobby' | 'countdown' | 'playing' | 'results'
  const [phase, setPhase] = useState('lobby');
  const [countdown, setCountdown] = useState(3);
  // 'watch' | 'repeat' | 'wrong' | 'cleared' | 'done'
  const [status, setStatus] = useState('watch');
  const [round, setRound] = useState(1);
  const [progress, setProgress] = useState({}); // id -> rounds cleared
  const [finishes, setFinishes] = useState({}); // id -> ms
  const [lit, setLit] = useState({});

  const connRef = useRef(null);
  const game = useRef({ seq: [], round: 1, idx: 0, accepting: false, startedAt: 0, token: 0 });
  const litTimers = useRef({});
  const resultsTimer = useRef(null);

  const host = [...players].sort((a, b) => a.joinedAt - b.joinedAt || a.id.localeCompare(b.id))[0];
  const isHost = host?.id === me.id;

  const flash = useCallback(
    (index, ms = TAP_MS) => {
      const pad = PADS[index];
      synth(pad.freq, Math.max(ms, 300));
      clearTimeout(litTimers.current[pad.id]);
      setLit((prev) => ({ ...prev, [pad.id]: true }));
      litTimers.current[pad.id] = setTimeout(() => setLit((prev) => ({ ...prev, [pad.id]: false })), ms);
    },
    [synth]
  );

  // Cancels any in-flight playback or pending round transitions.
  const stopGame = useCallback(() => {
    game.current.token++;
    game.current.accepting = false;
  }, []);

  const playRound = useCallback(async () => {
    const g = game.current;
    const token = ++g.token;
    g.accepting = false;
    g.idx = 0;
    setRound(g.round);
    setStatus('watch');
    const noteMs = noteMsForRound(g.round);

    await sleep(500);
    for (let i = 0; i < g.round; i++) {
      if (token !== g.token) return;
      flash(g.seq[i], noteMs);
      await sleep(noteMs + 140);
    }
    if (token !== g.token) return;
    g.accepting = true;
    setStatus('repeat');
  }, [flash]);

  // Every game message goes through here — both ones we send and ones we receive,
  // since broadcasts don't echo back to the sender.
  const handleMessage = useCallback(
    (msg) => {
      if (msg.type === 'start') {
        stopGame();
        clearTimeout(resultsTimer.current);
        resultsTimer.current = null;
        // Mutate rather than replace: pending retries hold this object and
        // rely on its token to know they've been cancelled.
        const g = game.current;
        const token = g.token;
        Object.assign(g, { seq: makeSequence(msg.seed), round: 1, idx: 0 });
        setProgress({});
        setFinishes({});
        setRound(1);
        setPhase('countdown');
        (async () => {
          for (let n = 3; n > 0; n--) {
            if (token !== g.token) return;
            setCountdown(n);
            await sleep(800);
          }
          if (token !== g.token) return;
          // Each phone times its own run from here, so the race is judged on
          // play speed, not on whose connection delivered "start" first.
          g.startedAt = performance.now();
          setPhase('playing');
          playRound();
        })();
      } else if (msg.type === 'progress') {
        setProgress((p) => ({ ...p, [msg.id]: Math.max(p[msg.id] || 0, msg.cleared) }));
      } else if (msg.type === 'finish') {
        setProgress((p) => ({ ...p, [msg.id]: ROUNDS }));
        setFinishes((f) => ({ ...f, [msg.id]: msg.ms }));
        if (!resultsTimer.current) {
          resultsTimer.current = setTimeout(() => {
            stopGame();
            setPhase('results');
          }, RESULTS_GRACE_MS);
        }
      }
    },
    [playRound, stopGame]
  );

  const handleRef = useRef(handleMessage);
  handleRef.current = handleMessage;

  const send = useCallback((msg) => {
    handleRef.current(msg);
    connRef.current?.send(msg);
  }, []);

  // Join / leave the room channel.
  useEffect(() => {
    if (!room) return;
    let cancelled = false;
    let conn = null;
    joinRoom(room, { ...me, name: name.trim() }, {
      onPlayers: (list) => !cancelled && setPlayers(list),
      onMessage: (msg) => !cancelled && handleRef.current(msg),
      onError: (message) => !cancelled && setError(message),
    })
      .then((c) => {
        conn = c;
        if (cancelled) c.leave();
        else connRef.current = c;
      })
      .catch(() => !cancelled && setError("Couldn't join that room. Try again."));

    return () => {
      cancelled = true;
      conn?.leave();
      connRef.current = null;
      stopGame();
      clearTimeout(resultsTimer.current);
      resultsTimer.current = null;
    };
    // Name is fixed once you're in a room.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room, me, stopGame]);

  useEffect(() => {
    const timers = litTimers.current;
    return () => Object.values(timers).forEach(clearTimeout);
  }, []);

  const onPad = useCallback(
    (index) => {
      const g = game.current;
      if (phase !== 'playing' || !g.accepting) return;
      flash(index);

      if (g.seq[g.idx] !== index) {
        // Wrong note: buzz, then hear this round's riff again and retry it.
        g.accepting = false;
        synth(110, 500, 'sawtooth');
        setStatus('wrong');
        const token = g.token;
        setTimeout(() => token === g.token && playRound(), 900);
        return;
      }

      g.idx++;
      if (g.idx < g.round) return;

      g.accepting = false;
      if (g.round === ROUNDS) {
        setStatus('done');
        send({ type: 'finish', id: me.id, ms: Math.round(performance.now() - g.startedAt) });
        return;
      }
      send({ type: 'progress', id: me.id, cleared: g.round });
      setStatus('cleared');
      g.round++;
      const token = g.token;
      setTimeout(() => token === g.token && playRound(), 500);
    },
    [phase, flash, synth, playRound, send, me.id]
  );

  useEffect(() => {
    const onKey = (e) => {
      if (e.repeat || e.target.tagName === 'INPUT') return;
      const index = PADS.findIndex((p) => p.key === e.key);
      if (index >= 0) onPad(index);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onPad]);

  const enterRoom = (code) => {
    const trimmed = name.trim();
    if (!trimmed) return setError('Enter your name first.');
    saveName(trimmed);
    setError('');
    setPlayers([]);
    setPhase('lobby');
    setRoom(code);
    const url = new URL(window.location.href);
    url.searchParams.set('room', code);
    window.history.replaceState(null, '', url);
  };

  const leaveRoom = () => {
    setRoom(null);
    setPlayers([]);
    setPhase('lobby');
    const url = new URL(window.location.href);
    url.searchParams.delete('room');
    window.history.replaceState(null, '', url);
  };

  const startGame = () => send({ type: 'start', seed: Math.floor(Math.random() * 2 ** 32) });

  if (!room) {
    return (
      <Home
        name={name}
        setName={setName}
        codeInput={codeInput}
        setCodeInput={setCodeInput}
        error={error}
        onCreate={() => enterRoom(randomCode())}
        onJoin={() => {
          const code = codeInput.trim().toUpperCase();
          if (code.length !== 4) return setError('Room codes are 4 characters.');
          enterRoom(code);
        }}
      />
    );
  }

  const standings = rankPlayers(players, progress, finishes);

  return (
    <div style={styles.page}>
      <header style={styles.topBar}>
        <button type="button" style={styles.linkButton} onClick={leaveRoom}>
          ← Leave
        </button>
        <span style={styles.roomTag}>Room {room}</span>
      </header>

      {error && <p style={styles.error}>{error}</p>}

      {phase === 'lobby' && (
        <Lobby
          room={room}
          players={players}
          hostId={host?.id}
          meId={me.id}
          isHost={isHost}
          onStart={startGame}
        />
      )}

      {phase === 'countdown' && (
        <div style={styles.center}>
          <p style={styles.subtitle}>First to clear round {ROUNDS} wins</p>
          <div style={styles.countdown}>{countdown}</div>
        </div>
      )}

      {phase === 'playing' && (
        <>
          <div style={styles.center}>
            <p style={styles.roundLabel}>
              Round {round} / {ROUNDS}
            </p>
            <p style={{ ...styles.statusLine, color: status === 'wrong' ? colors.danger : colors.textMuted }}>
              {STATUS_COPY[status]}
            </p>
          </div>
          <PadGrid lit={lit} disabled={status !== 'repeat'} onPad={onPad} />
          <Scoreboard standings={standings} meId={me.id} />
        </>
      )}

      {phase === 'results' && (
        <Results standings={standings} meId={me.id} isHost={isHost} onRematch={startGame} />
      )}
    </div>
  );
}

const STATUS_COPY = {
  watch: 'Watch the riff…',
  repeat: 'Your turn — play it back',
  wrong: 'Wrong note! Try this round again',
  cleared: 'Nice!',
  done: 'Finished! Waiting for results…',
};

function rankPlayers(players, progress, finishes) {
  return players
    .map((p) => ({ ...p, cleared: progress[p.id] || 0, ms: finishes[p.id] }))
    .sort((a, b) => {
      if (a.ms != null && b.ms != null) return a.ms - b.ms;
      if (a.ms != null) return -1;
      if (b.ms != null) return 1;
      return b.cleared - a.cleared;
    });
}

function Home({ name, setName, codeInput, setCodeInput, error, onCreate, onJoin }) {
  return (
    <div style={{ ...styles.page, justifyContent: 'center' }}>
      <header style={styles.center}>
        <h1 style={styles.title}>Riff Master</h1>
        <p style={styles.subtitle}>Race your friends to repeat a {ROUNDS}-note riff</p>
      </header>

      <div style={styles.card}>
        <label style={styles.label}>
          Your name
          <input
            style={styles.input}
            value={name}
            maxLength={16}
            autoComplete="nickname"
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Jess"
          />
        </label>

        <button type="button" style={styles.primaryButton} onClick={onCreate}>
          Create a room
        </button>

        <div style={styles.divider}>or join one</div>

        <form
          style={styles.joinRow}
          onSubmit={(e) => {
            e.preventDefault();
            onJoin();
          }}
        >
          <input
            style={{ ...styles.input, ...styles.codeInput }}
            value={codeInput}
            maxLength={4}
            autoCapitalize="characters"
            autoComplete="off"
            onChange={(e) => setCodeInput(e.target.value.toUpperCase())}
            placeholder="CODE"
            aria-label="Room code"
          />
          <button type="submit" style={styles.secondaryButton}>
            Join
          </button>
        </form>

        {error && <p style={styles.error}>{error}</p>}
      </div>

      {!isOnline && (
        <p style={styles.hint}>
          Test mode: rooms only link tabs in this browser until Supabase is configured.
        </p>
      )}
    </div>
  );
}

function Lobby({ room, players, hostId, meId, isHost, onStart }) {
  const [copied, setCopied] = useState(false);

  const share = async () => {
    const url = window.location.href;
    try {
      if (navigator.share) await navigator.share({ title: 'Riff Master', text: `Join my Riff Master room: ${room}`, url });
      else {
        await navigator.clipboard.writeText(url);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }
    } catch {
      // User dismissed the share sheet.
    }
  };

  return (
    <div style={styles.lobby}>
      <div style={styles.center}>
        <p style={styles.subtitle}>Room code</p>
        <div style={styles.bigCode}>{room}</div>
        <button type="button" style={styles.linkButton} onClick={share}>
          {copied ? 'Link copied!' : 'Share invite link'}
        </button>
      </div>

      <div style={styles.card}>
        <p style={styles.label}>Players ({players.length})</p>
        <ul style={styles.playerList}>
          {players.map((p) => (
            <li key={p.id} style={styles.playerRow}>
              <span>
                {p.name}
                {p.id === meId && <span style={styles.muted}> (you)</span>}
              </span>
              {p.id === hostId && <span style={styles.badge}>Host</span>}
            </li>
          ))}
        </ul>
      </div>

      {isHost ? (
        <button type="button" style={styles.primaryButton} onClick={onStart}>
          Start race
        </button>
      ) : (
        <p style={styles.hint}>Waiting for the host to start…</p>
      )}
    </div>
  );
}

function PadGrid({ lit, disabled, onPad }) {
  return (
    <div style={styles.grid}>
      {PADS.map((pad, index) => (
        <button
          key={pad.id}
          type="button"
          aria-label={`${pad.id} pad, note ${pad.note}`}
          // pointerdown fires on touch-start, so the note sounds with no lag.
          onPointerDown={(e) => {
            e.preventDefault();
            onPad(index);
          }}
          // Keyboard activation (Enter/Space on a focused pad) arrives as a
          // click with detail 0; pointer clicks were already handled above.
          onClick={(e) => {
            if (e.detail === 0) onPad(index);
          }}
          style={{
            ...styles.pad,
            background: lit[pad.id] ? pad.lit : pad.base,
            boxShadow: lit[pad.id] ? `0 0 36px ${pad.lit}` : 'none',
            transform: lit[pad.id] ? 'scale(0.97)' : 'scale(1)',
            opacity: disabled && !lit[pad.id] ? 0.72 : 1,
          }}
        >
          <span style={styles.note}>{pad.note}</span>
        </button>
      ))}
    </div>
  );
}

function Scoreboard({ standings, meId }) {
  return (
    <ul style={{ ...styles.playerList, ...styles.card, gap: 10 }}>
      {standings.map((p) => (
        <li key={p.id} style={styles.scoreRow}>
          <span style={styles.scoreName}>
            {p.name}
            {p.id === meId && <span style={styles.muted}> (you)</span>}
          </span>
          <div style={styles.bar}>
            <div style={{ ...styles.barFill, width: `${(p.cleared / ROUNDS) * 100}%` }} />
          </div>
          <span style={styles.scoreCount}>
            {p.cleared}/{ROUNDS}
          </span>
        </li>
      ))}
    </ul>
  );
}

function Results({ standings, meId, isHost, onRematch }) {
  const winner = standings[0];
  return (
    <div style={styles.lobby}>
      <div style={styles.center}>
        <p style={styles.subtitle}>Winner</p>
        <h2 style={styles.winner}>{winner?.id === meId ? 'You win! 🎸' : `${winner?.name} wins!`}</h2>
      </div>

      <ol style={{ ...styles.playerList, ...styles.card, gap: 10 }}>
        {standings.map((p, i) => (
          <li key={p.id} style={styles.playerRow}>
            <span>
              {i + 1}. {p.name}
              {p.id === meId && <span style={styles.muted}> (you)</span>}
            </span>
            <span style={styles.muted}>{p.ms != null ? formatMs(p.ms) : `${p.cleared}/${ROUNDS} rounds`}</span>
          </li>
        ))}
      </ol>

      {isHost ? (
        <button type="button" style={styles.primaryButton} onClick={onRematch}>
          Play again
        </button>
      ) : (
        <p style={styles.hint}>Waiting for the host to start a rematch…</p>
      )}
    </div>
  );
}

const button = {
  border: 'none',
  borderRadius: 12,
  padding: '14px 18px',
  fontSize: 16,
  fontWeight: 600,
  cursor: 'pointer',
};

const styles = {
  page: {
    minHeight: '100dvh',
    boxSizing: 'border-box',
    padding: 'max(20px, env(safe-area-inset-top)) 16px max(24px, env(safe-area-inset-bottom))',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 22,
    background: colors.bg,
    color: colors.text,
    fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
  },
  topBar: {
    width: 'min(100%, 420px)',
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  roomTag: { color: colors.textMuted, fontSize: 14, letterSpacing: 1 },
  center: { textAlign: 'center' },
  title: { margin: 0, fontSize: 34, letterSpacing: 0.5 },
  subtitle: { margin: '6px 0 0', color: colors.textMuted, fontSize: 15 },
  card: {
    width: 'min(100%, 420px)',
    boxSizing: 'border-box',
    background: colors.surface,
    border: `1px solid ${colors.border}`,
    borderRadius: 16,
    padding: 18,
    display: 'flex',
    flexDirection: 'column',
    gap: 14,
  },
  label: { display: 'flex', flexDirection: 'column', gap: 8, margin: 0, fontSize: 14, color: colors.textMuted },
  input: {
    background: colors.surfaceRaised,
    border: `1px solid ${colors.border}`,
    borderRadius: 10,
    padding: '12px 14px',
    color: colors.text,
    outline: 'none',
    minWidth: 0,
  },
  codeInput: { flex: 1, letterSpacing: 6, textAlign: 'center', fontWeight: 700, textTransform: 'uppercase' },
  joinRow: { display: 'flex', gap: 10, margin: 0 },
  divider: { textAlign: 'center', color: colors.textMuted, fontSize: 13 },
  primaryButton: { ...button, background: colors.accent, color: '#2C3531', width: 'min(100%, 420px)' },
  secondaryButton: { ...button, background: colors.surfaceRaised, color: colors.text, border: `1px solid ${colors.border}` },
  linkButton: { ...button, background: 'none', color: colors.accent, padding: '6px 0', fontSize: 15 },
  error: { margin: 0, color: colors.danger, fontSize: 14, textAlign: 'center' },
  hint: { margin: 0, color: colors.textMuted, fontSize: 13, textAlign: 'center', maxWidth: 420 },
  muted: { color: colors.textMuted },
  lobby: { width: 'min(100%, 420px)', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 22 },
  bigCode: { fontSize: 56, fontWeight: 800, letterSpacing: 10, margin: '4px 0' },
  playerList: { listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 10 },
  playerRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 16 },
  badge: {
    fontSize: 12,
    fontWeight: 700,
    color: colors.accent,
    border: `1px solid ${colors.accent}`,
    borderRadius: 999,
    padding: '2px 8px',
  },
  countdown: { fontSize: 120, fontWeight: 800, color: colors.accent, lineHeight: 1.2 },
  roundLabel: { margin: 0, fontSize: 22, fontWeight: 700 },
  statusLine: { margin: '4px 0 0', fontSize: 15, minHeight: 20 },
  grid: {
    width: 'min(100%, 420px)',
    aspectRatio: '1',
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: 14,
    userSelect: 'none',
    WebkitUserSelect: 'none',
  },
  pad: {
    border: 'none',
    borderRadius: 20,
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'flex-end',
    justifyContent: 'flex-end',
    padding: 14,
    transition: 'background 80ms, box-shadow 80ms, transform 80ms, opacity 120ms',
    // Stops long-press menus and double-tap zoom from interrupting a riff.
    touchAction: 'none',
    WebkitTouchCallout: 'none',
  },
  note: { color: 'rgba(0,0,0,0.45)', fontWeight: 700, fontSize: 18 },
  scoreRow: { display: 'grid', gridTemplateColumns: '1fr 1.3fr auto', alignItems: 'center', gap: 10, fontSize: 14 },
  scoreName: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  bar: { height: 8, background: colors.surfaceRaised, borderRadius: 999, overflow: 'hidden' },
  barFill: { height: '100%', background: colors.accent, borderRadius: 999, transition: 'width 200ms' },
  scoreCount: { color: colors.textMuted, fontVariantNumeric: 'tabular-nums' },
  winner: { margin: '4px 0 0', fontSize: 32 },
};
