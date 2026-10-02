import Anthropic from '@anthropic-ai/sdk';

import { completeDigest, failDigest } from './digestStore.js';

// The specific outlets recommended for staying on top of card issuing,
// spend management, and SMB travel billing — see the newsletter research
// this feature was built from.
export const SOURCES = [
  { name: 'Finextra', domain: 'finextra.com', note: 'daily fintech news wire' },
  {
    name: 'Fintech Business Weekly',
    domain: 'fintechbusinessweekly.substack.com',
    note: "Jason Mikula's newsletter — sharp on BaaS, compliance, and enforcement",
  },
  {
    name: 'Fintech Brainfood',
    domain: 'fintechbrainfood.com',
    note: "Simon Taylor's newsletter — strategy and where the industry is heading",
  },
  {
    name: 'Fintech Takes',
    domain: 'fintechtakes.com',
    note: "Alex Johnson's newsletter — opinionated, good on payments and infrastructure",
  },
];

// What the digest should filter for. Edit this if the role changes.
const FOCUS =
  'a product leader who owns a travel charge card: growing the card itself, building a spend management ' +
  'product, keeping billing clear for SMBs booking team travel, accounting-system integrations (QuickBooks, ' +
  'NetSuite, Xero, etc.), rewards, and reconciliation.';

const MODEL = 'claude-sonnet-5';

// Generation now runs in a Netlify background function (up to 15 minutes),
// not a synchronous request, so this just guards against a hung connection
// — set well under that ceiling to leave room for the Supabase write-back.
export const DIGEST_TIMEOUT_MS = 600_000;

export function buildPrompt() {
  const sourceList = SOURCES.map((s) => `- ${s.name} (${s.domain}): ${s.note}`).join('\n');
  return `You are producing a weekly news digest for ${FOCUS}

Search these sources for news and analysis from the last 7 days:
${sourceList}

You have a limited number of searches, so be efficient: one focused search per source is usually enough.

Only include stories genuinely relevant to that role: travel/corporate charge cards, card issuing, spend management and expense software, corporate travel booking, SMB billing and invoicing, accounting integrations, card rewards, embedded finance/BaaS as it touches card programs, and payments regulation that would affect a card issuer. Skip unrelated fintech news (consumer crypto, pure consumer banking apps, etc.) unless it teaches a real lesson for a card/spend-management product.

Pick only the 3 most important stories from what you find — quality over coverage. For each one, write two versions:
1. "highlight": one or two punchy sentences — what happened, in plain English.
2. "explanation": a thorough explanation written for a smart middle schooler. No jargon left unexplained — define any term (like "BaaS", "interchange", or "float") the first time you use it. Explain why it matters and what it means for a team building a travel charge card and spend management product. Exactly two short paragraphs, plain sentences, no bullet lists.

Also write a top-level "headline": 2-3 sentences summarizing the week across all the stories, for someone catching up after a busy week.

You are on a tight length budget. Stay concise throughout — this is a quick-read digest, not a report. If you're ever unsure whether you have room to finish, stop adding stories and close out the JSON for the ones you already have rather than starting a new one you might not finish. A complete JSON object with 2 stories is far better than a truncated one with 3.

This will be parsed with JSON.parse, so it must be strictly valid JSON. Never use a bare double-quote character inside a string value (not even to quote a phrase, a headline, or someone's exact words) — use single quotes ' instead, or rephrase. Escape any character that JSON requires escaping.

Respond with ONLY this JSON shape, no prose and no markdown fences:
{
  "headline": "...",
  "topics": [
    {
      "title": "short topic title",
      "highlight": "...",
      "explanation": "...",
      "sources": [{"name": "Publication name", "url": "https://..."}]
    }
  ]
}

Every topic needs at least one source with a real URL from the page you actually found it on. Do not invent URLs — use null for a source's url only if you truly cannot find the direct link.`;
}

export function extractDigest(message) {
  const text = message.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n');

  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    console.error('No JSON object in model reply:', text);
    throw new Error('The model replied without a JSON object. Try pulling again.');
  }

  let parsed;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch (err) {
    console.error('Malformed JSON in model reply:', err.message, text);
    throw new Error("The model's reply wasn't valid JSON (usually a stray quote in the text). Try pulling again.");
  }
  if (typeof parsed?.headline !== 'string' || !Array.isArray(parsed.topics)) {
    throw new Error('The model reply was missing a headline or topics.');
  }

  const topics = parsed.topics
    .filter(
      (t) => t && typeof t.title === 'string' && typeof t.highlight === 'string' && typeof t.explanation === 'string'
    )
    .slice(0, 8)
    .map((t) => ({
      title: t.title.trim(),
      highlight: t.highlight.trim(),
      explanation: t.explanation.trim(),
      sources: Array.isArray(t.sources)
        ? t.sources
            .filter((s) => s && typeof s.name === 'string')
            .slice(0, 4)
            .map((s) => ({
              name: s.name.trim(),
              url: typeof s.url === 'string' && s.url.trim().startsWith('http') ? s.url.trim() : null,
            }))
        : [],
    }));

  if (!topics.length) throw new Error('No relevant stories turned up this week. Try pulling again later.');

  return { headline: parsed.headline.trim(), topics };
}

export async function generateDigest() {
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const stream = anthropic.messages.stream(
    {
      model: MODEL,
      // Generous now that this runs as a background job instead of racing a
      // 60s request limit: search tool-use content eats into this budget
      // before the model ever writes the JSON, which is what was causing
      // "No JSON object in model reply" even on a trimmed prompt.
      max_tokens: 12000,
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 4 }],
      messages: [{ role: 'user', content: buildPrompt() }],
    },
    { timeout: DIGEST_TIMEOUT_MS }
  );

  return extractDigest(await stream.finalMessage());
}

export function isTimeout(err) {
  return err?.name === 'APIConnectionTimeoutError' || /timeout/i.test(err?.message ?? '');
}

// The actual work behind a pull: run the search, then write the result (or
// failure) onto the pending row created when the button was pressed. Called
// from a Netlify background function in production and fire-and-forget from
// the local Express server — never awaited by the request that started it.
export async function runDigestJob(id) {
  try {
    const digest = await generateDigest();
    await completeDigest(id, digest);
  } catch (err) {
    console.error('digest job failed', err);
    await failDigest(
      id,
      isTimeout(err) ? 'The web search took too long. Try pulling again.' : err.message ?? 'Digest failed'
    );
  }
}
