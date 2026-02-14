import 'dotenv/config';
import express from 'express';
import * as cheerio from 'cheerio';
import BrowserManager from './browser-manager.js';

const app = express();
app.use(express.json());

const TOKEN = process.env.API_SECRET || '2a6fdd3d9ad237fbe3ed821d78f845fc95328457b4c6a1d825cfeaee3688fc61';
const bm = new BrowserManager();

// ── Search cache + throttle ──
const searchCache = new Map();   // query → { results, ts }
const CACHE_TTL = 10 * 60_000;  // 10 min
let lastSearchTs = 0;
const MIN_GAP_MS = 1500;        // min 1.5s between DDG requests

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
];

function randomUA() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

// Auth
app.use((req, res, next) => {
  if (req.headers.authorization !== `Bearer ${TOKEN}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
});

// ──────────────────────────────────────────
// API 1: Search via DuckDuckGo HTML
// Cache + throttle + UA rotation to avoid rate limits
// ──────────────────────────────────────────
app.post('/search/duckduckgo', async (req, res) => {
  try {
    const { query } = req.body;
    const cacheKey = query.trim().toLowerCase();

    // Return cached if fresh
    const cached = searchCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < CACHE_TTL) {
      return res.json({ results: cached.results, cached: true });
    }

    // Throttle: wait if too soon since last request
    const now = Date.now();
    const wait = Math.max(0, MIN_GAP_MS - (now - lastSearchTs));
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastSearchTs = Date.now();

    const resp = await fetch('https://html.duckduckgo.com/html/', {
      method: 'POST',
      headers: {
        'User-Agent': randomUA(),
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'text/html',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      body: `q=${encodeURIComponent(query)}`,
    });

    const html = await resp.text();
    const $ = cheerio.load(html);

    const results = [];
    const seen = new Set();

    $('.result').each((_, el) => {
      if (results.length >= 10) return false;
      const a = $(el).find('a.result__a').first();
      const href = a.attr('href') || '';
      if (!href.startsWith('http') || href.includes('duckduckgo.com/y.js') || seen.has(href)) return;
      seen.add(href);
      const title = a.text().trim();
      if (!title) return;
      const snippet = $(el).find('.result__snippet').first().text().trim();
      results.push({ title, url: href, snippet });
    });

    // Cache the results
    searchCache.set(cacheKey, { results, ts: Date.now() });

    // Evict old cache entries
    if (searchCache.size > 500) {
      const cutoff = Date.now() - CACHE_TTL;
      for (const [k, v] of searchCache) {
        if (v.ts < cutoff) searchCache.delete(k);
      }
    }

    res.json({ results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ──────────────────────────────────────────
// API 4: Search via Google (Oxylabs SERP API)
// ──────────────────────────────────────────
const GOOGLE_CACHE_TTL = 30 * 60_000;
const OXY_SERP_AUTH = 'Basic ' + Buffer.from(`${process.env.OXY_SCRAPER_USERNAME}:${process.env.OXY_SCRAPER_PASSWORD}`).toString('base64');

app.post('/search/google', async (req, res) => {
  try {
    const { query } = req.body;
    const cacheKey = `g:${query.trim().toLowerCase()}`;

    const cached = searchCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < GOOGLE_CACHE_TTL) {
      return res.json({ results: cached.results, cached: true });
    }

    const resp = await fetch('https://realtime.oxylabs.io/v1/queries', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': OXY_SERP_AUTH,
      },
      body: JSON.stringify({
        source: 'google_search',
        query,
        parse: true,
        context: [{ key: 'filter', value: 1 }],
      }),
      signal: AbortSignal.timeout(30000),
    });

    console.log(`[google] serp resp: ${resp.status} for query "${query}"`);
    const data = await resp.json();
    console.log(`[google] serp status: ${resp.status}`);

    if (!resp.ok) {
      return res.status(resp.status).json({ error: data.message || 'Oxylabs SERP error' });
    }

    const organic = data.results?.[0]?.content?.results?.organic || [];
    const results = organic.slice(0, 10).map((r) => ({
      title: r.title,
      url: r.url,
      snippet: r.desc || '',
    }));

    if (results.length > 0) {
      searchCache.set(cacheKey, { results, ts: Date.now() });
    }

    res.json({ results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// ──────────────────────────────────────────
// API 2: Visit URL → find excerpt → return extended text around it
// Direct HTTP + cheerio (fast, works on most sites)
// Falls back to browser if HTTP extraction is empty
// ──────────────────────────────────────────
function extractFromText(body, excerpt, charsBefore, charsAfter, title, pageUrl) {
  if (!body || body.length === 0) return null;

  let index = body.indexOf(excerpt);

  // Fuzzy: match first 40 chars
  if (index === -1) {
    const short = excerpt.slice(0, 40);
    index = body.indexOf(short);
    if (index === -1) {
      return { found: false, title, url: pageUrl, fullText: body.slice(0, 5000) };
    }
    const start = Math.max(0, index - charsBefore);
    const end = Math.min(body.length, index + short.length + charsAfter);
    return { found: true, title, url: pageUrl, extractedText: body.slice(start, end) };
  }

  const start = Math.max(0, index - charsBefore);
  const end = Math.min(body.length, index + excerpt.length + charsAfter);
  return { found: true, title, url: pageUrl, extractedText: body.slice(start, end) };
}

// Fast HTTP-only extraction (no browser, for batch use)
async function extractFast(url, excerpt, charsBefore, charsAfter) {
  const httpResp = await fetch(url, {
    headers: {
      'User-Agent': randomUA(),
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'en-US,en;q=0.9',
    },
    signal: AbortSignal.timeout(8000),
  }).catch(() => null);

  if (!httpResp || !httpResp.ok) return null;

  const html = await httpResp.text();
  const $ = cheerio.load(html);
  $('nav, footer, header, aside, script, style, iframe, noscript').remove();
  const title = $('title').text().trim();
  const body = ($('article, main, [role="main"]').first().text() || $('body').text()).trim();

  const result = extractFromText(body, excerpt, charsBefore, charsAfter, title, url);
  return (result && result.found) ? result : null;
}

// Full extraction: HTTP first, then browser fallback
async function extractOneUrl(url, excerpt, charsBefore, charsAfter, userId) {
  const fast = await extractFast(url, excerpt, charsBefore, charsAfter);
  if (fast) return fast;

  // ── Fallback: browser (for JS-heavy sites) ──
  const { context } = await bm.getSession(userId);
  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: 'load', timeout: 45000 });
    await page.waitForFunction(
      () => (document.body?.innerText?.length || 0) > 100,
      { timeout: 25000 }
    ).catch(() => {});

    const result = await page.evaluate(() => {
      document.querySelectorAll('nav, footer, header, aside, script, style, iframe').forEach((el) => el.remove());
      const body = (document.querySelector('article, main, [role="main"]') || document.body).innerText;
      return { body, title: document.title, url: window.location.href };
    });

    return extractFromText(result.body, excerpt, charsBefore, charsAfter, result.title, result.url)
      || { found: false, title: result.title, url: result.url, fullText: '' };
  } finally {
    await page.close();
  }
}

// ── Single extract ──
app.post('/extract', async (req, res) => {
  try {
    const { userId, url, excerpt, charsBefore = 500, charsAfter = 1000 } = req.body;
    const result = await extractOneUrl(url, excerpt, charsBefore, charsAfter, userId);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Batch extract: HTTP-only, parallel, skip failures ──
app.post('/extract-batch', async (req, res) => {
  try {
    const { items, charsBefore = 500, charsAfter = 1000 } = req.body;

    const settled = await Promise.allSettled(
      items.map((item) =>
        extractFast(
          item.url,
          item.excerpt,
          item.charsBefore ?? charsBefore,
          item.charsAfter ?? charsAfter
        )
      )
    );

    const results = settled
      .map((r) => {
        if (r.status === 'fulfilled' && r.value) {
          return r.value;
        }
        return null;
      })
      .filter(Boolean);

    res.json({ results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Health check
app.get('/health', (_, res) => res.json({ ok: true, sessions: bm.sessions.size }));

// Start
await bm.start();
app.listen(3000, () => console.log('Browser server running on :3000'));
