import { useCallback, useEffect, useRef, useState } from 'react';

const colors = {
  bg: '#2C3531',
  text: '#F2F0EA',
  textMuted: '#BCC5BF',
};

// One pad per note. Notes climb a C-major arpeggio so any sequence sounds musical.
const PADS = [
  { id: 'green', note: 'C4', freq: 261.63, base: '#2E8B57', lit: '#6FE3A0', key: '1' },
  { id: 'red', note: 'E4', freq: 329.63, base: '#B23A3A', lit: '#FF7A7A', key: '2' },
  { id: 'yellow', note: 'G4', freq: 392.0, base: '#C9A227', lit: '#FFE066', key: '3' },
  { id: 'blue', note: 'C5', freq: 523.25, base: '#2F5FA8', lit: '#74A8FF', key: '4' },
];

const NOTE_MS = 450;

// The AudioContext must be created (or resumed) inside a user gesture, or
// iOS Safari keeps it silent — so it's built lazily on the first press.
function useSynth() {
  const ctxRef = useRef(null);

  return useCallback((freq) => {
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
    osc.type = 'triangle';
    osc.frequency.value = freq;

    // Quick attack, smooth decay — avoids the click of a hard start/stop.
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.35, now + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + NOTE_MS / 1000);

    osc.connect(gain).connect(ctx.destination);
    osc.start(now);
    osc.stop(now + NOTE_MS / 1000 + 0.05);
  }, []);
}

export default function RiffMaster() {
  const play = useSynth();
  const [lit, setLit] = useState({});
  const timers = useRef({});

  const press = useCallback(
    (pad) => {
      play(pad.freq);
      clearTimeout(timers.current[pad.id]);
      setLit((prev) => ({ ...prev, [pad.id]: true }));
      timers.current[pad.id] = setTimeout(() => {
        setLit((prev) => ({ ...prev, [pad.id]: false }));
      }, 180);
    },
    [play]
  );

  useEffect(() => {
    const onKey = (e) => {
      if (e.repeat) return;
      const pad = PADS.find((p) => p.key === e.key);
      if (pad) press(pad);
    };
    window.addEventListener('keydown', onKey);
    const pending = timers.current;
    return () => {
      window.removeEventListener('keydown', onKey);
      Object.values(pending).forEach(clearTimeout);
    };
  }, [press]);

  return (
    <div style={styles.page}>
      <header style={styles.header}>
        <h1 style={styles.title}>Riff Master</h1>
        <p style={styles.subtitle}>Tap a square to play its note</p>
      </header>

      <div style={styles.grid}>
        {PADS.map((pad) => (
          <button
            key={pad.id}
            type="button"
            aria-label={`${pad.id} pad, note ${pad.note}`}
            // pointerdown fires on touch-start, so the note sounds with no lag.
            onPointerDown={(e) => {
              e.preventDefault();
              press(pad);
            }}
            // Keyboard activation (Enter/Space on a focused pad) arrives as a
            // click with detail 0; pointer clicks were already handled above.
            onClick={(e) => {
              if (e.detail === 0) press(pad);
            }}
            style={{
              ...styles.pad,
              background: lit[pad.id] ? pad.lit : pad.base,
              boxShadow: lit[pad.id] ? `0 0 36px ${pad.lit}` : 'none',
              transform: lit[pad.id] ? 'scale(0.97)' : 'scale(1)',
            }}
          >
            <span style={styles.note}>{pad.note}</span>
          </button>
        ))}
      </div>

      <p style={styles.hint}>Keys 1–4 work too</p>
    </div>
  );
}

const styles = {
  page: {
    minHeight: '100dvh',
    boxSizing: 'border-box',
    padding: 'max(24px, env(safe-area-inset-top)) 16px max(24px, env(safe-area-inset-bottom))',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 28,
    background: colors.bg,
    color: colors.text,
    fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
    userSelect: 'none',
    WebkitUserSelect: 'none',
  },
  header: { textAlign: 'center' },
  title: { margin: 0, fontSize: 32, letterSpacing: 0.5 },
  subtitle: { margin: '6px 0 0', color: colors.textMuted, fontSize: 15 },
  grid: {
    width: 'min(100%, 420px)',
    aspectRatio: '1',
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: 14,
  },
  pad: {
    border: 'none',
    borderRadius: 20,
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'flex-end',
    justifyContent: 'flex-end',
    padding: 14,
    transition: 'background 80ms, box-shadow 80ms, transform 80ms',
    // Stops long-press menus and double-tap zoom from interrupting a riff.
    touchAction: 'none',
    WebkitTouchCallout: 'none',
  },
  note: { color: 'rgba(0,0,0,0.45)', fontWeight: 700, fontSize: 18 },
  hint: { margin: 0, color: colors.textMuted, fontSize: 13 },
};
