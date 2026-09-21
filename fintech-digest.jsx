import { useCallback, useEffect, useRef, useState } from 'react';

// Mirrors lib/digest.js SOURCES — display copy only, kept separate so this
// file never imports server-only code (Anthropic SDK, process.env) into the browser bundle.
const SOURCE_NAMES = [
  'Finextra',
  'Fintech Business Weekly',
  'Fintech Brainfood',
  'Fintech Takes',
  'Sifted',
  'Axios Pro Fintech Deals',
];

const colors = {
  bg: '#2C3531',
  surface: '#353F3A',
  surfaceRaised: '#3F4A44',
  text: '#F2F0EA',
  textMuted: '#BCC5BF',
  accent: '#D9A441',
  border: 'rgba(242,240,234,0.14)',
  selectedFill: 'rgba(242,240,234,0.16)',
  danger: '#E39B87',
};

// Give the browser more patience than the server-side cap (lib/digest.js)
// so a slow-but-legitimate multi-source search isn't killed client-side
// before the server's own timeout has a chance to respond.
const PULL_TIMEOUT_MS = 120_000;

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
        !res.ok ? 'The pull took too long or did not complete. Try again.' : 'The server sent a broken response. Try again.'
      );
    }
    if (!res.ok || data?.error) {
      throw new Error(data?.error ?? `Request failed (${res.status})`);
    }
    return data;
  } catch (e) {
    if (e.name === 'AbortError') {
      if (signal?.aborted) throw Object.assign(new Error('Pull cancelled'), { cancelled: true });
      throw new Error(`Gave up after ${Math.round(timeoutMs / 1000)}s. The server may still be searching — try again.`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', relay);
  }
}

function formatDate(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export default function FintechDigest() {
  const [history, setHistory] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(true);

  // 'idle' shows the home page; 'pulling' and 'reader' take over the screen.
  const [phase, setPhase] = useState('idle');
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState(null);
  const pullRef = useRef(null);

  const [readerDigest, setReaderDigest] = useState(null);
  const [pageIndex, setPageIndex] = useState(0);
  const touchRef = useRef(null);

  const loadHistory = useCallback(async () => {
    setHistoryLoading(true);
    try {
      const data = await api('/api/digests');
      setHistory(data.digests);
    } catch (e) {
      setError(e.message);
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  useEffect(() => {
    loadHistory();
  }, [loadHistory]);

  // Surfaces a misconfigured deploy (missing keys, missing table) up front.
  useEffect(() => {
    api('/api/digest-status').catch((e) => setError(e.message));
  }, []);

  useEffect(() => {
    if (phase !== 'pulling') return;
    setElapsed(0);
    const started = Date.now();
    const timer = setInterval(() => setElapsed(Math.round((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [phase]);

  useEffect(() => {
    if (phase === 'idle') return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [phase]);

  const latest = history[0] ?? null;
  const pages = readerDigest
    ? [{ type: 'highlight', headline: readerDigest.headline }, ...readerDigest.topics.map((t) => ({ type: 'topic', ...t }))]
    : [];

  function openReader(digest) {
    setReaderDigest(digest);
    setPageIndex(0);
    setError(null);
    setPhase('reader');
  }

  function closeReader() {
    setPhase('idle');
    setReaderDigest(null);
  }

  function goTo(index) {
    setPageIndex(Math.max(0, Math.min(pages.length - 1, index)));
  }

  useEffect(() => {
    if (phase !== 'reader') return;
    function onKeyDown(e) {
      if (e.key === 'Escape') closeReader();
      if (e.key === 'ArrowRight') goTo(pageIndex + 1);
      if (e.key === 'ArrowLeft') goTo(pageIndex - 1);
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, pageIndex, pages.length]);

  function onTouchStart(e) {
    touchRef.current = e.touches[0].clientX;
  }
  function onTouchEnd(e) {
    if (touchRef.current == null) return;
    const delta = e.changedTouches[0].clientX - touchRef.current;
    touchRef.current = null;
    if (Math.abs(delta) < 40) return;
    goTo(delta < 0 ? pageIndex + 1 : pageIndex - 1);
  }

  async function pull() {
    setError(null);
    setPhase('pulling');
    const controller = new AbortController();
    pullRef.current = controller;

    try {
      const data = await api('/api/digest', {
        method: 'POST',
        timeoutMs: PULL_TIMEOUT_MS,
        signal: controller.signal,
      });
      setHistory((prev) => [data.digest, ...prev]);
      openReader(data.digest);
    } catch (e) {
      if (!e.cancelled) setError(e.message);
      setPhase('idle');
    } finally {
      pullRef.current = null;
    }
  }

  function cancelPull() {
    pullRef.current?.abort();
  }

  async function removeDigest(id) {
    const previous = history;
    setHistory((prev) => prev.filter((d) => d.id !== id));
    try {
      await api(`/api/digests/${id}`, { method: 'DELETE' });
    } catch (e) {
      setHistory(previous);
      setError(e.message);
    }
  }

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
        .fd-btn { transition: background-color 120ms ease, color 120ms ease, border-color 120ms ease, transform 120ms ease; }
        .fd-btn:active { transform: translateY(1px); }
        @keyframes fd-spin { to { transform: rotate(360deg); } }
        @keyframes fd-sweep { 0% { transform: translateX(-60%); } 100% { transform: translateX(260%); } }
        @keyframes fd-fade-in { from { opacity: 0; } to { opacity: 1; } }
        @keyframes fd-rise { from { opacity: 0; transform: translateY(14px); } to { opacity: 1; transform: none; } }

        .fd-page {
          max-width: 480px;
          margin: 0 auto;
          padding: max(28px, env(safe-area-inset-top)) max(20px, env(safe-area-inset-left))
                   calc(40px + env(safe-area-inset-bottom)) max(20px, env(safe-area-inset-right));
        }
        .fd-modal {
          position: fixed;
          inset: 0;
          z-index: 40;
          background: ${colors.bg};
          overflow-y: auto;
          -webkit-overflow-scrolling: touch;
          animation: fd-fade-in 180ms ease both;
        }
        .fd-reader-inner {
          max-width: 560px;
          margin: 0 auto;
          min-height: 100%;
          box-sizing: border-box;
          display: flex;
          flex-direction: column;
          padding: calc(20px + env(safe-area-inset-top)) max(24px, env(safe-area-inset-left))
                   calc(96px + env(safe-area-inset-bottom)) max(24px, env(safe-area-inset-right));
        }
        .fd-topic-body {
          animation: fd-rise 220ms cubic-bezier(0.22,0.61,0.36,1) both;
        }
        .fd-nav-island {
          position: fixed;
          z-index: 50;
          left: 50%;
          bottom: max(16px, env(safe-area-inset-bottom));
          transform: translateX(-50%);
          width: min(320px, calc(100% - 32px));
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 10px;
          padding: 8px 10px;
          box-sizing: border-box;
          border-radius: 999px;
          background: rgba(53, 63, 58, 0.92);
          border: 1px solid ${colors.border};
          backdrop-filter: blur(16px);
          -webkit-backdrop-filter: blur(16px);
          box-shadow: 0 10px 32px rgba(0, 0, 0, 0.32);
        }
        .fd-dots { display: flex; gap: 6px; }
        .fd-dot { width: 6px; height: 6px; border-radius: 999px; background: ${colors.border}; }
        .fd-dot[data-active="true"] { background: ${colors.accent}; }
        @media (prefers-reduced-motion: reduce) {
          .fd-modal, .fd-topic-body { animation: none; }
        }
      `}</style>

      <div className="fd-page">
        <div style={{ marginBottom: '28px' }}>
          <h1
            style={{
              fontFamily: "'Fraunces', serif",
              fontWeight: 600,
              fontSize: '28px',
              margin: 0,
              letterSpacing: '-0.01em',
            }}
          >
            Fintech Digest
          </h1>
          <p style={{ color: colors.textMuted, fontSize: '14px', marginTop: '8px', lineHeight: 1.6 }}>
            Weekly news for building a travel charge card — spend management, billing, rewards, and reconciliation.
            Nothing pulls in the background; press the button when you want to catch up.
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

        <button
          className="fd-btn"
          onClick={pull}
          style={{
            width: '100%',
            minHeight: '56px',
            borderRadius: '16px',
            border: 'none',
            background: colors.accent,
            color: colors.bg,
            fontSize: '16px',
            fontWeight: 600,
            cursor: 'pointer',
            marginBottom: '28px',
          }}
        >
          Pull this week's digest
        </button>

        {latest && (
          <section style={{ marginBottom: '32px' }}>
            <SectionHeading>Latest — {formatDate(latest.created_at)}</SectionHeading>
            <button
              className="fd-btn"
              onClick={() => openReader(latest)}
              style={{
                width: '100%',
                textAlign: 'left',
                background: colors.surface,
                border: `1px solid ${colors.border}`,
                borderRadius: '14px',
                padding: '16px',
                color: colors.text,
                cursor: 'pointer',
                fontFamily: 'inherit',
              }}
            >
              <p style={{ margin: 0, fontSize: '14px', lineHeight: 1.6 }}>{latest.headline}</p>
              <p style={{ margin: '10px 0 0', fontSize: '12px', color: colors.textMuted }}>
                {latest.topics.length} {latest.topics.length === 1 ? 'topic' : 'topics'} · Open to read →
              </p>
            </button>
          </section>
        )}

        <section style={{ marginBottom: '32px' }}>
          <SectionHeading>Past digests</SectionHeading>
          {historyLoading ? (
            <p style={{ color: colors.textMuted, fontSize: '13px' }}>Loading…</p>
          ) : history.length <= 1 ? (
            <p style={{ color: colors.textMuted, fontSize: '13px', lineHeight: 1.5 }}>
              {history.length === 0
                ? 'Nothing pulled yet. Hit the button above to get this week\'s digest.'
                : 'Pull again next week and past digests will stack up here.'}
            </p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {history.slice(1).map((d) => (
                <div
                  key={d.id}
                  style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: '8px',
                    background: colors.surface,
                    border: `1px solid ${colors.border}`,
                    borderRadius: '12px',
                    padding: '12px 14px',
                  }}
                >
                  <button
                    className="fd-btn"
                    onClick={() => openReader(d)}
                    style={{
                      flex: 1,
                      minWidth: 0,
                      textAlign: 'left',
                      background: 'none',
                      border: 'none',
                      color: colors.text,
                      cursor: 'pointer',
                      fontFamily: 'inherit',
                      padding: 0,
                    }}
                  >
                    <div style={{ fontSize: '12px', color: colors.textMuted, marginBottom: '4px' }}>
                      {formatDate(d.created_at)}
                    </div>
                    <div style={{ fontSize: '13px', lineHeight: 1.5 }}>{d.headline}</div>
                  </button>
                  <button
                    onClick={() => removeDigest(d.id)}
                    aria-label="Remove digest"
                    style={{
                      background: 'none',
                      border: 'none',
                      color: colors.textMuted,
                      cursor: 'pointer',
                      flexShrink: 0,
                      fontSize: '14px',
                      width: '32px',
                      height: '32px',
                    }}
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>

        <section>
          <SectionHeading>Sources</SectionHeading>
          <p style={{ color: colors.textMuted, fontSize: '12.5px', lineHeight: 1.7, margin: 0 }}>
            {SOURCE_NAMES.join(' · ')}
          </p>
        </section>
      </div>

      {phase === 'pulling' && <PullingModal elapsed={elapsed} onCancel={cancelPull} />}

      {phase === 'reader' && readerDigest && (
        <ReaderModal
          pages={pages}
          pageIndex={pageIndex}
          onGoTo={goTo}
          onClose={closeReader}
          onTouchStart={onTouchStart}
          onTouchEnd={onTouchEnd}
        />
      )}
    </div>
  );
}

function PullingModal({ elapsed, onCancel }) {
  return (
    <div className="fd-modal" role="dialog" aria-modal="true" aria-label="Pulling this week's digest">
      <div
        className="fd-reader-inner"
        style={{ justifyContent: 'center', alignItems: 'center', textAlign: 'center', gap: '28px' }}
      >
        <div>
          <div
            style={{
              fontSize: '12px',
              letterSpacing: '0.14em',
              textTransform: 'uppercase',
              color: colors.textMuted,
              marginBottom: '14px',
            }}
          >
            Reading this week's fintech news
          </div>
          <p style={{ fontFamily: "'Fraunces', serif", fontWeight: 500, fontSize: '20px', lineHeight: 1.4, margin: 0 }}>
            Checking {SOURCE_NAMES.join(', ')} for anything that touches cards, spend, or billing.
          </p>
        </div>

        <div
          aria-hidden="true"
          style={{
            width: '54px',
            height: '54px',
            borderRadius: '50%',
            border: `2px solid ${colors.border}`,
            borderTopColor: colors.accent,
            animation: 'fd-spin 900ms linear infinite',
          }}
        />
        <div
          aria-hidden="true"
          style={{ width: '100%', maxWidth: '220px', height: '2px', borderRadius: '999px', background: colors.border, overflow: 'hidden' }}
        >
          <div
            style={{
              width: '40%',
              height: '100%',
              borderRadius: '999px',
              background: colors.accent,
              animation: 'fd-sweep 1.6s ease-in-out infinite',
            }}
          />
        </div>
        <div role="status" style={{ fontSize: '13px', color: colors.textMuted }}>
          {elapsed}s — this can take up to a minute
        </div>

        <button
          className="fd-btn"
          onClick={onCancel}
          style={{
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

function ReaderModal({ pages, pageIndex, onGoTo, onClose, onTouchStart, onTouchEnd }) {
  const closeRef = useRef(null);
  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  const page = pages[pageIndex];
  const isHighlight = page.type === 'highlight';

  return (
    <div className="fd-modal" role="dialog" aria-modal="true" aria-label="Digest reader" onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
      <div className="fd-reader-inner">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
          <span style={{ fontSize: '12px', letterSpacing: '0.1em', textTransform: 'uppercase', color: colors.textMuted }}>
            {isHighlight ? 'This week' : `Topic ${pageIndex} of ${pages.length - 1}`}
          </span>
          <button
            ref={closeRef}
            className="fd-btn"
            onClick={onClose}
            aria-label="Close reader"
            style={{
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
              cursor: 'pointer',
            }}
          >
            ✕
          </button>
        </div>

        <div key={pageIndex} className="fd-topic-body" style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: '20px', padding: '24px 0' }}>
          {isHighlight ? (
            <>
              <p
                style={{
                  fontFamily: "'Fraunces', serif",
                  fontWeight: 500,
                  fontSize: '26px',
                  lineHeight: 1.5,
                  margin: 0,
                }}
              >
                {page.headline}
              </p>
              {pages.length > 1 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '12px' }}>
                  {pages.slice(1).map((t, i) => (
                    <button
                      key={t.title + i}
                      className="fd-btn"
                      onClick={() => onGoTo(i + 1)}
                      style={{
                        textAlign: 'left',
                        background: colors.surface,
                        border: `1px solid ${colors.border}`,
                        borderRadius: '10px',
                        padding: '12px 14px',
                        color: colors.text,
                        fontSize: '13.5px',
                        cursor: 'pointer',
                        fontFamily: 'inherit',
                      }}
                    >
                      {t.title}
                    </button>
                  ))}
                </div>
              )}
            </>
          ) : (
            <TopicPage topic={page} />
          )}
        </div>
      </div>

      <nav className="fd-nav-island" aria-label="Digest navigation">
        <button
          className="fd-btn"
          onClick={() => onGoTo(pageIndex - 1)}
          disabled={pageIndex === 0}
          aria-label="Previous"
          style={navBtnStyle(pageIndex === 0)}
        >
          ←
        </button>
        <div className="fd-dots" aria-hidden="true">
          {pages.map((_, i) => (
            <span key={i} className="fd-dot" data-active={i === pageIndex} />
          ))}
        </div>
        <button
          className="fd-btn"
          onClick={() => onGoTo(pageIndex + 1)}
          disabled={pageIndex === pages.length - 1}
          aria-label="Next"
          style={navBtnStyle(pageIndex === pages.length - 1)}
        >
          →
        </button>
      </nav>
    </div>
  );
}

function navBtnStyle(disabled) {
  return {
    width: '36px',
    height: '36px',
    borderRadius: '999px',
    border: 'none',
    background: disabled ? 'transparent' : colors.selectedFill,
    color: disabled ? colors.border : colors.text,
    fontSize: '15px',
    cursor: disabled ? 'default' : 'pointer',
  };
}

function TopicPage({ topic }) {
  const paragraphs = topic.explanation.split(/\n{2,}/).filter(Boolean);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '18px' }}>
      <h2 style={{ fontFamily: "'Fraunces', serif", fontWeight: 600, fontSize: '26px', lineHeight: 1.3, margin: 0 }}>
        {topic.title}
      </h2>
      <p style={{ color: colors.accent, fontSize: '16px', fontWeight: 500, lineHeight: 1.6, margin: 0 }}>{topic.highlight}</p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
        {paragraphs.map((p, i) => (
          <p key={i} style={{ fontSize: '15px', lineHeight: 1.75, margin: 0, color: colors.text }}>
            {p}
          </p>
        ))}
      </div>
      {topic.sources.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginTop: '8px' }}>
          {topic.sources.map((s, i) =>
            s.url ? (
              <a
                key={i}
                href={s.url}
                target="_blank"
                rel="noreferrer"
                style={{
                  fontSize: '12px',
                  padding: '7px 12px',
                  borderRadius: '999px',
                  border: `1px solid ${colors.border}`,
                  color: colors.textMuted,
                  textDecoration: 'none',
                }}
              >
                {s.name} ↗
              </a>
            ) : (
              <span
                key={i}
                style={{
                  fontSize: '12px',
                  padding: '7px 12px',
                  borderRadius: '999px',
                  border: `1px solid ${colors.border}`,
                  color: colors.textMuted,
                }}
              >
                {s.name}
              </span>
            )
          )}
        </div>
      )}
    </div>
  );
}

function SectionHeading({ children }) {
  return (
    <h2 style={{ fontFamily: "'Fraunces', serif", fontWeight: 600, fontSize: '15px', margin: '0 0 12px' }}>{children}</h2>
  );
}
