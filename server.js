
/**
 * GroceryHunter ZA — Backend v5
 * Uses Serper.dev Google Shopping API (2,500 free queries)
 * to get REAL prices from SA stores via Google Shopping
 *
 * Setup:
 *  1. Sign up free at serper.dev → get API key
 *  2. Set SERPER_API_KEY in Render environment variables
 *  3. Optional: SUPABASE_URL + SUPABASE_ANON_KEY for community prices
 *
 * Endpoints:
 *   GET  /health
 *   GET  /prices?q=milk+2l&city=Durban
 *   POST /batch    { items:[], city:'' }
 *   POST /submit   { product_name, store_id, price, city, user_id }
 *   POST /ai-prices { items:[], apiKey:'' }
 *   GET  /stats
 */

const express   = require('express');
const axios     = require('axios');
const cors      = require('cors');
const NodeCache = require('node-cache');

const app   = express();
const cache = new NodeCache({ stdTTL: 3600 }); // 1 hour cache
const PORT  = process.env.PORT || 3000;

app.use(cors({ origin: '*' }));
app.use(express.json());

// ── Environment variables (set in Render dashboard) ───────────────────────────
const SERPER_KEY = process.env.SERPER_API_KEY || 'e79f18b7e72aa89f5f50a31a998d83e536b36ec0';
const SUPABASE_URL = process.env.SUPABASE_URL    || '';
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY || '';

const VALID_STORES = ['checkers','pnp','woolworths','spar','shoprite'];

// ── Store keyword matching ─────────────────────────────────────────────────────
const STORE_KEYWORDS = {
  checkers:   ['checkers','sixty60'],
  pnp:        ['pick n pay','pnp','picknpay'],
  woolworths: ['woolworths','woolies'],
  spar:       ['spar','superspar'],
  shoprite:   ['shoprite'],
};

function matchStore(source) {
  if (!source) return null;
  const low = source.toLowerCase();
  for (const [id, words] of Object.entries(STORE_KEYWORDS)) {
    if (words.some(w => low.includes(w))) return id;
  }
  return null;
}

function parsePrice(str) {
  if (!str) return null;
  const n = parseFloat(String(str).replace(/[^\d.]/g,''));
  return isNaN(n) || n < 2 || n > 5000 ? null : Math.round(n * 100) / 100;
}

function emptyResults() {
  const e = {}; VALID_STORES.forEach(s => { e[s] = []; }); return e;
}

// ── Supabase helper ───────────────────────────────────────────────────────────
async function sb(method, path, body, params) {
  const res = await axios({
    method,
    url: `${SUPABASE_URL}/rest/v1${path}${params?'?'+params:''}`,
    data: body,
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': method==='POST' ? 'return=representation' : undefined,
    },
    timeout: 10000,
  });
  return res.data;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  SERPER GOOGLE SHOPPING SCRAPER
//  Uses Serper.dev API which handles all anti-bot bypassing for Google
// ═══════════════════════════════════════════════════════════════════════════════
async function searchGoogleShopping(query) {
  if (!SERPER_KEY) {
    console.log('No SERPER_API_KEY set — skipping Google Shopping');
    return null;
  }

  try {
    console.log(`[SERPER] Shopping search: "${query}"`);

    const { data } = await axios.post(
      'https://google.serper.dev/shopping',
      {
        q: `${query} South Africa`,
        gl: 'za',       // Country: South Africa
        hl: 'en',       // Language: English
        num: 20,        // Get up to 20 results
        autocorrect: true,
      },
      {
        headers: {
          'X-API-KEY': SERPER_KEY,
          'Content-Type': 'application/json',
        },
        timeout: 15000,
      }
    );

    const shoppingResults = data?.shopping || [];
    console.log(`[SERPER] Got ${shoppingResults.length} results for "${query}"`);

    const results = emptyResults();
    let matched = 0;

    shoppingResults.forEach(item => {
      // Each item has: title, price, source, link, imageUrl, rating
      const storeId = matchStore(item.source);
      if (!storeId) return;

      const price = parsePrice(item.price);
      if (!price) return;

      // Only add if we don't have this store yet (first result = best/most relevant)
      if (results[storeId].length === 0) {
        results[storeId].push({
          name: (item.title || query).slice(0, 80),
          price,
          source: 'google_shopping',
          link: item.link || '',
          image: item.imageUrl || '',
          rating: item.rating || null,
        });
        matched++;
        console.log(`  ✅ ${storeId}: R${price} — ${item.title?.slice(0,40)}`);
      }
    });

    // Log unmatched sources to help debug
    const unmatched = shoppingResults
      .filter(i => !matchStore(i.source))
      .map(i => i.source)
      .filter((v,i,a) => a.indexOf(v)===i)
      .slice(0, 5);
    if (unmatched.length) console.log(`  Unmatched sources: ${unmatched.join(', ')}`);

    return matched > 0 ? results : null;

  } catch (e) {
    console.error('[SERPER] Error:', e.response?.status, e.message);
    return null;
  }
}

// ── SPAR Algolia fallback (always free, always works) ─────────────────────────
async function getSparFallback(query) {
  try {
    const { data } = await axios.post(
      'https://6jydrmhxmo-dsn.algolia.net/1/indexes/prod_spar_za_en/query',
      { query, hitsPerPage: 1, attributesToRetrieve: ['name','price'] },
      {
        headers: {
          'Content-Type': 'application/json',
          'X-Algolia-Application-Id': '6JYDRMHXMO',
          'X-Algolia-API-Key': 'YjA5MDM3OWQ3MzRmNzBjY2Q5YmQ2NTkxNTIzYWY4ZmIwMzYyNTVlNzRhNWQzMGM0Y2IwMWUxZWJiMGMzOGZpbHRlcnM9',
        },
        timeout: 8000,
      }
    );
    const hit = data?.hits?.[0];
    if (!hit?.price || parseFloat(hit.price) < 2) return null;

    const sp = parseFloat(hit.price);
    const nm = hit.name || query;
    const r  = n => Math.round(n * 100) / 100;
    console.log(`[SPAR ALGOLIA] "${query}": R${sp}`);

    return {
      checkers:   [{ name:nm, price:r(sp*0.97), source:'spar_estimated' }],
      pnp:        [{ name:nm, price:r(sp*0.98), source:'spar_estimated' }],
      woolworths: [{ name:nm, price:r(sp*1.22), source:'spar_estimated' }],
      spar:       [{ name:nm, price:sp,          source:'spar_api'       }],
      shoprite:   [{ name:nm, price:r(sp*0.88), source:'spar_estimated' }],
    };
  } catch { return null; }
}

// ── Community prices from Supabase ────────────────────────────────────────────
async function getCommunityPrices(productName, city) {
  if (!SUPABASE_URL) return null;
  try {
    const ago = new Date(Date.now()-30*24*60*60*1000).toISOString();
    const cityQ = city ? `&city=ilike.*${encodeURIComponent(city)}*` : '';
    const data = await sb('GET', '/price_submissions', null,
      `product_name=ilike.*${encodeURIComponent(productName)}*` +
      `&created_at=gte.${ago}${cityQ}` +
      `&select=store_id,price,product_name,created_at` +
      `&order=created_at.desc&limit=50`
    );
    if (!data?.length) return null;

    const byStore = {};
    data.forEach(row => {
      if (!byStore[row.store_id] ||
          new Date(row.created_at) > new Date(byStore[row.store_id].created_at)) {
        byStore[row.store_id] = row;
      }
    });

    const results = emptyResults();
    let found = 0;
    VALID_STORES.forEach(store => {
      const row = byStore[store];
      if (row) { results[store]=[{name:row.product_name,price:parseFloat(row.price),source:'community'}]; found++; }
    });
    console.log(`[COMMUNITY] "${productName}": ${found} stores`);
    return found > 0 ? results : null;
  } catch (e) { console.error('Supabase error:', e.message); return null; }
}

// ── Get prices (priority: Community → Google Shopping → SPAR estimate) ────────
async function getPrices(query, city) {
  // 1. Check community DB first (most accurate — real submitted prices)
  const community = await getCommunityPrices(query, city);
  if (community) return { results: community, source: 'community' };

  // 2. Google Shopping via Serper (real Google data)
  const google = await searchGoogleShopping(query);
  if (google) return { results: google, source: 'google_shopping' };

  // 3. SPAR Algolia + estimates (free fallback)
  const spar = await getSparFallback(query);
  if (spar) return { results: spar, source: 'spar_estimated' };

  // 4. Nothing found
  return { results: emptyResults(), source: 'none' };
}

// ═══════════════════════════════════════════════════════════════════════════════
//  ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

app.get('/health', (req, res) => res.json({
  status: 'ok',
  service: 'GroceryHunter ZA v5 — Google Shopping',
  serper:   !!SERPER_KEY,
  supabase: !!SUPABASE_URL,
  time: new Date().toISOString(),
}));

// Single product prices
app.get('/prices', async (req, res) => {
  const query = (req.query.q || '').trim();
  const city  = (req.query.city || '').trim();
  if (!query) return res.status(400).json({ error: 'Missing ?q=' });

  const cacheKey = `${query.toLowerCase()}_${city.toLowerCase()}`;
  const cached = cache.get(cacheKey);
  if (cached) return res.json({ ...cached, cached: true });

  const { results, source } = await getPrices(query, city);
  const total = Object.values(results).flat().length;
  const payload = { query, results, source, total, timestamp: new Date().toISOString() };
  if (total > 0) cache.set(cacheKey, payload);
  res.json(payload);
});

// Batch prices — all basket items in one request
app.post('/batch', async (req, res) => {
  const items = (req.body.items || []).slice(0, 20);
  const city  = req.body.city || '';
  if (!items.length) return res.status(400).json({ error: 'Missing items[]' });

  console.log(`[BATCH] ${items.length} items, city="${city}"`);

  // Process items with small delay to avoid hitting Serper rate limit
  const batchResults = [];
  for (const q of items) {
    const cacheKey = `${q.toLowerCase()}_${city.toLowerCase()}`;
    const cached = cache.get(cacheKey);
    if (cached) {
      batchResults.push({ query:q, results:cached.results, source:'cache' });
    } else {
      const { results, source } = await getPrices(q, city);
      const payload = { results, source };
      if (Object.values(results).flat().length > 0) cache.set(cacheKey, payload);
      batchResults.push({ query:q, results, source });
      // Small delay between Serper requests to be respectful
      if (items.indexOf(q) < items.length - 1) await new Promise(r=>setTimeout(r,300));
    }
  }

  res.json({ items: batchResults, city, timestamp: new Date().toISOString() });
});

// Submit community price
app.post('/submit', async (req, res) => {
  const { product_name, store_id, price, city, province, lat, lng, user_id } = req.body;
  if (!product_name?.trim())            return res.status(400).json({ error: 'Missing product_name' });
  if (!VALID_STORES.includes(store_id)) return res.status(400).json({ error: `Invalid store. Use: ${VALID_STORES.join(', ')}` });
  const p = parseFloat(price);
  if (isNaN(p) || p < 2 || p > 5000)   return res.status(400).json({ error: 'Invalid price (R2–R5000)' });

  const row = {
    product_name: product_name.trim().slice(0,100), store_id,
    price: Math.round(p*100)/100,
    city:city?.trim()||null, province:province?.trim()||null,
    lat:lat||null, lng:lng||null,
    user_id:(user_id||'anonymous').slice(0,50),
  };
  console.log(`[SUBMIT] ${row.product_name} @ ${row.store_id} R${row.price} (${row.city||'?'})`);

  if (!SUPABASE_URL) return res.json({ success:true, message:'Received (DB not configured)', row });

  try {
    const saved = await sb('POST', '/price_submissions', row);
    // Bust cache
    cache.keys().forEach(k=>{if(k.includes(row.product_name.toLowerCase().slice(0,8)))cache.del(k);});
    res.json({ success:true, message:'Thank you! Price saved 🙏', id:saved?.[0]?.id });
  } catch(e) {
    res.status(500).json({ error:'Could not save: '+e.message });
  }
});

// AI prices via Claude (server-side — no CORS)
const AI_PROMPT = `You are a South African grocery price expert for March 2026.
Return ONLY a JSON array — no markdown, no explanation.
Format: [{"item":"Full Cream Milk 2L","checkers":24.99,"pnp":25.49,"woolworths":31.99,"spar":25.99,"shoprite":22.99}]
Use realistic March 2026 ZAR prices with ~6% inflation since 2025.
Shoprite 10-15% cheaper. Woolworths 20-30% pricier. PnP within 5% of Checkers.`;

app.post('/ai-prices', async (req, res) => {
  const { items, apiKey } = req.body;
  if (!items?.length) return res.status(400).json({ error:'Missing items[]' });
  if (!apiKey)        return res.status(400).json({ error:'Missing apiKey' });

  const cacheKey = 'ai_'+items.map(i=>i.toLowerCase()).sort().join('|');
  const cached = cache.get(cacheKey);
  if (cached) return res.json({ ...cached, cached:true });

  try {
    const response = await axios.post('https://api.anthropic.com/v1/messages', {
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1500,
      system: AI_PROMPT,
      messages:[{ role:'user', content:`March 2026 ZAR prices:\n${items.map((i,n)=>`${n+1}. ${i}`).join('\n')}` }],
    }, {
      headers:{ 'Content-Type':'application/json','x-api-key':apiKey,'anthropic-version':'2023-06-01' },
      timeout:30000,
    });

    const text = response.data?.content?.map(c=>c.text||'').join('')||'[]';
    const data = JSON.parse(text.replace(/```json|```/g,'').trim());
    const results = {};
    data.forEach(row => {
      const sr = {};
      VALID_STORES.forEach(s => {
        const p = row[s];
        sr[s] = (p!=null && parseFloat(p)>=2) ? [{name:row.item,price:parseFloat(p),source:'ai'}] : [];
      });
      results[row.item.toLowerCase()] = sr;
    });
    const payload = { results, source:'ai', timestamp:new Date().toISOString() };
    cache.set(cacheKey, payload);
    res.json(payload);
  } catch(e) {
    const s = e.response?.status;
    if (s===401) return res.status(401).json({ error:'Invalid API key' });
    if (s===429) return res.status(429).json({ error:'Rate limited — try again' });
    res.status(500).json({ error:e.message });
  }
});

// Stats
app.get('/stats', async (req, res) => {
  const stats = { cache_keys: cache.keys().length, serper: !!SERPER_KEY, supabase: !!SUPABASE_URL };
  if (SUPABASE_URL) {
    try {
      const data = await sb('GET','/price_submissions',null,'select=product_name,city&limit=5000');
      stats.submissions = data.length;
      stats.products = new Set(data.map(r=>r.product_name)).size;
      stats.cities   = new Set(data.filter(r=>r.city).map(r=>r.city)).size;
    } catch {}
  }
  res.json(stats);
});

app.listen(PORT, () => {
  console.log(`\n🛒 GroceryHunter ZA v5 — Google Shopping via Serper`);
  console.log(`   Port:    ${PORT}`);
  console.log(`   Serper:  ${SERPER_KEY ? '✅ Ready' : '⚠️  Set SERPER_API_KEY env var'}`);
  console.log(`   Supabase:${SUPABASE_URL ? ' ✅ Ready' : ' ⚠️  Optional — set SUPABASE_URL + SUPABASE_ANON_KEY'}`);
  console.log(`\n   GET  /prices?q=eggs+12pk&city=Durban`);
  console.log(`   POST /batch   { items:[], city:'' }`);
  console.log(`   POST /submit  { product_name, store_id, price, city }`);
  console.log(`   POST /ai-prices { items:[], apiKey:'' }\n`);
});


