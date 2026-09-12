import { useCallback, useEffect, useState } from 'react';

const MOODS = {
  excited: 'Lots of energy, figuring out what to do with it',
  focused: "Locked in, I know what I'm working on",
  basic: 'Mindless task — something fun that needs no thinking',
  worried: 'Nervous about something, need encouragement',
  curious: 'Motivated and looking to learn',
  bored: 'Need a pick-me-up',
  distracted: 'Mind is scattered, need help focusing',
};

const MOOD_OPTIONS = Object.keys(MOODS);

const PRIMARY_TOPICS = ['leadership', 'mental health', 'creativity'];

const MORE_TOPICS = [
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

const SEARCH_TIMEOUT_MS = 150_000;

async function api(path, options = {}) {
  const { timeoutMs = 20_000, ...init } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

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
      throw new Error(`Gave up after ${Math.round(timeoutMs / 1000)}s. The server may still be searching — try again.`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

export default function PodcastMoodMatcher() {
  const [view, setView] = useState('discover');

  const [mood, setMood] = useState('curious');
  const [topics, setTopics] = useState([]);
  const [topicInput, setTopicInput] = useState('');
  const [showMoreTopics, setShowMoreTopics] = useState(false);

  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState(null);
  const [store, setStore] = useState(null);

  const [history, setHistory] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyMood, setHistoryMood] = useState('all');

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

  useEffect(() => {
    api('/api/status')
      .then((data) => setStore(data.store))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!searching) return;
    setElapsed(0);
    const started = Date.now();
    const timer = setInterval(() => setElapsed(Math.round((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [searching]);

  function toggleTopic(t) {
    setTopics((prev) => (prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t]));
  }

  async function findEpisodes() {
    // Fold anything still sitting in the input into this search.
    const typed = topicInput.trim().toLowerCase();
    const searchTopics = typed && !topics.includes(typed) ? [...topics, typed] : topics;
    setTopics(searchTopics);
    setTopicInput('');

    setSearching(true);
    setError(null);
    try {
      const data = await api('/api/recommend', {
        method: 'POST',
        body: JSON.stringify({ mood, topics: searchTopics, query: '' }),
        timeoutMs: SEARCH_TIMEOUT_MS,
      });
      setResults((prev) => [...data.episodes, ...prev]);
      if (data.store) setStore(data.store);
    } catch (e) {
      setError(e.message);
    } finally {
      setSearching(false);
    }
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

  // Anything already selected stays visible even while the extra topics are collapsed.
  const visibleTopics = Array.from(
    new Set([...PRIMARY_TOPICS, ...(showMoreTopics ? MORE_TOPICS : []), ...topics])
  );

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

        {store === 'local-file' && (
          <div
            style={{
              fontSize: '12px',
              color: colors.textMuted,
              background: 'rgba(242,240,234,0.06)',
              border: `1px solid ${colors.border}`,
              borderRadius: '8px',
              padding: '8px 12px',
              marginBottom: '18px',
              lineHeight: 1.5,
            }}
          >
            Saving locally — the Supabase <code>episodes</code> table doesn't exist yet. Run{' '}
            <code>supabase/episodes.sql</code> and restart to switch over.
          </div>
        )}

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
                marginBottom: '28px',
              }}
            >
              <Field label="Mood">
                <PillRow options={MOOD_OPTIONS} isActive={(m) => m === mood} onSelect={setMood} />
                <p style={{ fontSize: '12px', color: colors.textMuted, margin: '8px 0 0', lineHeight: 1.5 }}>
                  {MOODS[mood]}
                </p>
              </Field>

              <Field label="Topics">
                <PillRow options={visibleTopics} isActive={(t) => topics.includes(t)} onSelect={toggleTopic} />

                {!showMoreTopics && (
                  <button
                    onClick={() => setShowMoreTopics(true)}
                    style={{
                      marginTop: '8px',
                      minHeight: '32px',
                      padding: '4px 0',
                      background: 'none',
                      border: 'none',
                      color: colors.textMuted,
                      fontSize: '12.5px',
                      cursor: 'pointer',
                      textDecoration: 'underline',
                    }}
                  >
                    More topics +
                  </button>
                )}

                <div style={{ display: 'flex', gap: '6px', marginTop: '10px' }}>
                  <input
                    placeholder="Enter a topic"
                    value={topicInput}
                    onChange={(e) => setTopicInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !searching) {
                        e.preventDefault();
                        findEpisodes();
                      }
                    }}
                    style={{ ...inputStyle, flex: 1 }}
                  />
                  <button
                    className="pmm-btn"
                    onClick={findEpisodes}
                    aria-label="Find episodes"
                    disabled={searching}
                    style={{
                      width: '44px',
                      height: '44px',
                      flexShrink: 0,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      borderRadius: '999px',
                      border: `1px solid ${colors.selectedBorder}`,
                      background: colors.selectedFill,
                      color: colors.text,
                      fontSize: '17px',
                      lineHeight: 1,
                      cursor: searching ? 'default' : 'pointer',
                      opacity: searching ? 0.5 : 1,
                    }}
                  >
                    ↑
                  </button>
                </div>
              </Field>

              <button
                className="pmm-btn"
                onClick={findEpisodes}
                disabled={searching}
                style={{
                  width: '100%',
                  minHeight: '48px',
                  padding: '13px',
                  borderRadius: '8px',
                  border: 'none',
                  background: colors.accent,
                  color: colors.bg,
                  fontWeight: 600,
                  fontSize: '15px',
                  cursor: searching ? 'default' : 'pointer',
                  opacity: searching ? 0.7 : 1,
                }}
              >
                {searching ? `Searching the web… ${elapsed}s` : 'Find episodes'}
              </button>
            </section>

            {searching && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', marginBottom: '28px' }}>
                {[0, 1, 2].map((i) => (
                  <div
                    key={i}
                    style={{
                      background: colors.surfaceRaised,
                      border: `1px solid ${colors.border}`,
                      borderRadius: '8px',
                      padding: '14px',
                      height: '76px',
                      animation: `pmm-pulse 1.4s ease-in-out ${i * 0.18}s infinite`,
                    }}
                  />
                ))}
              </div>
            )}

            <section>
              <SectionHeading>This session</SectionHeading>
              {results.length === 0 && !searching ? (
                <p style={{ color: colors.textMuted, fontSize: '13px', lineHeight: 1.5 }}>
                  Nothing yet. Pick a mood and run a search.
                </p>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                  {results.map((ep) => (
                    <EpisodeCard key={ep.id} episode={ep} onRate={rate} onDismiss={dismiss} />
                  ))}
                </div>
              )}
            </section>
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
  borderRadius: '8px',
  border: `1px solid ${colors.border}`,
  background: colors.bg,
  color: colors.text,
  // 16px keeps iOS from zooming the page when the field gains focus.
  fontSize: '16px',
  fontFamily: "'IBM Plex Sans', system-ui, sans-serif",
  outline: 'none',
};
