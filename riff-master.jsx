import { useCallback, useEffect, useRef, useState } from 'react';
import { isOnline, joinRoom } from './src/riffNet.js';

// Palette: DABFFF lavender, 907AD6 purple, 4F518C indigo, 2C2A4A night, 7FDEFF sky.
const colors = {
  bg: '#2C2A4A',
  surface: '#38375F',
  surfaceRaised: '#45467A',
  text: '#F4EEFF',
  textMuted: '#BDB3E0',
  accent: '#7FDEFF',
  onAccent: '#2C2A4A',
  border: 'rgba(218,191,255,0.18)',
  // The palette has no warm tone; a soft pink reads as "oops" without clashing.
  danger: '#FF9EB5',
};

// One pad per note. Notes climb a C-major arpeggio so any sequence sounds musical.
const PADS = [
  { id: 'lavender', note: 'C4', freq: 261.63, base: '#DABFFF', lit: '#F6EEFF', ink: '#2C2A4A', key: '1' },
  { id: 'purple', note: 'E4', freq: 329.63, base: '#907AD6', lit: '#C3B3FF', ink: '#2C2A4A', key: '2' },
  { id: 'indigo', note: 'G4', freq: 392.0, base: '#4F518C', lit: '#8A8DE0', ink: '#DABFFF', key: '3' },
  { id: 'sky', note: 'C5', freq: 523.25, base: '#7FDEFF', lit: '#D2F5FF', ink: '#2C2A4A', key: '4' },
];

const ROUNDS = 10; // default race length
const TEMPOS = {
  relaxed: { start: 620, min: 340 },
  normal: { start: 520, min: 260 },
  fast: { start: 420, min: 200 },
};
const COUNTDOWN_STEP_MS = 800;
const TAP_MS = 180;
// Grace window after the first finish, so a near-tie decided by network lag
// still goes to whoever was actually faster.
const RESULTS_GRACE_MS = 1200;
// No 0/O/1/I so codes survive being read aloud across a room.
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Deterministic PRNG: every phone that gets the same seed builds the same riff.
function makeSequence(seed, rounds) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return Array.from({ length: rounds }, () => Math.floor(next() * PADS.length));
}

// Playback gets brisker as the riff grows.
const noteMsForRound = (round, tempo = 'normal') => {
  const t = TEMPOS[tempo] || TEMPOS.normal;
  return Math.max(t.min, t.start - round * 26);
};

// Simulated friends for the demo race. Per-note tap speed, time to react
// after the riff ends, and chance of fumbling a round (rises with length).
const BOT_NAMES = ['Maya', 'Leo', 'Priya', 'Sam', 'Jordan'];
const SKILLS = {
  easy: { tapMs: 640, reactMs: 750, slip: 0.1, slipPerRound: 0.03 },
  normal: { tapMs: 440, reactMs: 520, slip: 0.05, slipPerRound: 0.02 },
  hard: { tapMs: 320, reactMs: 380, slip: 0.03, slipPerRound: 0.012 },
  pro: { tapMs: 240, reactMs: 280, slip: 0.01, slipPerRound: 0.006 },
};
const DEMO_DEFAULTS = { friends: 3, skill: 'normal', rounds: ROUNDS, tempo: 'normal' };

// Plans one bot's whole race up front as timed events, mirroring the real
// game's pacing: watch the riff, repeat it, maybe slip and redo the round.
function planBotRace(skill, rounds, tempo) {
  const s = SKILLS[skill] || SKILLS.normal;
  // Each friend gets their own pace so a same-skill pack doesn't finish in lockstep.
  const pace = 0.8 + Math.random() * 0.45;
  const jitter = (ms) => ms * pace * (0.75 + Math.random() * 0.5);
  const events = [];
  let t = 3 * COUNTDOWN_STEP_MS;
  for (let r = 1; r <= rounds; r++) {
    for (;;) {
      t += 500 + r * (noteMsForRound(r, tempo) + 140); // watching the riff
      if (Math.random() < s.slip + s.slipPerRound * r) {
        // Fumbles partway through, buzzes, then hears the riff again.
        t += jitter(s.reactMs) + jitter(s.tapMs) * Math.floor(Math.random() * r);
        events.push({ at: t, msg: { type: 'slip' } });
        t += 900;
        continue;
      }
      t += jitter(s.reactMs) + jitter(s.tapMs) * (r - 1);
      break;
    }
    events.push({
      at: t,
      msg: r === rounds ? { type: 'finish', ms: Math.round(t - 3 * COUNTDOWN_STEP_MS) } : { type: 'progress', cleared: r },
    });
    t += 500;
  }
  return events;
}

function loadDemoSettings() {
  try {
    return { ...DEMO_DEFAULTS, ...JSON.parse(localStorage.getItem('riff:demo') || '{}') };
  } catch {
    return DEMO_DEFAULTS;
  }
}

function saveDemoSettings(settings) {
  try {
    localStorage.setItem('riff:demo', JSON.stringify(settings));
  } catch {
    // Settings just reset next visit.
  }
}

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

function loadBest() {
  try {
    return Number(localStorage.getItem('riff:best')) || null;
  } catch {
    return null;
  }
}

function saveBest(ms) {
  try {
    localStorage.setItem('riff:best', String(ms));
  } catch {
    // Best time just won't survive a reload.
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
  const [solo, setSolo] = useState(false);
  const [demo, setDemo] = useState(null); // demo settings while racing simulated friends
  const [demoSettings, setDemoSettings] = useState(loadDemoSettings);
  const [rounds, setRounds] = useState(ROUNDS);
  const [slips, setSlips] = useState({}); // id -> timestamp of their latest wrong note
  // Solo personal best, plus whether the run that just ended beat it.
  const [best, setBest] = useState(loadBest);
  const [newBest, setNewBest] = useState(false);
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
  const game = useRef({
    seq: [],
    round: 1,
    rounds: ROUNDS,
    tempo: 'normal',
    idx: 0,
    accepting: false,
    startedAt: 0,
    token: 0,
  });
  const botTimers = useRef([]);
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
    botTimers.current.forEach(clearTimeout);
    botTimers.current = [];
  }, []);

  const playRound = useCallback(async () => {
    const g = game.current;
    const token = ++g.token;
    g.accepting = false;
    g.idx = 0;
    setRound(g.round);
    setStatus('watch');
    const noteMs = noteMsForRound(g.round, g.tempo);

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
        const raceRounds = msg.rounds || ROUNDS;
        Object.assign(g, {
          seq: makeSequence(msg.seed, raceRounds),
          rounds: raceRounds,
          tempo: msg.tempo || 'normal',
          round: 1,
          idx: 0,
        });
        setProgress({});
        setFinishes({});
        setSlips({});
        setRound(1);
        setRounds(raceRounds);
        if (demo) {
          // Bot events replay through this same handler, just like a friend's messages.
          for (const bot of players.filter((p) => p.bot)) {
            for (const { at, msg: botMsg } of planBotRace(demo.skill, raceRounds, g.tempo)) {
              botTimers.current.push(setTimeout(() => handleRef.current({ ...botMsg, id: bot.id }), at));
            }
          }
        }
        setPhase('countdown');
        (async () => {
          for (let n = 3; n > 0; n--) {
            if (token !== g.token) return;
            setCountdown(n);
            await sleep(COUNTDOWN_STEP_MS);
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
      } else if (msg.type === 'slip') {
        setSlips((s) => ({ ...s, [msg.id]: Date.now() }));
      } else if (msg.type === 'finish') {
        setProgress((p) => ({ ...p, [msg.id]: game.current.rounds }));
        setFinishes((f) => ({ ...f, [msg.id]: msg.ms }));
        if (solo) {
          const beat = best == null || msg.ms < best;
          if (beat) {
            setBest(msg.ms);
            saveBest(msg.ms);
          }
          setNewBest(beat);
        }
        if (!resultsTimer.current) {
          resultsTimer.current = setTimeout(
            () => {
              stopGame();
              setPhase('results');
            },
            // Nobody else can finish in solo, so skip the tie-break wait.
            solo ? 600 : RESULTS_GRACE_MS
          );
        }
      }
    },
    [playRound, stopGame, solo, best, demo, players]
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
        send({ type: 'slip', id: me.id });
        const token = g.token;
        setTimeout(() => token === g.token && playRound(), 900);
        return;
      }

      g.idx++;
      if (g.idx < g.round) return;

      g.accepting = false;
      if (g.round === g.rounds) {
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
    // Room games are also torn down by the join effect; solo has no effect to do it.
    stopGame();
    clearTimeout(resultsTimer.current);
    resultsTimer.current = null;
    setSolo(false);
    setDemo(null);
    setRoom(null);
    setPlayers([]);
    setPhase('lobby');
    const url = new URL(window.location.href);
    url.searchParams.delete('room');
    window.history.replaceState(null, '', url);
  };

  const startGame = (config = demo) =>
    send({
      type: 'start',
      seed: Math.floor(Math.random() * 2 ** 32),
      rounds: config?.rounds || ROUNDS,
      tempo: config?.tempo || 'normal',
    });

  // Demo race: you plus simulated friends, all local, with tunable settings.
  const startDemo = (settings) => {
    const trimmed = name.trim();
    if (trimmed) saveName(trimmed);
    saveDemoSettings(settings);
    setDemoSettings(settings);
    setError('');
    setDemo(settings);
    const bots = BOT_NAMES.slice(0, settings.friends).map((botName, i) => ({
      id: `bot-${i}`,
      name: botName,
      joinedAt: me.joinedAt + i + 1,
      bot: true,
    }));
    setPlayers([{ ...me, name: trimmed || 'You' }, ...bots]);
  };

  // Solo skips the room entirely: no network, straight into the countdown.
  const startSolo = () => {
    const trimmed = name.trim();
    if (trimmed) saveName(trimmed);
    setError('');
    setSolo(true);
    setPlayers([{ ...me, name: trimmed || 'You' }]);
    startGame();
  };

  useEffect(() => {
    if (demo && phase === 'lobby' && players.some((p) => p.bot)) startGame(demo);
    // Kick off once, right after startDemo has put the bots in the room.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [demo, players]);

  if (!room && !solo && !demo) {
    return (
      <Home
        name={name}
        setName={setName}
        codeInput={codeInput}
        setCodeInput={setCodeInput}
        error={error}
        onSolo={startSolo}
        demoSettings={demoSettings}
        onDemo={startDemo}
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
        <span style={styles.roomTag}>{solo ? 'Solo' : demo ? 'Demo race' : `Room ${room}`}</span>
      </header>

      {error && <p style={styles.error}>{error}</p>}

      {phase === 'lobby' && (
        <Lobby
          room={room}
          players={players}
          hostId={host?.id}
          meId={me.id}
          isHost={isHost}
          onStart={() => startGame()}
        />
      )}

      {phase === 'countdown' && (
        <div style={styles.center}>
          <p style={styles.subtitle}>{solo ? `Clear all ${rounds} rounds` : `First to clear round ${rounds} wins`}</p>
          <div style={styles.countdown}>{countdown}</div>
        </div>
      )}

      {phase === 'playing' && solo && best != null && (
        <p style={styles.hint}>Best: {formatMs(best)}</p>
      )}

      {phase === 'playing' && (
        <>
          <div style={styles.center}>
            <p style={styles.roundLabel}>
              Round {round} / {rounds}
            </p>
            <p style={{ ...styles.statusLine, color: status === 'wrong' ? colors.danger : colors.textMuted }}>
              {STATUS_COPY[status]}
            </p>
          </div>
          <PadGrid lit={lit} disabled={status !== 'repeat'} onPad={onPad} />
          {!solo && <Scoreboard standings={standings} meId={me.id} rounds={rounds} slips={slips} />}
        </>
      )}

      {phase === 'results' && (
        solo ? (
          <SoloResults ms={finishes[me.id]} best={best} newBest={newBest} onRematch={() => startGame()} />
        ) : (
          <Results
            standings={standings}
            meId={me.id}
            rounds={rounds}
            isHost={isHost}
            onRematch={() => startGame()}
            onSettings={demo ? leaveRoom : null}
          />
        )
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

function Home({ name, setName, codeInput, setCodeInput, error, onSolo, demoSettings, onDemo, onCreate, onJoin }) {
  const [demoOpen, setDemoOpen] = useState(false);
  const [draft, setDraft] = useState(demoSettings);

  return (
    <div style={{ ...styles.page, justifyContent: 'center' }}>
      <header style={styles.center}>
        <h1 style={styles.title}>Riff Master</h1>
        <p style={styles.subtitle}>Repeat a {ROUNDS}-note riff — solo or racing friends</p>
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

        <button type="button" style={styles.primaryButton} onClick={onSolo}>
          Play solo
        </button>

        <div style={styles.divider}>or race friends</div>

        <button type="button" style={{ ...styles.secondaryButton, width: '100%' }} onClick={onCreate}>
          Create a room
        </button>

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

      <div style={styles.card}>
        <button
          type="button"
          style={{ ...styles.linkButton, textAlign: 'left', display: 'flex', justifyContent: 'space-between' }}
          onClick={() => setDemoOpen((o) => !o)}
          aria-expanded={demoOpen}
        >
          <span>Demo race vs simulated friends</span>
          <span>{demoOpen ? '−' : '+'}</span>
        </button>
        {demoOpen && (
          <>
            <Segmented
              label="Friends"
              value={draft.friends}
              options={[1, 2, 3, 4, 5].map((n) => ({ value: n, label: String(n) }))}
              onChange={(friends) => setDraft((d) => ({ ...d, friends }))}
            />
            <Segmented
              label="Their skill"
              value={draft.skill}
              options={Object.keys(SKILLS).map((k) => ({ value: k, label: k[0].toUpperCase() + k.slice(1) }))}
              onChange={(skill) => setDraft((d) => ({ ...d, skill }))}
            />
            <Segmented
              label="Rounds to win"
              value={draft.rounds}
              options={[5, 8, 10, 12, 15].map((n) => ({ value: n, label: String(n) }))}
              onChange={(rounds) => setDraft((d) => ({ ...d, rounds }))}
            />
            <Segmented
              label="Riff speed"
              value={draft.tempo}
              options={Object.keys(TEMPOS).map((k) => ({ value: k, label: k[0].toUpperCase() + k.slice(1) }))}
              onChange={(tempo) => setDraft((d) => ({ ...d, tempo }))}
            />
            <button type="button" style={{ ...styles.primaryButton, width: '100%' }} onClick={() => onDemo(draft)}>
              Start demo race
            </button>
          </>
        )}
      </div>

      {!isOnline && (
        <p style={styles.hint}>
          Test mode: rooms only link tabs in this browser until Supabase is configured.
        </p>
      )}
    </div>
  );
}

function Segmented({ label, value, options, onChange }) {
  return (
    <div style={styles.label}>
      {label}
      <div style={styles.segmented} role="radiogroup" aria-label={label}>
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={o.value === value}
            onClick={() => onChange(o.value)}
            style={{
              ...styles.segment,
              ...(o.value === value ? styles.segmentOn : null),
            }}
          >
            {o.label}
          </button>
        ))}
      </div>
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
          <span style={{ ...styles.note, color: pad.ink }}>{pad.note}</span>
        </button>
      ))}
    </div>
  );
}

const SLIP_SHOW_MS = 1100;

function Scoreboard({ standings, meId, rounds, slips }) {
  // Re-render shortly after a slip so its "oops" tag clears on time.
  const [, tick] = useState(0);
  const latestSlip = Math.max(0, ...Object.values(slips));
  useEffect(() => {
    const wait = latestSlip + SLIP_SHOW_MS - Date.now();
    if (wait <= 0) return;
    const t = setTimeout(() => tick((n) => n + 1), wait);
    return () => clearTimeout(t);
  }, [latestSlip]);

  return (
    <ul style={{ ...styles.playerList, ...styles.card, gap: 10 }}>
      {standings.map((p) => {
        const slipped = Date.now() - (slips[p.id] || 0) < SLIP_SHOW_MS;
        return (
          <li key={p.id} style={styles.scoreRow}>
            <span style={styles.scoreName}>
              {p.name}
              {p.id === meId && <span style={styles.muted}> (you)</span>}
              {slipped && <span style={styles.slipTag}> oops!</span>}
            </span>
            <div style={styles.bar}>
              <div
                style={{
                  ...styles.barFill,
                  width: `${(p.cleared / rounds) * 100}%`,
                  background: slipped ? colors.danger : p.id === meId ? colors.accent : '#907AD6',
                }}
              />
            </div>
            <span style={styles.scoreCount}>
              {p.cleared}/{rounds}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function SoloResults({ ms, best, newBest, onRematch }) {
  return (
    <div style={styles.lobby}>
      <div style={styles.center}>
        <p style={styles.subtitle}>Riff mastered! 🎸</p>
        <h2 style={styles.winner}>{formatMs(ms)}</h2>
        <p style={{ ...styles.subtitle, color: newBest ? colors.accent : colors.textMuted }}>
          {newBest ? 'New personal best!' : `Best: ${formatMs(best)}`}
        </p>
      </div>

      <button type="button" style={styles.primaryButton} onClick={onRematch}>
        Play again
      </button>
    </div>
  );
}

function Results({ standings, meId, rounds, isHost, onRematch, onSettings }) {
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
            <span style={styles.muted}>{p.ms != null ? formatMs(p.ms) : `${p.cleared}/${rounds} rounds`}</span>
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
      {onSettings && (
        <button type="button" style={styles.linkButton} onClick={onSettings}>
          Change demo settings
        </button>
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
  primaryButton: { ...button, background: colors.accent, color: colors.onAccent, width: 'min(100%, 420px)' },
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
    // A faint rim keeps the indigo pad visible against the night background.
    border: '1px solid rgba(218,191,255,0.14)',
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
  note: { fontWeight: 700, fontSize: 18, opacity: 0.6 },
  scoreRow: { display: 'grid', gridTemplateColumns: '1fr 1.3fr auto', alignItems: 'center', gap: 10, fontSize: 14 },
  scoreName: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  bar: { height: 8, background: colors.surfaceRaised, borderRadius: 999, overflow: 'hidden' },
  barFill: { height: '100%', background: colors.accent, borderRadius: 999, transition: 'width 200ms' },
  slipTag: { color: colors.danger, fontWeight: 600 },
  segmented: { display: 'flex', gap: 6 },
  segment: {
    ...button,
    flex: 1,
    padding: '10px 4px',
    fontSize: 14,
    background: colors.surfaceRaised,
    color: colors.textMuted,
    border: `1px solid ${colors.border}`,
  },
  segmentOn: { background: colors.accent, color: colors.onAccent, border: `1px solid ${colors.accent}` },
  scoreCount: { color: colors.textMuted, fontVariantNumeric: 'tabular-nums' },
  winner: { margin: '4px 0 0', fontSize: 32 },
};
