import { useCallback, useEffect, useRef, useState } from 'react';

// Ordered low to high energy/direction: the scrubber reads left to right.
const MOOD_SCALE = [
  { key: 'unfocused', label: 'Unfocused', description: 'Mind is scattered, need help focusing' },
  { key: 'worried', label: 'Worried', description: 'Nervous about something, need encouragement' },
  { key: 'bored', label: 'Bored', description: 'Need a pick-me-up' },
  { key: 'curious', label: 'Curious', description: 'Motivated and looking to learn' },
  { key: 'focused', label: 'Focused', description: "Locked in, I know what I'm working on" },
];

const DEFAULT_MOOD_INDEX = 3;

const TOPICS = [
  'leadership',
  'mental health',
  'creativity',
  'executive presence',
  'design',
  'career',
  'health',
  'money',
  'tech',
  'storytelling',
];

const RATING_META = {
  positive: { emoji: '🎯', label: 'Nailed it', color: '#A9D19A' },
  neutral: { emoji: '😐', label: 'Decent', color: '#E0C368' },
  negative: { emoji: '👎', label: 'Missed', color: '#E39B87' },
};

const RATING_ORDER = { positive: 0, neutral: 1, negative: 2 };

const colors = {
  bg: '#2C3531',
  surface: '#353F3A',
  surfaceRaised: '#3F4A44',
  text: '#F2F0EA',
  textMuted: '#BCC5BF',
  // Reserved for the primary CTA. Selected states use the neutral fill below.
  accent: '#D9A441',
  border: 'rgba(242,240,234,0.14)',
  selectedFill: 'rgba(242,240,234,0.16)',
  selectedBorder: 'rgba(242,240,234,0.55)',
  danger: '#E39B87',
};

// Netlify kills a synchronous function at 60s, so waiting longer than that
// only leaves the user staring at a spinner.
const SEARCH_TIMEOUT_MS = 70_000;

async function api(path, options = {}) {
  const { timeoutMs = 20_000, signal, ...init } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const relay = () => controller.abort();
  signal?.addEventListener('abort', relay);

  try {
    const res = await fetch(path, {
      headers: init.body ? { 'Content-Type': 'application/json' } : undefined,
      signal: controller.signal,
      ...init,
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error ?? `Request failed (${res.status})`);
    }
    return res.status === 204 ? null : res.json();
  } catch (e) {
    if (e.name === 'AbortError') {
      if (signal?.aborted) throw Object.assign(new Error('Search cancelled'), { cancelled: true });
      throw new Error(`Gave up after ${Math.round(timeoutMs / 1000)}s. The server may still be searching — try again.`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', relay);
  }
}

export default function PodcastMoodMatcher() {
  const [view, setView] = useState('discover');

  const [moodIndex, setMoodIndex] = useState(DEFAULT_MOOD_INDEX);
  const [topic, setTopic] = useState(null);
  const [customTopics, setCustomTopics] = useState([]);
  const [topicInput, setTopicInput] = useState('');

  // 'idle' shows the page; 'searching' and 'results' each take over the screen.
  const [phase, setPhase] = useState('idle');
  const [results, setResults] = useState([]);
  const [lastSearch, setLastSearch] = useState(null);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState(null);
  const searchRef = useRef(null);

  const [history, setHistory] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyMood, setHistoryMood] = useState('all');

  const mood = MOOD_SCALE[moodIndex];

  const loadHistory = useCallback(async () => {
    setHistoryLoading(true);
    try {
      const data = await api('/api/episodes?rating=not.null');
      setHistory(data.episodes);
      setError(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  useEffect(() => {
    if (view === 'history') loadHistory();
  }, [view, loadHistory]);

  // Surfaces a misconfigured deploy (missing keys, missing table) up front
  // rather than waiting for the first search to fail.
  useEffect(() => {
    api('/api/status').catch((e) => setError(e.message));
  }, []);

  useEffect(() => {
    if (phase !== 'searching') return;
    setElapsed(0);
    const started = Date.now();
    const timer = setInterval(() => setElapsed(Math.round((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [phase]);

  // The page behind a full-screen modal must not scroll under it.
  useEffect(() => {
    if (phase === 'idle') return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [phase]);

  function selectTopic(next) {
    setTopic((prev) => (prev === next ? null : next));
  }

  // A typed topic joins the carousel so it can be reselected later.
  function commitTypedTopic() {
    const typed = topicInput.trim().toLowerCase();
    if (!typed) return null;
    setCustomTopics((prev) => (TOPICS.includes(typed) || prev.includes(typed) ? prev : [typed, ...prev]));
    setTopic(typed);
    setTopicInput('');
    return typed;
  }

  async function findEpisodes() {
    const searchTopic = commitTypedTopic() ?? topic;

    setLastSearch({ mood: mood.label, topic: searchTopic });
    setError(null);
    setPhase('searching');

    const controller = new AbortController();
    searchRef.current = controller;

    try {
      const data = await api('/api/recommend', {
        method: 'POST',
        body: JSON.stringify({ mood: mood.key, topics: searchTopic ? [searchTopic] : [], query: '' }),
        timeoutMs: SEARCH_TIMEOUT_MS,
        signal: controller.signal,
      });
      setResults((prev) => [...data.episodes, ...prev]);
      setPhase('results');
    } catch (e) {
      if (!e.cancelled) setError(e.message);
      setPhase('idle');
    } finally {
      searchRef.current = null;
    }
  }

  function cancelSearch() {
    searchRef.current?.abort();
  }

  async function rate(id, rating) {
    const previous = results;
    setResults((prev) => prev.map((ep) => (ep.id === id ? { ...ep, rating } : ep)));
    try {
      await api('/api/rate', { method: 'POST', body: JSON.stringify({ id, rating }) });
    } catch (e) {
      setResults(previous);
      setError(e.message);
    }
  }

  async function dismiss(id) {
    const previous = results;
    setResults((prev) => prev.filter((ep) => ep.id !== id));
    try {
      await api(`/api/episodes/${id}`, { method: 'DELETE' });
    } catch (e) {
      setResults(previous);
      setError(e.message);
    }
  }

  const topicOptions = Array.from(new Set([...customTopics, ...TOPICS]));

  const historyMoods = Array.from(new Set(history.map((ep) => ep.mood))).sort();
  const visibleHistory = [...(historyMood === 'all' ? history : history.filter((ep) => ep.mood === historyMood))].sort(
    (a, b) => {
      const diff = RATING_ORDER[a.rating] - RATING_ORDER[b.rating];
      if (diff !== 0) return diff;
      return new Date(b.rated_at) - new Date(a.rated_at);
    }
  );

  return (
    <div
      style={{
        background: colors.bg,
        color: colors.text,
        minHeight: '100%',
        fontFamily: "'IBM Plex Sans', system-ui, sans-serif",
      }}
    >
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,600&family=IBM+Plex+Sans:wght@400;500;600&display=swap');
        .pmm-pill { transition: background-color 120ms ease, color 120ms ease, border-color 120ms ease; }
        .pmm-scroll::-webkit-scrollbar { height: 0; }
        .pmm-btn:active { transform: translateY(1px); }
        @keyframes pmm-pulse { 0%, 100% { opacity: 0.35; } 50% { opacity: 1; } }
        @keyframes pmm-spin { to { transform: rotate(360deg); } }
        @keyframes pmm-sweep { 0% { transform: translateX(-60%); } 100% { transform: translateX(260%); } }
        @keyframes pmm-fade-in { from { opacity: 0; } to { opacity: 1; } }
        @keyframes pmm-rise { from { opacity: 0; transform: translateY(14px); } to { opacity: 1; transform: none; } }

        .pmm-page {
          max-width: 480px;
          margin: 0 auto;
          padding: max(24px, env(safe-area-inset-top)) max(16px, env(safe-area-inset-left))
                   calc(48px + env(safe-area-inset-bottom)) max(16px, env(safe-area-inset-right));
        }
        /* Episode titles are long; never let one push the card sideways. */
        .pmm-title { overflow-wrap: anywhere; }
        .pmm-rate { display: flex; gap: 8px; margin-top: 12px; }
        @media (max-width: 359px) {
          /* Three rating buttons stop fitting side by side on the smallest phones. */
          .pmm-rate { flex-direction: column; }
        }

        /* Mood scrubber: one native range input, restyled so the thumb lands on a notch. */
        .pmm-range {
          -webkit-appearance: none;
          appearance: none;
          position: relative;
          display: block;
          width: 100%;
          height: 44px;
          margin: 0;
          background: transparent;
          cursor: pointer;
        }
        .pmm-range:focus { outline: none; }
        .pmm-range::-webkit-slider-runnable-track {
          height: 2px;
          border-radius: 999px;
          background: rgba(242,240,234,0.28);
        }
        .pmm-range::-webkit-slider-thumb {
          -webkit-appearance: none;
          width: 30px;
          height: 22px;
          margin-top: -10px;
          border-radius: 999px;
          border: 1px solid ${colors.selectedBorder};
          background: ${colors.text};
          box-shadow: 0 2px 6px rgba(0,0,0,0.35);
        }
        .pmm-range::-moz-range-track {
          height: 2px;
          border-radius: 999px;
          background: rgba(242,240,234,0.28);
        }
        .pmm-range::-moz-range-thumb {
          width: 28px;
          height: 20px;
          border-radius: 999px;
          border: 1px solid ${colors.selectedBorder};
          background: ${colors.text};
        }
        .pmm-range:focus-visible::-webkit-slider-thumb { box-shadow: 0 0 0 4px rgba(217,164,65,0.4); }
        .pmm-range:focus-visible::-moz-range-thumb { box-shadow: 0 0 0 4px rgba(217,164,65,0.4); }

        .pmm-modal {
          position: fixed;
          inset: 0;
          z-index: 40;
          background: ${colors.bg};
          overflow-y: auto;
          -webkit-overflow-scrolling: touch;
          animation: pmm-fade-in 180ms ease both;
        }
        .pmm-modal-inner {
          max-width: 480px;
          margin: 0 auto;
          min-height: 100%;
          box-sizing: border-box;
          padding: calc(20px + env(safe-area-inset-top)) max(16px, env(safe-area-inset-left))
                   calc(40px + env(safe-area-inset-bottom)) max(16px, env(safe-area-inset-right));
          animation: pmm-rise 240ms cubic-bezier(0.22,0.61,0.36,1) both;
        }
        @media (prefers-reduced-motion: reduce) {
          .pmm-modal, .pmm-modal-inner, .pmm-mood-label { animation: none; transition: none; }
        }
      `}</style>

      <div className="pmm-page">
        <div style={{ marginBottom: '20px' }}>
          <h1
            style={{
              fontFamily: "'Fraunces', serif",
              fontWeight: 600,
              fontSize: '26px',
              margin: 0,
              letterSpacing: '-0.01em',
            }}
          >
            Mood Matches
          </h1>
          <p style={{ color: colors.textMuted, fontSize: '14px', marginTop: '6px', lineHeight: 1.5 }}>
            Say what you're in the mood for, get real episodes, rate them so the good ones stick.
          </p>
        </div>

        <div style={{ display: 'flex', gap: '8px', marginBottom: '24px' }}>
          {[
            ['discover', 'Discover'],
            ['history', 'History'],
          ].map(([key, label]) => (
            <button
              key={key}
              className="pmm-pill"
              onClick={() => setView(key)}
              style={{
                flex: 1,
                minHeight: '44px',
                padding: '7px 16px',
                borderRadius: '999px',
                fontSize: '14px',
                cursor: 'pointer',
                fontWeight: 500,
                border: `1px solid ${view === key ? colors.selectedBorder : colors.border}`,
                background: view === key ? colors.selectedFill : 'transparent',
                color: colors.text,
              }}
            >
              {label}
            </button>
          ))}
        </div>

        {error && (
          <div
            style={{
              fontSize: '12px',
              color: colors.danger,
              background: 'rgba(227,155,135,0.12)',
              border: '1px solid rgba(227,155,135,0.35)',
              borderRadius: '8px',
              padding: '8px 12px',
              marginBottom: '18px',
              lineHeight: 1.5,
            }}
          >
            {error}
          </div>
        )}

        {view === 'discover' ? (
          <>
            <section
              style={{
                background: colors.surface,
                border: `1px solid ${colors.border}`,
                borderRadius: '14px',
                padding: '16px',
                marginBottom: '20px',
              }}
            >
              <Field label="Mood">
                <MoodScrubber index={moodIndex} onChange={setMoodIndex} />
                <p
                  style={{
                    fontSize: '12px',
                    color: colors.textMuted,
                    margin: '4px 0 0',
                    lineHeight: 1.5,
                    textAlign: 'center',
                  }}
                >
                  {mood.description}
                </p>
              </Field>

              <Field label="Topic">
                <TopicCarousel options={topicOptions} selected={topic} onSelect={selectTopic} />

                <div style={{ position: 'relative', marginTop: '10px' }}>
                  <input
                    placeholder="Enter a topic…"
                    value={topicInput}
                    onChange={(e) => setTopicInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        commitTypedTopic();
                      }
                    }}
                    aria-label="Enter a topic"
                    style={{ ...inputStyle, paddingRight: '52px' }}
                  />
                  <button
                    className="pmm-btn"
                    onClick={commitTypedTopic}
                    aria-label="Add this topic"
                    disabled={!topicInput.trim()}
                    style={{
                      position: 'absolute',
                      top: '50%',
                      right: '6px',
                      transform: 'translateY(-50%)',
                      width: '34px',
                      height: '34px',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      borderRadius: '999px',
                      border: `1px solid ${colors.selectedBorder}`,
                      background: colors.selectedFill,
                      color: colors.text,
                      fontSize: '15px',
                      lineHeight: 1,
                      cursor: topicInput.trim() ? 'pointer' : 'default',
                      opacity: topicInput.trim() ? 1 : 0.4,
                    }}
                  >
                    ↑
                  </button>
                </div>
              </Field>

              <button
                className="pmm-btn"
                onClick={findEpisodes}
                style={{
                  width: '100%',
                  minHeight: '48px',
                  padding: '13px',
                  borderRadius: '999px',
                  border: 'none',
                  background: colors.accent,
                  color: colors.bg,
                  fontWeight: 600,
                  fontSize: '15px',
                  cursor: 'pointer',
                }}
              >
                Find podcast
              </button>
            </section>

            {results.length > 0 && (
              <button
                className="pmm-btn"
                onClick={() => setPhase('results')}
                style={{
                  width: '100%',
                  minHeight: '44px',
                  padding: '11px',
                  borderRadius: '999px',
                  border: `1px solid ${colors.border}`,
                  background: 'transparent',
                  color: colors.text,
                  fontSize: '14px',
                  cursor: 'pointer',
                }}
              >
                This session's matches ({results.length})
              </button>
            )}
          </>
        ) : (
          <section>
            <SectionHeading>What's worked before</SectionHeading>

            {historyMoods.length > 1 && (
              <div
                className="pmm-scroll"
                style={{ display: 'flex', gap: '8px', overflowX: 'auto', margin: '0 0 16px', paddingBottom: '2px' }}
              >
                <PillRow
                  options={['all', ...historyMoods]}
                  isActive={(m) => m === historyMood}
                  onSelect={setHistoryMood}
                />
              </div>
            )}

            {historyLoading ? (
              <p style={{ color: colors.textMuted, fontSize: '13px' }}>Loading your ratings…</p>
            ) : visibleHistory.length === 0 ? (
              <p style={{ color: colors.textMuted, fontSize: '13px', lineHeight: 1.5 }}>
                No ratings yet{historyMood !== 'all' ? ` for "${historyMood}"` : ''}. Rate something in Discover and
                it'll show up here.
              </p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {visibleHistory.map((ep) => {
                  const meta = RATING_META[ep.rating];
                  return (
                    <div
                      key={ep.id}
                      style={{
                        background: colors.surface,
                        border: `1px solid ${colors.border}`,
                        borderRadius: '14px',
                        padding: '12px 14px',
                        display: 'flex',
                        alignItems: 'flex-start',
                        gap: '10px',
                      }}
                    >
                      <span style={{ fontSize: '15px', lineHeight: 1.3, flexShrink: 0 }}>{meta.emoji}</span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: '13.5px', fontWeight: 500, lineHeight: 1.4 }}>
                          <EpisodeTitle episode={ep} />
                        </div>
                        <div style={{ fontSize: '12px', color: colors.textMuted, marginTop: '2px' }}>
                          {ep.podcast} · {ep.mood}
                        </div>
                      </div>
                      <span style={{ fontSize: '11px', color: meta.color, flexShrink: 0, marginTop: '3px' }}>
                        {meta.label}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        )}
      </div>

      {phase === 'searching' && <SearchingModal search={lastSearch} elapsed={elapsed} onCancel={cancelSearch} />}

      {phase === 'results' && (
        <ResultsModal
          episodes={results}
          search={lastSearch}
          onClose={() => setPhase('idle')}
          onRate={rate}
          onDismiss={dismiss}
        />
      )}
    </div>
  );
}

function MoodScrubber({ index, onChange }) {
  return (
    <div>
      <div
        aria-hidden="true"
        style={{
          position: 'relative',
          height: '54px',
          borderRadius: '999px',
          border: `1px solid ${colors.border}`,
          background: colors.bg,
          overflow: 'hidden',
          // Neighbouring moods peek in from the edges and fade out.
          maskImage: 'linear-gradient(90deg, transparent, #000 20%, #000 80%, transparent)',
          WebkitMaskImage: 'linear-gradient(90deg, transparent, #000 20%, #000 80%, transparent)',
        }}
      >
        {MOOD_SCALE.map((m, i) => (
          <div
            key={m.key}
            className="pmm-mood-label"
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              // 58% of the window keeps the neighbours clear of the centred label.
              transform: `translateX(${(i - index) * 58}%)`,
              transition: 'transform 260ms cubic-bezier(0.22,0.61,0.36,1), opacity 200ms ease',
              opacity: i === index ? 1 : 0.3,
              fontFamily: "'Fraunces', serif",
              fontWeight: 600,
              fontSize: '21px',
              whiteSpace: 'nowrap',
            }}
          >
            {m.label}
          </div>
        ))}
      </div>

      <div style={{ position: 'relative', marginTop: '6px' }}>
        <div aria-hidden="true" style={{ position: 'absolute', inset: '0 15px', pointerEvents: 'none' }}>
          {MOOD_SCALE.map((m, i) => (
            <span
              key={m.key}
              style={{
                position: 'absolute',
                top: '50%',
                left: `${(i / (MOOD_SCALE.length - 1)) * 100}%`,
                width: '2px',
                height: i === index ? '14px' : '10px',
                marginLeft: '-1px',
                marginTop: i === index ? '-7px' : '-5px',
                borderRadius: '999px',
                background: i === index ? colors.text : 'rgba(242,240,234,0.4)',
              }}
            />
          ))}
        </div>

        <input
          className="pmm-range"
          type="range"
          min={0}
          max={MOOD_SCALE.length - 1}
          step={1}
          value={index}
          onChange={(e) => onChange(Number(e.target.value))}
          aria-label="Mood"
          aria-valuetext={MOOD_SCALE[index].label}
        />
      </div>
    </div>
  );
}

function TopicCarousel({ options, selected, onSelect }) {
  return (
    <div
      className="pmm-scroll"
      role="radiogroup"
      aria-label="Topic"
      style={{
        display: 'flex',
        gap: '8px',
        overflowX: 'auto',
        scrollSnapType: 'x proximity',
        paddingBottom: '2px',
        // Bleed to the card edge so pills scroll out of view instead of stopping short.
        margin: '0 -16px',
        padding: '0 16px 2px',
        scrollbarWidth: 'none',
      }}
    >
      {options.map((option) => {
        const active = option === selected;
        return (
          <button
            key={option}
            className="pmm-pill"
            role="radio"
            aria-checked={active}
            onClick={() => onSelect(option)}
            style={{
              flexShrink: 0,
              scrollSnapAlign: 'start',
              minHeight: '40px',
              padding: '8px 16px',
              borderRadius: '999px',
              fontSize: '13.5px',
              cursor: 'pointer',
              border: `1px solid ${active ? colors.selectedBorder : colors.border}`,
              background: active ? colors.selectedFill : 'transparent',
              color: colors.text,
              fontWeight: active ? 500 : 400,
              whiteSpace: 'nowrap',
            }}
          >
            {option}
          </button>
        );
      })}
    </div>
  );
}

function SearchRecap({ search }) {
  if (!search) return null;
  return (
    <p style={{ fontFamily: "'Fraunces', serif", fontWeight: 500, fontSize: '22px', lineHeight: 1.4, margin: 0 }}>
      Something for feeling <span style={{ color: colors.accent }}>{search.mood.toLowerCase()}</span>
      {search.topic ? (
        <>
          {' '}
          about <span style={{ color: colors.accent }}>{search.topic}</span>
        </>
      ) : null}
      .
    </p>
  );
}

function SearchingModal({ search, elapsed, onCancel }) {
  return (
    <div className="pmm-modal" role="dialog" aria-modal="true" aria-label="Searching for episodes">
      <div
        className="pmm-modal-inner"
        style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: '28px' }}
      >
        <div style={{ textAlign: 'center' }}>
          <div
            style={{
              fontSize: '12px',
              letterSpacing: '0.14em',
              textTransform: 'uppercase',
              color: colors.textMuted,
              marginBottom: '14px',
            }}
          >
            Searching the web
          </div>
          <SearchRecap search={search} />
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '18px' }}>
          <div
            aria-hidden="true"
            style={{
              width: '54px',
              height: '54px',
              borderRadius: '50%',
              border: `2px solid ${colors.border}`,
              borderTopColor: colors.accent,
              animation: 'pmm-spin 900ms linear infinite',
            }}
          />
          <div
            aria-hidden="true"
            style={{
              width: '100%',
              maxWidth: '220px',
              height: '2px',
              borderRadius: '999px',
              background: colors.border,
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                width: '40%',
                height: '100%',
                borderRadius: '999px',
                background: colors.accent,
                animation: 'pmm-sweep 1.6s ease-in-out infinite',
              }}
            />
          </div>
          <div role="status" style={{ fontSize: '13px', color: colors.textMuted }}>
            Checking real episodes… {elapsed}s
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              aria-hidden="true"
              style={{
                background: colors.surfaceRaised,
                border: `1px solid ${colors.border}`,
                borderRadius: '8px',
                height: '68px',
                animation: `pmm-pulse 1.4s ease-in-out ${i * 0.18}s infinite`,
              }}
            />
          ))}
        </div>

        <button
          className="pmm-btn"
          onClick={onCancel}
          style={{
            alignSelf: 'center',
            minHeight: '44px',
            padding: '10px 22px',
            borderRadius: '999px',
            border: `1px solid ${colors.border}`,
            background: 'transparent',
            color: colors.textMuted,
            fontSize: '14px',
            cursor: 'pointer',
          }}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function ResultsModal({ episodes, search, onClose, onRate, onDismiss }) {
  const closeRef = useRef(null);

  useEffect(() => {
    closeRef.current?.focus();
    const onKeyDown = (e) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return (
    <div className="pmm-modal" role="dialog" aria-modal="true" aria-label="Your matches">
      <div className="pmm-modal-inner">
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: '12px', marginBottom: '22px' }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              style={{
                fontSize: '12px',
                letterSpacing: '0.14em',
                textTransform: 'uppercase',
                color: colors.textMuted,
                marginBottom: '10px',
              }}
            >
              {episodes.length} {episodes.length === 1 ? 'match' : 'matches'}
            </div>
            <SearchRecap search={search} />
          </div>
          <button
            ref={closeRef}
            className="pmm-btn"
            onClick={onClose}
            aria-label="Close results"
            style={{
              flexShrink: 0,
              width: '40px',
              height: '40px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: '999px',
              border: `1px solid ${colors.border}`,
              background: colors.surface,
              color: colors.text,
              fontSize: '16px',
              lineHeight: 1,
              cursor: 'pointer',
            }}
          >
            ✕
          </button>
        </div>

        {episodes.length === 0 ? (
          <p style={{ color: colors.textMuted, fontSize: '13px', lineHeight: 1.5 }}>
            Nothing left here — close this and run another search.
          </p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            {episodes.map((ep) => (
              <EpisodeCard key={ep.id} episode={ep} onRate={onRate} onDismiss={onDismiss} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function EpisodeCard({ episode, onRate, onDismiss }) {
  return (
    <div
      style={{
        background: colors.surfaceRaised,
        border: `1px solid ${colors.border}`,
        borderRadius: '8px',
        padding: '14px',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '10px' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: '14px', fontWeight: 500, lineHeight: 1.4 }}>
            <EpisodeTitle episode={episode} />
          </div>
          <div style={{ fontSize: '12px', color: colors.textMuted, marginTop: '3px' }}>{episode.podcast}</div>
          {episode.summary && (
            <p style={{ fontSize: '12.5px', color: colors.textMuted, margin: '8px 0 0', lineHeight: 1.5 }}>
              {episode.summary}
            </p>
          )}
        </div>
        <button
          onClick={() => onDismiss(episode.id)}
          aria-label="Remove episode"
          style={{
            background: 'none',
            border: 'none',
            color: colors.textMuted,
            cursor: 'pointer',
            flexShrink: 0,
            fontSize: '15px',
            lineHeight: 1,
            // 44px touch target without pushing the card's text around.
            width: '44px',
            height: '44px',
            margin: '-12px -12px 0 0',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          ✕
        </button>
      </div>

      <div className="pmm-rate">
        {Object.entries(RATING_META).map(([key, meta]) => {
          const active = episode.rating === key;
          return (
            <button
              key={key}
              className="pmm-btn"
              onClick={() => onRate(episode.id, key)}
              style={{
                flex: 1,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '5px',
                minHeight: '44px',
                padding: '8px 6px',
                borderRadius: '6px',
                fontSize: '13px',
                cursor: 'pointer',
                border: `1px solid ${active ? meta.color : colors.border}`,
                background: active ? colors.selectedFill : 'transparent',
                color: active ? meta.color : colors.text,
              }}
            >
              <span style={{ fontSize: '13px' }}>{meta.emoji}</span>
              {meta.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function EpisodeTitle({ episode }) {
  if (!episode.link) return <span className="pmm-title">{episode.title}</span>;
  return (
    <a
      className="pmm-title"
      href={episode.link}
      target="_blank"
      rel="noreferrer"
      style={{ color: colors.text, textDecoration: 'none', borderBottom: `1px solid ${colors.border}` }}
    >
      {episode.title}
    </a>
  );
}

function SectionHeading({ children }) {
  return (
    <h2 style={{ fontFamily: "'Fraunces', serif", fontWeight: 600, fontSize: '16px', margin: '0 0 12px' }}>
      {children}
    </h2>
  );
}

function Field({ label, children }) {
  return (
    <div style={{ marginBottom: '16px' }}>
      <div style={{ fontSize: '12px', color: colors.textMuted, marginBottom: '7px' }}>{label}</div>
      {children}
    </div>
  );
}

function PillRow({ options, isActive, onSelect }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
      {options.map((option) => {
        const active = isActive(option);
        return (
          <button
            key={option}
            className="pmm-pill"
            onClick={() => onSelect(option)}
            style={{
              flexShrink: 0,
              minHeight: '40px',
              padding: '8px 14px',
              borderRadius: '999px',
              fontSize: '13.5px',
              cursor: 'pointer',
              border: `1px solid ${active ? colors.selectedBorder : colors.border}`,
              background: active ? colors.selectedFill : 'transparent',
              color: colors.text,
              fontWeight: active ? 500 : 400,
            }}
          >
            {option}
          </button>
        );
      })}
    </div>
  );
}

const inputStyle = {
  width: '100%',
  boxSizing: 'border-box',
  minHeight: '44px',
  padding: '11px 12px',
  borderRadius: '999px',
  border: `1px solid ${colors.border}`,
  background: colors.bg,
  color: colors.text,
  // 16px keeps iOS from zooming the page when the field gains focus.
  fontSize: '16px',
  fontFamily: "'IBM Plex Sans', system-ui, sans-serif",
  outline: 'none',
};
