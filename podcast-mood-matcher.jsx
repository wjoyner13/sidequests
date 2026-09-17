import { useCallback, useEffect, useRef, useState } from 'react';
import scrubberHandle from './src/assets/scrubber-handle.svg';

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

const BOOKMARKS_KEY = 'moodflo.bookmarks';

function readBookmarks() {
  try {
    const raw = localStorage.getItem(BOOKMARKS_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeBookmarks(episodes) {
  localStorage.setItem(BOOKMARKS_KEY, JSON.stringify(episodes));
}

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
    if (res.status === 204) return null;
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      throw new Error(
        !res.ok
          ? 'The search took too long or did not complete. Try again.'
          : 'The server sent a broken response. Try again.'
      );
    }
    if (!res.ok || data?.error) {
      throw new Error(data?.error ?? `Request failed (${res.status})`);
    }
    return data;
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
  const [bookmarks, setBookmarks] = useState(readBookmarks);
  const [missModal, setMissModal] = useState(null);

  const mood = MOOD_SCALE[moodIndex];

  const loadHistory = useCallback(async () => {
    setHistoryLoading(true);
    try {
      const data = await api('/api/episodes?history=1');
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
    writeBookmarks(bookmarks);
  }, [bookmarks]);

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
    if (phase === 'idle' && !missModal) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [phase, missModal]);

  function selectTopic(next) {
    setTopic((prev) => {
      if (prev === next) {
        setTopicInput('');
        return null;
      }
      setTopicInput(next);
      return next;
    });
  }

  function onTopicInputChange(value) {
    setTopicInput(value);
    if (topic) setTopic(null);
  }

  async function findEpisodes() {
    const q = topicInput.trim();
    if (!q) return;

    const known = topic ?? (TOPICS.includes(q.toLowerCase()) || customTopics.includes(q.toLowerCase()) ? q.toLowerCase() : null);
    if (!known && !TOPICS.includes(q.toLowerCase())) {
      setCustomTopics((prev) => (prev.includes(q.toLowerCase()) ? prev : [q.toLowerCase(), ...prev]));
    }

    setLastSearch({
      mood: mood.label,
      topic: q,
      typed: !known,
    });
    setError(null);
    setPhase('searching');

    const controller = new AbortController();
    searchRef.current = controller;

    try {
      const data = await api('/api/recommend', {
        method: 'POST',
        body: JSON.stringify({
          mood: mood.key,
          topics: known ? [known] : [],
          query: q,
        }),
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

  function patchEpisode(id, patch) {
    setResults((prev) => prev.map((ep) => (ep.id === id ? { ...ep, ...patch } : ep)));
    setHistory((prev) => prev.map((ep) => (ep.id === id ? { ...ep, ...patch } : ep)));
    setBookmarks((prev) => prev.map((ep) => (ep.id === id ? { ...ep, ...patch } : ep)));
  }

  async function rate(id, rating) {
    const previousResults = results;
    const previousHistory = history;
    const ratedAt = new Date().toISOString();
    const target =
      results.find((ep) => ep.id === id) ??
      history.find((ep) => ep.id === id) ??
      bookmarks.find((ep) => ep.id === id);

    patchEpisode(id, { rating, rated_at: ratedAt });
    if (rating === 'negative') {
      // Pull the card out of its list — the miss modal takes over from here.
      // Bookmarks are left alone: a rating shouldn't silently un-bookmark something.
      setResults((prev) => prev.filter((ep) => ep.id !== id));
      setHistory((prev) => prev.filter((ep) => ep.id !== id));
      if (target) setMissModal({ ...target, rating, rated_at: ratedAt });
    }

    try {
      await api('/api/rate', { method: 'POST', body: JSON.stringify({ id, rating }) });
    } catch (e) {
      setResults(previousResults);
      setHistory(previousHistory);
      setError(e.message);
      setMissModal((m) => (m?.id === id ? null : m));
    }
  }

  function closeMissModal() {
    setMissModal(null);
  }

  async function submitMissFeedback(text) {
    if (!missModal) return;
    const { id } = missModal;
    const feedback = text.trim();
    setMissModal(null);
    if (!feedback) return;
    try {
      await api('/api/rate', { method: 'POST', body: JSON.stringify({ id, rating: 'negative', feedback }) });
    } catch (e) {
      setError(e.message);
    }
  }

  async function dismiss(id) {
    const previousResults = results;
    const previousHistory = history;
    setResults((prev) => prev.filter((ep) => ep.id !== id));
    setHistory((prev) => prev.filter((ep) => ep.id !== id));
    try {
      await api(`/api/episodes/${id}`, { method: 'DELETE' });
    } catch (e) {
      setResults(previousResults);
      setHistory(previousHistory);
      setError(e.message);
    }
  }

  async function markOpened(id) {
    const openedAt = new Date().toISOString();
    const fromResults = results.find((ep) => ep.id === id);
    setResults((prev) =>
      prev.map((ep) => (ep.id === id ? { ...ep, rated_at: ep.rated_at ?? openedAt } : ep))
    );
    setHistory((prev) => {
      if (prev.some((ep) => ep.id === id)) {
        return prev.map((ep) => (ep.id === id ? { ...ep, rated_at: ep.rated_at ?? openedAt } : ep));
      }
      if (!fromResults) return prev;
      return [{ ...fromResults, rated_at: fromResults.rated_at ?? openedAt }, ...prev];
    });
    try {
      await api('/api/open', { method: 'POST', body: JSON.stringify({ id }) });
    } catch (e) {
      setError(e.message);
    }
  }

  function toggleBookmark(episode) {
    setBookmarks((prev) => {
      if (prev.some((ep) => ep.id === episode.id)) {
        return prev.filter((ep) => ep.id !== episode.id);
      }
      return [{ ...episode, bookmarked_at: new Date().toISOString() }, ...prev];
    });
  }

  const topicOptions = Array.from(new Set([...customTopics, ...TOPICS]));

  const historyMoods = Array.from(new Set(history.map((ep) => ep.mood))).sort();
  const visibleHistory = [...(historyMood === 'all' ? history : history.filter((ep) => ep.mood === historyMood))].sort(
    (a, b) => {
      const rank = (ep) => (ep.rating == null ? -1 : RATING_ORDER[ep.rating]);
      const diff = rank(a) - rank(b);
      if (diff !== 0) return diff;
      return new Date(b.rated_at ?? b.created_at) - new Date(a.rated_at ?? a.created_at);
    }
  );
  const bookmarkedIds = new Set(bookmarks.map((ep) => ep.id));

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
        .pmm-carousel {
          position: relative;
          /* Bleed to the card edge so peeking pills can fade off the sides. */
          margin: 0 -16px;
        }
        .pmm-carousel::before,
        .pmm-carousel::after {
          content: '';
          position: absolute;
          top: 0;
          bottom: 2px;
          width: 24px;
          pointer-events: none;
          z-index: 1;
        }
        .pmm-carousel::before {
          left: 0;
          background: linear-gradient(90deg, ${colors.surface} 0%, transparent 100%);
        }
        .pmm-carousel::after {
          right: 0;
          background: linear-gradient(270deg, ${colors.surface} 0%, transparent 100%);
        }
        .pmm-carousel .pmm-scroll {
          display: flex;
          gap: 8px;
          overflow-x: auto;
          scroll-snap-type: x proximity;
          scrollbar-width: none;
          /* Left inset keeps the first pill off the card edge; no matching
             right inset, so the last in-view pill is clipped as a carousel cue. */
          padding: 0 36px 2px 28px;
        }
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
                   calc(108px + env(safe-area-inset-bottom)) max(16px, env(safe-area-inset-right));
        }
        .pmm-nav-island {
          position: fixed;
          z-index: 50;
          left: 50%;
          bottom: max(12px, env(safe-area-inset-bottom));
          transform: translateX(-50%);
          width: min(420px, calc(100% - 24px));
          display: flex;
          gap: 4px;
          padding: 6px;
          box-sizing: border-box;
          border-radius: 28px;
          background: rgba(53, 63, 58, 0.92);
          border: 1px solid ${colors.border};
          backdrop-filter: blur(16px);
          -webkit-backdrop-filter: blur(16px);
          box-shadow: 0 10px 32px rgba(0, 0, 0, 0.32);
        }
        .pmm-nav-tab {
          flex: 1;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: 4px;
          min-height: 56px;
          padding: 8px 4px 6px;
          border: none;
          border-radius: 22px;
          background: transparent;
          color: ${colors.textMuted};
          cursor: pointer;
        }
        .pmm-nav-tab[aria-current="page"] {
          background: ${colors.selectedFill};
          color: ${colors.text};
        }
        .pmm-nav-tab svg {
          display: block;
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
        .pmm-range::-moz-range-track {
          height: 2px;
          border-radius: 999px;
          background: rgba(242,240,234,0.28);
        }
        .pmm-range::-webkit-slider-thumb {
          -webkit-appearance: none;
          /* Matches the Figma asset box (79×41.5 scaled so the capsule stays ~22px on the 2px track). */
          width: 46px;
          height: 24px;
          margin-top: -11px;
          border: none;
          border-radius: 0;
          background: transparent;
        }
        .pmm-range::-moz-range-thumb {
          width: 46px;
          height: 24px;
          border: none;
          border-radius: 0;
          background: transparent;
        }
        .pmm-range:focus-visible ~ .pmm-handle-slot .pmm-handle {
          filter: drop-shadow(0 0 0 4px rgba(217,164,65,0.4));
        }

        .pmm-handle {
          position: absolute;
          top: 50%;
          width: 46px;
          height: 24px;
          transform: translate(-50%, -50%);
          pointer-events: none;
          z-index: 2;
          transition: left 160ms cubic-bezier(0.22,0.61,0.36,1);
        }
        .pmm-handle img {
          display: block;
          width: 46px;
          height: 24px;
        }

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
                   calc(108px + env(safe-area-inset-bottom)) max(16px, env(safe-area-inset-right));
          animation: pmm-rise 240ms cubic-bezier(0.22,0.61,0.36,1) both;
        }
        @media (prefers-reduced-motion: reduce) {
          .pmm-modal, .pmm-modal-inner, .pmm-mood-label { animation: none; transition: none; }
        }
      `}</style>

      <div className="pmm-page">
        <div style={{ marginBottom: '20px', textAlign: 'center' }}>
          <h1
            style={{
              fontFamily: "'Fraunces', serif",
              fontWeight: 600,
              fontSize: '26px',
              margin: 0,
              letterSpacing: '-0.01em',
            }}
          >
            MoodFlo
          </h1>
          <p style={{ color: colors.textMuted, fontSize: '14px', marginTop: '6px', lineHeight: 1.5 }}>
            Say what you're in the mood for, get real episodes, rate them so the good ones stick.
          </p>
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
                    onChange={(e) => onTopicInputChange(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        findEpisodes();
                      }
                    }}
                    aria-label="Enter a topic"
                    style={{ ...inputStyle, paddingRight: '52px' }}
                  />
                  <button
                    className="pmm-btn"
                    onClick={findEpisodes}
                    aria-label="Find podcast"
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
                      border: 'none',
                      background: topicInput.trim() ? colors.accent : colors.selectedFill,
                      color: topicInput.trim() ? colors.bg : colors.textMuted,
                      fontSize: '15px',
                      lineHeight: 1,
                      cursor: topicInput.trim() ? 'pointer' : 'default',
                    }}
                  >
                    ↑
                  </button>
                </div>
              </Field>
            </section>
          </>
        ) : view === 'bookmarks' ? (
          <section>
            <SectionHeading>Bookmarks</SectionHeading>
            {bookmarks.length === 0 ? (
              <p style={{ color: colors.textMuted, fontSize: '13px', lineHeight: 1.5 }}>
                Nothing saved yet. Bookmark a recommended episode and it&apos;ll show up here.
              </p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {bookmarks.map((ep) => (
                  <EpisodeCard
                    key={ep.id}
                    episode={ep}
                    showMood
                    bookmarked
                    onOpen={markOpened}
                    onRate={rate}
                    onBookmark={toggleBookmark}
                  />
                ))}
              </div>
            )}
          </section>
        ) : (
          <section>
            <SectionHeading>Opened and rated</SectionHeading>

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
              <p style={{ color: colors.textMuted, fontSize: '13px' }}>Loading your history…</p>
            ) : visibleHistory.length === 0 ? (
              <p style={{ color: colors.textMuted, fontSize: '13px', lineHeight: 1.5 }}>
                Nothing here yet{historyMood !== 'all' ? ` for "${historyMood}"` : ''}. Open a recommended episode
                and it&apos;ll show up so you can rate it — or dismiss it if you didn&apos;t listen.
              </p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {visibleHistory.map((ep) =>
                  ep.rating ? (
                    <RatedHistoryCard
                      key={ep.id}
                      episode={ep}
                      bookmarked={bookmarkedIds.has(ep.id)}
                      onOpen={markOpened}
                      onRate={rate}
                      onDismiss={dismiss}
                      onBookmark={toggleBookmark}
                    />
                  ) : (
                    <EpisodeCard
                      key={ep.id}
                      episode={ep}
                      showMood
                      pending
                      bookmarked={bookmarkedIds.has(ep.id)}
                      onOpen={markOpened}
                      onRate={rate}
                      onDismiss={dismiss}
                      onBookmark={toggleBookmark}
                    />
                  )
                )}
              </div>
            )}
          </section>
        )}
      </div>

      {phase !== 'searching' && !missModal && (
        <BottomNav
          view={view}
          onChange={(next) => {
            setPhase('idle');
            setView(next);
          }}
        />
      )}

      {phase === 'searching' && <SearchingModal search={lastSearch} elapsed={elapsed} onCancel={cancelSearch} />}

      {phase === 'results' && (
        <ResultsModal
          episodes={results}
          search={lastSearch}
          onClose={() => setPhase('idle')}
          onOpen={markOpened}
          onRate={rate}
          onDismiss={dismiss}
          onBookmark={toggleBookmark}
          bookmarkedIds={bookmarkedIds}
        />
      )}

      {missModal && (
        <MissFeedbackModal episode={missModal} onClose={closeMissModal} onSubmit={submitMissFeedback} />
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
        }}
      >
        {/* The mask sits inside the frame so it fades the peeking moods, not the border. */}
        <div
          style={{
            position: 'absolute',
            inset: 0,
            maskImage: 'linear-gradient(90deg, transparent, #000 14%, #000 86%, transparent)',
            WebkitMaskImage: 'linear-gradient(90deg, transparent, #000 14%, #000 86%, transparent)',
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
                // 46% of the window shows a slice of each neighbour without crowding the centre.
                transform: `translateX(${(i - index) * 46}%)`,
                transition: 'transform 260ms cubic-bezier(0.22,0.61,0.36,1), opacity 200ms ease',
                opacity: i === index ? 1 : 0.45,
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
      </div>

      <div style={{ position: 'relative', marginTop: '6px' }}>
        <div aria-hidden="true" style={{ position: 'absolute', inset: '0 23px', pointerEvents: 'none' }}>
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

        <div className="pmm-handle-slot" aria-hidden="true" style={{ position: 'absolute', inset: '0 23px', pointerEvents: 'none' }}>
          <div
            className="pmm-handle"
            style={{ left: `${(index / (MOOD_SCALE.length - 1)) * 100}%` }}
          >
            <img src={scrubberHandle} alt="" width={46} height={24} />
          </div>
        </div>
      </div>
    </div>
  );
}

function TopicCarousel({ options, selected, onSelect }) {
  return (
    <div className="pmm-carousel">
      <div className="pmm-scroll" role="radiogroup" aria-label="Topic">
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
    </div>
  );
}

function listenClause(topic, typed) {
  const t = topic.trim();
  const lower = t.toLowerCase();

  if (/^something\s+about\s+/i.test(lower)) return t;
  if (/^about\s+/i.test(lower)) return `something ${lower}`;

  // Typed how-to / questions already read as the thing to listen to.
  if (typed && /^(how|why|what|when|where|who|which|to)\b/i.test(lower)) return t;

  return `something about ${t}`;
}

function SearchRecap({ search }) {
  if (!search) return null;
  const mood = search.mood.toLowerCase();
  const topic = search.topic?.trim();
  const clause = topic ? listenClause(topic, search.typed) : null;
  const aboutPrefix = clause?.startsWith('something about ') ? 'something about ' : null;
  const highlight = aboutPrefix ? clause.slice(aboutPrefix.length) : clause;

  return (
    <p style={{ fontFamily: "'Fraunces', serif", fontWeight: 500, fontSize: '22px', lineHeight: 1.4, margin: 0 }}>
      I&apos;m feeling <span style={{ color: colors.accent }}>{mood}</span>
      {clause ? (
        <>
          {' '}
          and I want to listen to {aboutPrefix}
          <span style={{ color: colors.accent }}>{highlight}</span>
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

function ResultsModal({ episodes, search, onClose, onOpen, onRate, onDismiss, onBookmark, bookmarkedIds }) {
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
              <EpisodeCard
                key={ep.id}
                episode={ep}
                bookmarked={bookmarkedIds?.has(ep.id)}
                onOpen={onOpen}
                onRate={onRate}
                onDismiss={onDismiss}
                onBookmark={onBookmark}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function MissFeedbackModal({ episode, onClose, onSubmit }) {
  const [text, setText] = useState('');
  const textRef = useRef(null);

  useEffect(() => {
    textRef.current?.focus();
    const onKeyDown = (e) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const trimmed = text.trim();

  return (
    <div className="pmm-modal" role="dialog" aria-modal="true" aria-label="What was off?">
      <div className="pmm-modal-inner" style={{ display: 'flex', flexDirection: 'column', gap: '18px' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: '12px' }}>
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
              👎 Missed
            </div>
            <p style={{ fontFamily: "'Fraunces', serif", fontWeight: 500, fontSize: '20px', lineHeight: 1.4, margin: 0 }}>
              What was off about <span style={{ color: colors.accent }}>{episode.title}</span>?
            </p>
          </div>
          <button
            className="pmm-btn"
            onClick={onClose}
            aria-label="Close"
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

        <textarea
          ref={textRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Wrong vibe, too long, already heard it… (optional)"
          rows={4}
          style={{
            width: '100%',
            boxSizing: 'border-box',
            padding: '12px',
            borderRadius: '12px',
            border: `1px solid ${colors.border}`,
            background: colors.surface,
            color: colors.text,
            fontSize: '15px',
            fontFamily: "'IBM Plex Sans', system-ui, sans-serif",
            outline: 'none',
            resize: 'vertical',
          }}
        />

        <div style={{ display: 'flex', gap: '10px' }}>
          <button
            className="pmm-btn"
            onClick={onClose}
            style={{
              flex: 1,
              minHeight: '44px',
              borderRadius: '999px',
              border: `1px solid ${colors.border}`,
              background: 'transparent',
              color: colors.textMuted,
              fontSize: '14px',
              cursor: 'pointer',
            }}
          >
            Skip
          </button>
          <button
            className="pmm-btn"
            onClick={() => onSubmit(text)}
            disabled={!trimmed}
            style={{
              flex: 1,
              minHeight: '44px',
              borderRadius: '999px',
              border: 'none',
              background: trimmed ? colors.accent : colors.selectedFill,
              color: trimmed ? colors.bg : colors.textMuted,
              fontSize: '14px',
              fontWeight: 500,
              cursor: trimmed ? 'pointer' : 'default',
            }}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

function EpisodeCard({ episode, onOpen, onRate, onDismiss, onBookmark, showMood, pending, bookmarked }) {
  return (
    <div
      style={{
        background: colors.surfaceRaised,
        border: `1px solid ${colors.border}`,
        borderRadius: '8px',
        padding: '14px',
        position: 'relative',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '6px' }}>
        {onBookmark && (
          <button
            className="pmm-btn"
            onClick={() => onBookmark(episode)}
            aria-label={bookmarked ? 'Remove bookmark' : 'Bookmark episode'}
            aria-pressed={bookmarked}
            style={{
              background: 'none',
              border: 'none',
              color: bookmarked ? colors.accent : colors.textMuted,
              cursor: 'pointer',
              flexShrink: 0,
              width: '44px',
              height: '44px',
              margin: '-12px 0 0 -12px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <BookmarkIcon filled={bookmarked} />
          </button>
        )}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: '14px', fontWeight: 500, lineHeight: 1.4 }}>
            <EpisodeTitle episode={episode} onOpen={onOpen} />
          </div>
          <div style={{ fontSize: '12px', color: colors.textMuted, marginTop: '3px' }}>
            {episode.podcast}
            {showMood && episode.mood ? ` · ${episode.mood}` : ''}
          </div>
          {pending && (
            <p style={{ fontSize: '12px', color: colors.textMuted, margin: '8px 0 0', lineHeight: 1.5 }}>
              Rate it when you&apos;ve listened, or dismiss if you didn&apos;t.
            </p>
          )}
          {episode.summary && (
            <p style={{ fontSize: '12.5px', color: colors.textMuted, margin: '8px 0 0', lineHeight: 1.5 }}>
              {episode.summary}
            </p>
          )}
        </div>
        {onDismiss && (
        <button
          onClick={() => onDismiss(episode.id)}
          aria-label={pending ? "Didn't listen — remove from history" : 'Remove episode'}
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
        )}
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

function EpisodeTitle({ episode, onOpen }) {
  if (!episode.link) return <span className="pmm-title">{episode.title}</span>;

  function handleOpen() {
    onOpen?.(episode.id);
  }

  return (
    <a
      className="pmm-title"
      href={episode.link}
      target="_blank"
      rel="noreferrer"
      onClick={handleOpen}
      onAuxClick={(e) => {
        if (e.button === 1) handleOpen();
      }}
      style={{ color: colors.text, textDecoration: 'none', borderBottom: `1px solid ${colors.border}` }}
    >
      {episode.title}
    </a>
  );
}

function RatedHistoryCard({ episode, onOpen, onRate, onDismiss, onBookmark, bookmarked }) {
  const meta = RATING_META[episode.rating];
  return (
    <div
      style={{
        background: colors.surface,
        border: `1px solid ${colors.border}`,
        borderRadius: '14px',
        padding: '12px 14px',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: '8px' }}>
        {onBookmark && (
          <button
            className="pmm-btn"
            onClick={() => onBookmark(episode)}
            aria-label={bookmarked ? 'Remove bookmark' : 'Bookmark episode'}
            aria-pressed={bookmarked}
            style={{
              background: 'none',
              border: 'none',
              color: bookmarked ? colors.accent : colors.textMuted,
              cursor: 'pointer',
              flexShrink: 0,
              width: '44px',
              height: '44px',
              margin: '-12px 0 0 -12px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <BookmarkIcon filled={bookmarked} />
          </button>
        )}
        <span style={{ fontSize: '15px', lineHeight: 1.3, flexShrink: 0, marginTop: '2px' }}>{meta.emoji}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: '13.5px', fontWeight: 500, lineHeight: 1.4 }}>
            <EpisodeTitle episode={episode} onOpen={onOpen} />
          </div>
          <div style={{ fontSize: '12px', color: colors.textMuted, marginTop: '2px' }}>
            {episode.podcast} · {episode.mood}
          </div>
        </div>
        <span style={{ fontSize: '11px', color: meta.color, flexShrink: 0, marginTop: '3px' }}>{meta.label}</span>
        <button
          onClick={() => onDismiss(episode.id)}
          aria-label="Remove from history"
          style={{
            background: 'none',
            border: 'none',
            color: colors.textMuted,
            cursor: 'pointer',
            flexShrink: 0,
            fontSize: '15px',
            lineHeight: 1,
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
        {Object.entries(RATING_META).map(([key, m]) => {
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
                border: `1px solid ${active ? m.color : colors.border}`,
                background: active ? colors.selectedFill : 'transparent',
                color: active ? m.color : colors.text,
              }}
            >
              <span style={{ fontSize: '13px' }}>{m.emoji}</span>
              {m.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function BottomNav({ view, onChange }) {
  return (
    <nav className="pmm-nav-island" aria-label="Primary">
      {[
        ['discover', 'Discover', DiscoverIcon],
        ['history', 'History', HistoryIcon],
        ['bookmarks', 'Bookmarks', BookmarkIcon],
      ].map(([key, label, Icon]) => {
        const current = view === key;
        return (
          <button
            key={key}
            className="pmm-nav-tab"
            type="button"
            onClick={() => onChange(key)}
            aria-current={current ? 'page' : undefined}
          >
            <Icon filled={current} />
            <span style={{ fontSize: '11px', fontWeight: current ? 600 : 500, lineHeight: 1.2 }}>{label}</span>
          </button>
        );
      })}
    </nav>
  );
}

function DiscoverIcon({ filled }) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="8.25" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path
        d="M14.7 9.3 10.2 10.8 8.7 15.3 13.2 13.8 14.7 9.3Z"
        fill={filled ? 'currentColor' : 'none'}
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function HistoryIcon({ filled }) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="13" r="7.25" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path
        d="M12 9.5V13l2.4 1.6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M7.2 5.2 5 7.5M5 7.5h3.4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity={filled ? 1 : 0.85}
      />
    </svg>
  );
}

function BookmarkIcon({ filled }) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M7 4.75h10A1.25 1.25 0 0 1 18.25 6v14.1l-6.25-3.4-6.25 3.4V6A1.25 1.25 0 0 1 7 4.75Z"
        fill={filled ? 'currentColor' : 'none'}
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
    </svg>
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
