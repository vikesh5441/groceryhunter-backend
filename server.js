/**
 * GroceryHunter ZA — Scraping Backend
 * Deploys free on Render.com
 * Scrapes: Checkers, Pick n Pay, Woolworths, SuperSPAR, Shoprite
 *
 * Endpoints:
 *   GET /health              → status check
 *   GET /search?q=milk       → search all stores concurrently
 *   GET /search?q=milk&store=checkers  → single store
 */

const express = require('express');
const axios   = require('axios');
const cheerio = require('cheerio');
const cors    = require('cors');
const NodeCache = require('node-cache');

const app   = express();
const cache = new NodeCache({ stdTTL: 3600 }); // cache results 1 hour
const PORT  = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ── Browser-like headers ──────────────────────────────────────────────────────
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-ZA,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Connection': 'keep-alive',
};

const http = axios.create({
  timeout: 12000,
  headers: HEADERS,
  maxRedirects: 5,
});

// ── Helpers ───────────────────────────────────────────────────────────────────
function parsePrice(str) {
  if (!str) return null;
  const n = parseFloat(str.replace(/[^0-9.]/g, ''));
  return isNaN(n) || n <= 0 ? null : n;
}

function makeResult(name, price, url, store) {
  if (!name || !price) return null;
  return { name: name.trim().slice(0, 100), price, url, store };
}

// ═══════════════════════════════════════════════════════════════════════════════
//  SCRAPERS
// ═══════════════════════════════════════════════════════════════════════════════

// ── Checkers ──────────────────────────────────────────────────────────────────
async function scrapeCheckers(query) {
  const url = `https://www.checkers.co.za/search?query=${encodeURIComponent(query)}`;
  try {
    const { data: html } = await http.get(url, {
      headers: { ...HEADERS, Referer: 'https://www.checkers.co.za/' }
    });
    const $ = cheerio.load(html);

    // Try Next.js data blob first
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
      if (mapped.length) return mapped;
    }

    // HTML fallback
    const results = [];
    $('[class*="ProductCard"], [class*="product-card"], .product-frame').each((_, el) => {
      const name  = $(el).find('[class*="title"],[class*="name"],h3,h4').first().text().trim();
      const price = parsePrice($(el).find('[class*="price"],.price').first().text());
      const r = makeResult(name, price, url, 'checkers');
      if (r) results.push(r);
    });
    return results.slice(0, 8);
  } catch (e) {
    console.error('Checkers error:', e.message);
    return [];
  }
}

// ── Pick n Pay ────────────────────────────────────────────────────────────────
async function scrapePnP(query) {
  const url = `https://www.pnp.co.za/search?q=${encodeURIComponent(query)}`;
  try {
    const { data: html } = await http.get(url, {
      headers: { ...HEADERS, Referer: 'https://www.pnp.co.za/' }
    });
    const $ = cheerio.load(html);

    // Try embedded JSON
    for (const tag of $('script').toArray()) {
      const content = $(tag).html() || '';
      if (content.includes('"products"') && content.includes('"price"')) {
        const match = content.match(/"products"\s*:\s*(\[[\s\S]*?\])/);
        if (match) {
          try {
            const products = JSON.parse(match[1]);
            const mapped = products.slice(0, 8).map(p => {
              const price = parsePrice(String(p.price || p.listPrice || ''));
              return makeResult(p.name || p.title, price, `https://www.pnp.co.za${p.url || ''}`, 'pnp');
            }).filter(Boolean);
            if (mapped.length) return mapped;
          } catch {}
        }
      }
    }

    // HTML fallback
    const results = [];
    $('[class*="product"],[class*="Product"]').each((_, el) => {
      const name  = $(el).find('[class*="name"],[class*="title"],h2,h3').first().text().trim();
      const price = parsePrice($(el).find('[class*="price"],[class*="Price"]').first().text());
      const r = makeResult(name, price, url, 'pnp');
      if (r) results.push(r);
    });
    return results.slice(0, 8);
  } catch (e) {
    console.error('PnP error:', e.message);
    return [];
  }
}

// ── Woolworths ────────────────────────────────────────────────────────────────
async function scrapeWoolworths(query) {
  // WW has an internal JSON search API
  const apiUrl = `https://www.woolworths.co.za/server/searchCategory?No=0&Nrpp=10&Ntt=${encodeURIComponent(query)}&selectedCategory=&sortBy=&root=false`;
  try {
    const { data } = await http.get(apiUrl, {
      headers: {
        ...HEADERS,
        Accept: 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
        Referer: 'https://www.woolworths.co.za/',
      }
    });

    const products =
      data?.products?.products ||
      data?.contents?.[0]?.mainContent?.[0]?.contents?.[0]?.records || [];

    const mapped = products.slice(0, 8).map(p => {
      const rawPrice = p?.priceInfo?.price ?? p?.price?.formattedValue ?? '';
      const price = parsePrice(String(rawPrice));
      return makeResult(
        p.displayName || p.name,
        price,
        `https://www.woolworths.co.za${p.UrlPath || ''}`,
        'woolworths'
      );
    }).filter(Boolean);

    if (mapped.length) return mapped;
  } catch {}

  // HTML fallback
  const url = `https://www.woolworths.co.za/cat?Ntt=${encodeURIComponent(query)}`;
  try {
    const { data: html } = await http.get(url);
    const $ = cheerio.load(html);
    const results = [];
    $('[class*="product"],[class*="Product"]').each((_, el) => {
      const name  = $(el).find('[class*="name"],[class*="title"],h3').first().text().trim();
      const price = parsePrice($(el).find('[class*="price"]').first().text());
      const r = makeResult(name, price, url, 'woolworths');
      if (r) results.push(r);
    });
    return results.slice(0, 8);
  } catch (e) {
    console.error('Woolworths error:', e.message);
    return [];
  }
}

// ── SuperSPAR ─────────────────────────────────────────────────────────────────
async function scrapeSpar(query) {
  // Try Algolia API that SPAR uses internally
  try {
    const { data } = await http.post(
      'https://6jydrmhxmo-dsn.algolia.net/1/indexes/prod_spar_za_en/query',
      { query, hitsPerPage: 8, attributesToRetrieve: ['name','price','url','brand','unitSize'] },
      {
        headers: {
          ...HEADERS,
          'Content-Type': 'application/json',
          'X-Algolia-Application-Id': '6JYDRMHXMO',
          'X-Algolia-API-Key': 'YjA5MDM3OWQ3MzRmNzBjY2Q5YmQ2NTkxNTIzYWY4ZmIwMzYyNTVlNzRhNWQzMGM0Y2IwMWUxZWJiMGMzOGZpbHRlcnM9',
        }
      }
    );
    const hits = data?.hits || [];
    const mapped = hits.slice(0, 8).map(h => {
      const price = parsePrice(String(h.price || ''));
      return makeResult(h.name || h.title, price, h.url ? `https://www.spar.co.za${h.url}` : 'https://www.spar.co.za', 'spar');
    }).filter(Boolean);
    if (mapped.length) return mapped;
  } catch {}

  // HTML fallback
  const url = `https://www.spar.co.za/search?q=${encodeURIComponent(query)}`;
  try {
    const { data: html } = await http.get(url);
    const $ = cheerio.load(html);
    const results = [];
    $('[class*="product"],[class*="Product"],.product-item').each((_, el) => {
      const name  = $(el).find('[class*="name"],[class*="title"],h3,h4').first().text().trim();
      const price = parsePrice($(el).find('[class*="price"]').first().text());
      const r = makeResult(name, price, url, 'spar');
      if (r) results.push(r);
    });
    return results.slice(0, 8);
  } catch (e) {
    console.error('SPAR error:', e.message);
    return [];
  }
}

// ── Shoprite ──────────────────────────────────────────────────────────────────
async function scrapeShoprite(query) {
  const url = `https://www.shoprite.co.za/search?q=${encodeURIComponent(query)}`;
  try {
    const { data: html } = await http.get(url, {
      headers: { ...HEADERS, Referer: 'https://www.shoprite.co.za/' }
    });
    const $ = cheerio.load(html);

    // Try embedded JSON
    const raw = $('#__NEXT_DATA__').text() || $('script[type="application/json"]').first().text();
    if (raw) {
      try {
        const json = JSON.parse(raw);
        const products =
          json?.props?.pageProps?.searchResult?.products ||
          json?.props?.pageProps?.products || [];
        const mapped = products.slice(0, 8).map(p => {
          const price = parsePrice(String(p.price?.currentPrice ?? p.price ?? ''));
          return makeResult(p.name || p.title, price, `https://www.shoprite.co.za${p.url || ''}`, 'shoprite');
        }).filter(Boolean);
        if (mapped.length) return mapped;
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
    return results.slice(0, 8);
  } catch (e) {
    console.error('Shoprite error:', e.message);
    return [];
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'GroceryHunter ZA Scraper',
    time: new Date().toISOString(),
    stores: ['checkers', 'pnp', 'woolworths', 'spar', 'shoprite'],
  });
});

app.get('/search', async (req, res) => {
  const query = (req.query.q || '').trim();
  const storeFilter = req.query.store || null;

  if (!query) {
    return res.status(400).json({ error: 'Missing ?q= parameter' });
  }

  // Check cache
  const cacheKey = `${query.toLowerCase()}_${storeFilter || 'all'}`;
  const cached = cache.get(cacheKey);
  if (cached) {
    console.log(`[CACHE HIT] ${query}`);
    return res.json({ ...cached, cached: true });
  }

  console.log(`[SCRAPING] "${query}" ${storeFilter ? `(${storeFilter} only)` : '(all stores)'}`);
  const start = Date.now();

  const scrapers = {
    checkers:   scrapeCheckers,
    pnp:        scrapePnP,
    woolworths: scrapeWoolworths,
    spar:       scrapeSpar,
    shoprite:   scrapeShoprite,
  };

  // Run selected or all scrapers concurrently
  const toRun = storeFilter && scrapers[storeFilter]
    ? { [storeFilter]: scrapers[storeFilter] }
    : scrapers;

  const resultsRaw = await Promise.allSettled(
    Object.entries(toRun).map(async ([id, fn]) => ({
      id,
      products: await fn(query)
    }))
  );

  const results = {};
  Object.keys(scrapers).forEach(id => { results[id] = []; });

  resultsRaw.forEach(r => {
    if (r.status === 'fulfilled') {
      results[r.value.id] = r.value.products;
    }
  });

  const totalProducts = Object.values(results).flat().length;
  const ms = Date.now() - start;
  console.log(`[DONE] "${query}" → ${totalProducts} products in ${ms}ms`);

  const payload = { query, results, totalProducts, ms, timestamp: new Date().toISOString() };

  // Cache only if we got some results
  if (totalProducts > 0) cache.set(cacheKey, payload);

  res.json(payload);
});

// Batch search — search multiple items at once
app.post('/batch', async (req, res) => {
  const items = req.body.items || [];
  if (!items.length) return res.status(400).json({ error: 'Missing items array' });
  if (items.length > 20) return res.status(400).json({ error: 'Max 20 items per batch' });

  console.log(`[BATCH] ${items.length} items`);

  const results = await Promise.allSettled(
    items.map(async (q) => {
      const cacheKey = q.toLowerCase() + '_all';
      const cached = cache.get(cacheKey);
      if (cached) return { query: q, results: cached.results, cached: true };

      const [checkers, pnp, woolworths, spar, shoprite] = await Promise.allSettled([
        scrapeCheckers(q), scrapePnP(q), scrapeWoolworths(q), scrapeSpar(q), scrapeShoprite(q)
      ]);

      const r = {
        checkers:   checkers.status==='fulfilled'   ? checkers.value   : [],
        pnp:        pnp.status==='fulfilled'        ? pnp.value        : [],
        woolworths: woolworths.status==='fulfilled' ? woolworths.value : [],
        spar:       spar.status==='fulfilled'       ? spar.value       : [],
        shoprite:   shoprite.status==='fulfilled'   ? shoprite.value   : [],
      };
      cache.set(cacheKey, { results: r });
      return { query: q, results: r };
    })
  );

  res.json({
    items: results.map(r => r.status === 'fulfilled' ? r.value : { error: r.reason?.message }),
    timestamp: new Date().toISOString(),
  });
});

app.listen(PORT, () => {
  console.log(`\n🛒 GroceryHunter ZA Backend running on port ${PORT}`);
  console.log(`   Health: http://localhost:${PORT}/health`);
  console.log(`   Search: http://localhost:${PORT}/search?q=milk`);
  console.log(`   Batch:  POST http://localhost:${PORT}/batch`);
  console.log(`\n   Stores: Checkers · Pick n Pay · Woolworths · SuperSPAR · Shoprite\n`);
});
