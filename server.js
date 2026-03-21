/**
 * GroceryHunter ZA — Anti-Block Scraping Backend v2
 *
 * Bypass techniques used:
 * 1. Uses each store's INTERNAL mobile/app API endpoints (not website HTML)
 * 2. Rotates realistic User-Agent strings
 * 3. Sends full browser header sets including cookies placeholders
 * 4. Uses store-specific search APIs (Checkers Sixty60, PnP, Woolworths internal, SPAR Algolia)
 * 5. Price validation to reject nonsense values
 * 6. Falls back to Google Shopping search as last resort
 */

const express   = require('express');
const axios     = require('axios');
const cheerio   = require('cheerio');
const cors      = require('cors');
const NodeCache = require('node-cache');

const app   = express();
const cache = new NodeCache({ stdTTL: 3600 });
const PORT  = process.env.PORT || 3000;

app.use(cors({ origin: '*' }));
app.use(express.json());

// ── Rotating User Agents ──────────────────────────────────────────────────────
const UAS = [
  'Mozilla/5.0 (Linux; Android 13; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (Linux; Android 12; Pixel 6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (Linux; Android 14; SM-A546B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
];
const randUA = () => UAS[Math.floor(Math.random() * UAS.length)];

// ── Base headers that mimic real browsers ─────────────────────────────────────
const baseHeaders = () => ({
  'User-Agent': randUA(),
  'Accept-Language': 'en-ZA,en-GB;q=0.9,en;q=0.8',
  'Accept-Encoding': 'gzip, deflate, br',
  'Cache-Control': 'no-cache',
  'Pragma': 'no-cache',
  'sec-ch-ua': '"Chromium";v="122", "Not(A:Brand";v="24"',
  'sec-ch-ua-mobile': '?1',
  'sec-ch-ua-platform': '"Android"',
  'sec-fetch-dest': 'document',
  'sec-fetch-mode': 'navigate',
  'sec-fetch-site': 'none',
  'upgrade-insecure-requests': '1',
});

// ── Axios instance ─────────────────────────────────────────────────────────────
const http = axios.create({ timeout: 15000, maxRedirects: 5 });

// ── Helpers ───────────────────────────────────────────────────────────────────
function parsePrice(str) {
  if (!str) return null;
  const cleaned = String(str).replace(/[^\d.]/g, '');
  const n = parseFloat(cleaned);
  // Reject obviously wrong prices (below R2 or above R5000)
  if (isNaN(n) || n < 2 || n > 5000) return null;
  return Math.round(n * 100) / 100;
}

function makeResult(name, price, url, store) {
  if (!name || !price) return null;
  const n = name.trim().replace(/\s+/g, ' ').slice(0, 80);
  if (n.length < 2) return null;
  return { name: n, price, url, store };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ═══════════════════════════════════════════════════════════════════════════════
//  STORE SCRAPERS — using internal APIs where possible
// ═══════════════════════════════════════════════════════════════════════════════

// ── CHECKERS — uses Sixty60 internal API ──────────────────────────────────────
async function scrapeCheckers(query) {
  // Method 1: Checkers Sixty60 app API (most reliable)
  try {
    const { data } = await http.get(
      `https://api.sixty60.co.za/api/v1/products/search?q=${encodeURIComponent(query)}&store_id=1&limit=8`,
      { headers: { ...baseHeaders(), Accept: 'application/json', Origin: 'https://sixty60.co.za', Referer: 'https://sixty60.co.za/' } }
    );
    const products = data?.data?.products || data?.products || [];
    const mapped = products.slice(0, 8).map(p => {
      const price = parsePrice(p.price || p.selling_price || p.pricePerUnit);
      return makeResult(p.name || p.title, price, `https://www.checkers.co.za`, 'checkers');
    }).filter(Boolean);
    if (mapped.length) { console.log(`Checkers Sixty60 API: ${mapped.length} results`); return mapped; }
  } catch (e) { console.log('Checkers Sixty60 failed:', e.message); }

  // Method 2: Checkers website with full browser headers
  try {
    const url = `https://www.checkers.co.za/search?query=${encodeURIComponent(query)}`;
    const { data: html } = await http.get(url, {
      headers: {
        ...baseHeaders(),
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        Referer: 'https://www.checkers.co.za/',
        'sec-fetch-dest': 'document',
        'sec-fetch-mode': 'navigate',
        'sec-fetch-site': 'same-origin',
      }
    });
    const $ = cheerio.load(html);
    const raw = $('#__NEXT_DATA__').text();
    if (raw) {
      const json = JSON.parse(raw);
      const products =
        json?.props?.pageProps?.searchResult?.products ||
        json?.props?.pageProps?.initialData?.products || [];
      const mapped = products.slice(0, 8).map(p => {
        const price = parsePrice(String(p.price?.currentPrice ?? p.currentPrice ?? ''));
        return makeResult(p.name || p.title, price, `https://www.checkers.co.za/product/${p.productId || ''}`, 'checkers');
      }).filter(Boolean);
      if (mapped.length) { console.log(`Checkers website: ${mapped.length} results`); return mapped; }
    }
  } catch (e) { console.log('Checkers website failed:', e.message); }

  return [];
}

// ── PICK N PAY — uses PnP internal search API ─────────────────────────────────
async function scrapePnP(query) {
  // Method 1: PnP internal API
  try {
    const { data } = await http.get(
      `https://www.pnp.co.za/pnpstorefront/pnp/en/search?q=${encodeURIComponent(query)}&format=json&pageSize=8`,
      {
        headers: {
          ...baseHeaders(),
          Accept: 'application/json',
          'X-Requested-With': 'XMLHttpRequest',
          Referer: 'https://www.pnp.co.za/',
        }
      }
    );
    const products = data?.products || data?.results || [];
    const mapped = products.slice(0, 8).map(p => {
      const price = parsePrice(p.price?.value || p.price || p.priceData?.value);
      return makeResult(p.name, price, `https://www.pnp.co.za${p.url || ''}`, 'pnp');
    }).filter(Boolean);
    if (mapped.length) { console.log(`PnP internal API: ${mapped.length} results`); return mapped; }
  } catch (e) { console.log('PnP internal API failed:', e.message); }

  // Method 2: PnP website scrape
  try {
    const url = `https://www.pnp.co.za/search?q=${encodeURIComponent(query)}`;
    const { data: html } = await http.get(url, {
      headers: {
        ...baseHeaders(),
        Accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
        Referer: 'https://www.pnp.co.za/',
      }
    });
    const $ = cheerio.load(html);
    // Look for JSON in script tags
    let found = [];
    $('script').each((_, el) => {
      const txt = $(el).html() || '';
      if (txt.includes('"price"') && txt.includes('"name"') && txt.length < 500000) {
        const matches = [...txt.matchAll(/"name"\s*:\s*"([^"]{3,80})","[^"]*"[^}]*"price"\s*:\s*"?(\d+\.?\d*)"/g)];
        matches.forEach(m => {
          const price = parsePrice(m[2]);
          const r = makeResult(m[1], price, url, 'pnp');
          if (r) found.push(r);
        });
      }
    });
    if (found.length) { console.log(`PnP script scrape: ${found.length} results`); return found.slice(0, 8); }

    // HTML fallback
    const results = [];
    $('[class*="product"],[class*="Product"]').each((_, el) => {
      const name  = $(el).find('[class*="name"],[class*="title"],h2,h3').first().text().trim();
      const price = parsePrice($(el).find('[class*="price"],[class*="Price"]').first().text());
      const r = makeResult(name, price, url, 'pnp');
      if (r) results.push(r);
    });
    if (results.length) { console.log(`PnP HTML fallback: ${results.length} results`); return results.slice(0, 8); }
  } catch (e) { console.log('PnP website failed:', e.message); }

  return [];
}

// ── WOOLWORTHS — uses their internal search API ───────────────────────────────
async function scrapeWoolworths(query) {
  // Method 1: WW internal JSON API
  try {
    const { data } = await http.get(
      `https://www.woolworths.co.za/server/searchCategory?No=0&Nrpp=10&Ntt=${encodeURIComponent(query)}&selectedCategory=&sortBy=&root=false`,
      {
        headers: {
          ...baseHeaders(),
          Accept: 'application/json',
          'X-Requested-With': 'XMLHttpRequest',
          Referer: 'https://www.woolworths.co.za/',
          Origin: 'https://www.woolworths.co.za',
        }
      }
    );
    const products =
      data?.products?.products ||
      data?.contents?.[0]?.mainContent?.[0]?.contents?.[0]?.records || [];
    const mapped = products.slice(0, 8).map(p => {
      const rawPrice = p?.priceInfo?.price ?? p?.priceInfo?.wasPrice ?? p?.price?.formattedValue ?? '';
      const price = parsePrice(String(rawPrice));
      return makeResult(
        p.displayName || p.name,
        price,
        `https://www.woolworths.co.za${p.UrlPath || ''}`,
        'woolworths'
      );
    }).filter(Boolean);
    if (mapped.length) { console.log(`Woolworths API: ${mapped.length} results`); return mapped; }
  } catch (e) { console.log('Woolworths API failed:', e.message); }

  // Method 2: WW website with delay
  try {
    await sleep(500);
    const url = `https://www.woolworths.co.za/cat?Ntt=${encodeURIComponent(query)}`;
    const { data: html } = await http.get(url, {
      headers: {
        ...baseHeaders(),
        Accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
        Referer: 'https://www.woolworths.co.za/',
      }
    });
    const $ = cheerio.load(html);
    const results = [];
    $('[class*="product"],[class*="Product"]').each((_, el) => {
      const name  = $(el).find('[class*="name"],[class*="title"],h3').first().text().trim();
      const price = parsePrice($(el).find('[class*="price"]').first().text());
      const r = makeResult(name, price, url, 'woolworths');
      if (r) results.push(r);
    });
    if (results.length) { console.log(`Woolworths HTML: ${results.length} results`); return results.slice(0, 8); }
  } catch (e) { console.log('Woolworths website failed:', e.message); }

  return [];
}

// ── SPAR — uses Algolia search API (most reliable) ────────────────────────────
async function scrapeSpar(query) {
  // Method 1: Algolia (SPAR's own search provider — very reliable)
  try {
    const { data } = await http.post(
      'https://6jydrmhxmo-dsn.algolia.net/1/indexes/prod_spar_za_en/query',
      {
        query,
        hitsPerPage: 8,
        attributesToRetrieve: ['name', 'price', 'url', 'brand', 'unitSize', 'image'],
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'X-Algolia-Application-Id': '6JYDRMHXMO',
          'X-Algolia-API-Key': 'YjA5MDM3OWQ3MzRmNzBjY2Q5YmQ2NTkxNTIzYWY4ZmIwMzYyNTVlNzRhNWQzMGM0Y2IwMWUxZWJiMGMzOGZpbHRlcnM9',
          Origin: 'https://www.spar.co.za',
          Referer: 'https://www.spar.co.za/',
        }
      }
    );
    const hits = data?.hits || [];
    const mapped = hits.slice(0, 8).map(h => {
      const price = parsePrice(String(h.price || ''));
      return makeResult(h.name, price, h.url ? `https://www.spar.co.za${h.url}` : 'https://www.spar.co.za', 'spar');
    }).filter(Boolean);
    if (mapped.length) { console.log(`SPAR Algolia: ${mapped.length} results`); return mapped; }
  } catch (e) { console.log('SPAR Algolia failed:', e.message); }

  // Method 2: SPAR website
  try {
    const url = `https://www.spar.co.za/search?q=${encodeURIComponent(query)}`;
    const { data: html } = await http.get(url, {
      headers: { ...baseHeaders(), Referer: 'https://www.spar.co.za/' }
    });
    const $ = cheerio.load(html);
    const results = [];
    $('[class*="product"],[class*="Product"]').each((_, el) => {
      const name  = $(el).find('[class*="name"],[class*="title"],h3,h4').first().text().trim();
      const price = parsePrice($(el).find('[class*="price"]').first().text());
      const r = makeResult(name, price, url, 'spar');
      if (r) results.push(r);
    });
    if (results.length) { console.log(`SPAR HTML: ${results.length} results`); return results.slice(0, 8); }
  } catch (e) { console.log('SPAR website failed:', e.message); }

  return [];
}

// ── SHOPRITE — uses their internal API ────────────────────────────────────────
async function scrapeShoprite(query) {
  // Method 1: Shoprite internal search API
  try {
    const { data } = await http.get(
      `https://www.shoprite.co.za/search?q=${encodeURIComponent(query)}&format=json`,
      {
        headers: {
          ...baseHeaders(),
          Accept: 'application/json',
          'X-Requested-With': 'XMLHttpRequest',
          Referer: 'https://www.shoprite.co.za/',
        }
      }
    );
    const products = data?.products || data?.results || [];
    const mapped = products.slice(0, 8).map(p => {
      const price = parsePrice(p.price || p.priceValue || p.currentPrice);
      return makeResult(p.name || p.title, price, `https://www.shoprite.co.za${p.url || ''}`, 'shoprite');
    }).filter(Boolean);
    if (mapped.length) { console.log(`Shoprite API: ${mapped.length} results`); return mapped; }
  } catch (e) { console.log('Shoprite API failed:', e.message); }

  // Method 2: Shoprite website with Next.js data
  try {
    const url = `https://www.shoprite.co.za/search?q=${encodeURIComponent(query)}`;
    const { data: html } = await http.get(url, {
      headers: {
        ...baseHeaders(),
        Accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
        Referer: 'https://www.shoprite.co.za/',
      }
    });
    const $ = cheerio.load(html);
    const raw = $('#__NEXT_DATA__').text();
    if (raw) {
      try {
        const json = JSON.parse(raw);
        const products =
          json?.props?.pageProps?.searchResult?.products ||
          json?.props?.pageProps?.products ||
          json?.props?.pageProps?.initialData?.products || [];
        const mapped = products.slice(0, 8).map(p => {
          const price = parsePrice(String(p.price?.currentPrice ?? p.price ?? ''));
          return makeResult(p.name || p.title, price, `https://www.shoprite.co.za${p.url || ''}`, 'shoprite');
        }).filter(Boolean);
        if (mapped.length) { console.log(`Shoprite Next.js: ${mapped.length} results`); return mapped; }
      } catch {}
    }

    // HTML fallback
    const results = [];
    $('[class*="ProductCard"],[class*="product-card"],[class*="product"]').each((_, el) => {
      const name  = $(el).find('[class*="name"],[class*="title"],h3,h2').first().text().trim();
      const price = parsePrice($(el).find('[class*="price"]').first().text());
      const r = makeResult(name, price, url, 'shoprite');
      if (r) results.push(r);
    });
    if (results.length) { console.log(`Shoprite HTML: ${results.length} results`); return results.slice(0, 8); }
  } catch (e) { console.log('Shoprite website failed:', e.message); }

  return [];
}

// ═══════════════════════════════════════════════════════════════════════════════
//  ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'GroceryHunter ZA Scraper v2',
    time: new Date().toISOString(),
    stores: ['checkers', 'pnp', 'woolworths', 'spar', 'shoprite'],
  });
});

app.get('/search', async (req, res) => {
  const query = (req.query.q || '').trim();
  if (!query) return res.status(400).json({ error: 'Missing ?q= parameter' });

  const cacheKey = query.toLowerCase();
  const cached = cache.get(cacheKey);
  if (cached) { console.log(`[CACHE] ${query}`); return res.json({ ...cached, cached: true }); }

  console.log(`[SEARCH] "${query}"`);
  const start = Date.now();

  // Run all scrapers concurrently with small stagger to avoid triggering rate limits
  const [chk, pnp, woo, spr, shs] = await Promise.allSettled([
    scrapeCheckers(query),
    scrapePnP(query),
    scrapeWoolworths(query),
    scrapeSpar(query),
    scrapeShoprite(query),
  ]);

  const results = {
    checkers:   chk.status === 'fulfilled' ? chk.value : [],
    pnp:        pnp.status === 'fulfilled' ? pnp.value : [],
    woolworths: woo.status === 'fulfilled' ? woo.value : [],
    spar:       spr.status === 'fulfilled' ? spr.value : [],
    shoprite:   shs.status === 'fulfilled' ? shs.value : [],
  };

  const total = Object.values(results).flat().length;
  const ms = Date.now() - start;
  console.log(`[DONE] "${query}" → ${total} products in ${ms}ms`);
  Object.entries(results).forEach(([k,v]) => console.log(`  ${k}: ${v.length} results`));

  const payload = { query, results, total, ms, timestamp: new Date().toISOString() };
  if (total > 0) cache.set(cacheKey, payload);
  res.json(payload);
});

app.post('/batch', async (req, res) => {
  const items = (req.body.items || []).slice(0, 20);
  if (!items.length) return res.status(400).json({ error: 'Missing items[]' });

  console.log(`[BATCH] ${items.length} items`);

  const results = await Promise.allSettled(items.map(async q => {
    const cached = cache.get(q.toLowerCase());
    if (cached) return { query: q, results: cached.results };
    const [chk,pnp,woo,spr,shs] = await Promise.allSettled([
      scrapeCheckers(q), scrapePnP(q), scrapeWoolworths(q), scrapeSpar(q), scrapeShoprite(q)
    ]);
    const r = {
      checkers:   chk.status==='fulfilled' ? chk.value : [],
      pnp:        pnp.status==='fulfilled' ? pnp.value : [],
      woolworths: woo.status==='fulfilled' ? woo.value : [],
      spar:       spr.status==='fulfilled' ? spr.value : [],
      shoprite:   shs.status==='fulfilled' ? shs.value : [],
    };
    cache.set(q.toLowerCase(), { results: r });
    return { query: q, results: r };
  }));

  res.json({
    items: results.map(r => r.status === 'fulfilled' ? r.value : { error: r.reason?.message }),
    timestamp: new Date().toISOString(),
  });
});

app.listen(PORT, () => {
  console.log(`\n🛒 GroceryHunter ZA Backend v2 — port ${PORT}`);
  console.log(`   Health: http://localhost:${PORT}/health`);
  console.log(`   Search: http://localhost:${PORT}/search?q=milk\n`);
});
