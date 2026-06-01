// api/shopify.js  —  Vercel Serverless Function
// Runs on Vercel's edge, never in the browser. Credentials stay safe.

const STORE   = process.env.SHOPIFY_STORE;
const SECRET  = process.env.SHOPIFY_API_SECRET;
const API_VER = '2025-01';
const BASE    = `https://${STORE}/admin/api/${API_VER}`;
const HEADERS = { 'X-Shopify-Access-Token': SECRET, 'Content-Type': 'application/json' };

// Simple in-memory cache (lives for the function instance lifetime ~5 min)
const _cache = {};
function fromCache(key) { const e = _cache[key]; return e && Date.now() < e.exp ? e.data : null; }
function toCache(key, data, ttl = 300_000) { _cache[key] = { data, exp: Date.now() + ttl }; }

// ── Helpers ───────────────────────────────────────────────────────────────────
async function shopifyGet(path, params = {}) {
  const url = new URL(`${BASE}${path}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url.toString(), { headers: HEADERS });
  if (!res.ok) throw new Error(`Shopify ${res.status}: ${await res.text()}`);
  return res.json();
}

async function shopifyAll(path, key, params = {}) {
  let results = [], pageInfo = null;
  do {
    const p = { ...params, limit: 250 };
    if (pageInfo) p.page_info = pageInfo;
    const url = new URL(`${BASE}${path}`);
    Object.entries(p).forEach(([k, v]) => url.searchParams.set(k, v));
    const res  = await fetch(url.toString(), { headers: HEADERS });
    if (!res.ok) throw new Error(`Shopify ${res.status}`);
    const data = await res.json();
    results = results.concat(data[key] || []);
    const link = res.headers.get('Link') || '';
    const next = link.match(/<([^>]+)>;\s*rel="next"/);
    pageInfo = next ? new URL(next[1]).searchParams.get('page_info') : null;
  } while (pageInfo);
  return results;
}

function daysAgo(n) {
  const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString();
}

function extractSource(order) {
  const utm = order.utm_parameters;
  if (utm?.utm_source) {
    const s = utm.utm_source.toLowerCase();
    if (s.includes('google'))                                    return 'Google';
    if (s.includes('facebook')||s.includes('instagram')||s.includes('meta')) return 'Meta';
    if (s.includes('email')||s.includes('klaviyo'))              return 'Email';
    return utm.utm_source;
  }
  const ref = (order.referring_site || '').toLowerCase();
  if (ref.includes('google'))                          return 'Google';
  if (ref.includes('facebook')||ref.includes('instagram')) return 'Meta';
  if (ref.includes('email'))                           return 'Email';
  const sn = (order.source_name || '').toLowerCase();
  return (sn === 'web' || sn === '') ? (ref ? 'Organic' : 'Direct') : (order.source_name || 'Direct');
}

// ── Route handlers ────────────────────────────────────────────────────────────
async function handleHealth() {
  const { shop } = await shopifyGet('/shop.json');
  return { status: 'ok', store: shop.name, currency: shop.currency, plan: shop.plan_name };
}

async function handleDashboard(days = 30) {
  const cacheKey = `dashboard_${days}`;
  const cached = fromCache(cacheKey);
  if (cached) return { ...cached, _cached: true };

  const [ordersR, customersR, productsR, marketingR] = await Promise.allSettled([
    shopifyAll('/orders.json', 'orders', {
      status: 'any', created_at_min: daysAgo(days),
      fields: 'id,order_number,created_at,total_price,financial_status,customer,source_name,referring_site,utm_parameters,line_items,shipping_address',
    }),
    shopifyAll('/customers.json', 'customers', {
      created_at_min: daysAgo(days),
      fields: 'id,first_name,last_name,email,orders_count,total_spent,created_at,city',
    }),
    shopifyAll('/products.json', 'products', {
      fields: 'id,title,product_type,variants,status',
    }),
    shopifyGet('/marketing_events.json', { limit: 250 }),
  ]);

  const orders    = ordersR.status    === 'fulfilled' ? ordersR.value    : [];
  const customers = customersR.status === 'fulfilled' ? customersR.value : [];
  const products  = productsR.status  === 'fulfilled' ? productsR.value  : [];
  const mktRaw    = marketingR.status === 'fulfilled' ? (marketingR.value.marketing_events || []) : [];

  // Summary
  const totalRevenue  = orders.reduce((s, o) => s + parseFloat(o.total_price), 0);
  const avgOrderValue = orders.length ? totalRevenue / orders.length : 0;

  // Revenue by day
  const revByDay = {};
  orders.forEach(o => {
    const day = o.created_at.slice(0, 10);
    revByDay[day] = (revByDay[day] || 0) + parseFloat(o.total_price);
  });

  // Attribution
  const bySource = {};
  orders.forEach(o => {
    const src = extractSource(o);
    if (!bySource[src]) bySource[src] = { orders: 0, revenue: 0 };
    bySource[src].orders++;
    bySource[src].revenue += parseFloat(o.total_price);
  });

  // Top products
  const prodMap = {};
  orders.forEach(o => {
    (o.line_items || []).forEach(li => {
      if (!prodMap[li.title]) prodMap[li.title] = { units: 0, revenue: 0 };
      prodMap[li.title].units   += li.quantity;
      prodMap[li.title].revenue += parseFloat(li.price) * li.quantity;
    });
  });
  const topProducts = Object.entries(prodMap)
    .sort((a, b) => b[1].revenue - a[1].revenue)
    .slice(0, 10)
    .map(([name, v]) => ({ name, ...v }));

  // Marketing attribution from events
  const mktByChannel = {};
  mktRaw.forEach(e => {
    const ch = e.channel || 'other';
    if (!mktByChannel[ch]) mktByChannel[ch] = { spend: 0, impressions: 0, clicks: 0 };
    mktByChannel[ch].spend       += parseFloat(e.budget || e.paid_outcome?.ad_spend || 0);
    mktByChannel[ch].impressions += e.paid_outcome?.impressions_count || 0;
    mktByChannel[ch].clicks      += e.paid_outcome?.clicks_count      || 0;
  });

  const payload = {
    meta: { store: STORE, days, fetched_at: new Date().toISOString() },
    summary: {
      total_revenue:   Math.round(totalRevenue * 100) / 100,
      total_orders:    orders.length,
      paid_orders:     orders.filter(o => o.financial_status === 'paid').length,
      avg_order_value: Math.round(avgOrderValue * 100) / 100,
      total_customers: customers.length,
      total_products:  products.length,
    },
    revenue_by_day: Object.entries(revByDay)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, revenue]) => ({ date, revenue: Math.round(revenue * 100) / 100 })),
    attribution: Object.entries(bySource)
      .sort((a, b) => b[1].revenue - a[1].revenue)
      .map(([source, v]) => ({ source, ...v })),
    marketing_channels: Object.entries(mktByChannel)
      .map(([channel, v]) => ({ channel, ...v })),
    top_products: topProducts,
    recent_orders: orders.slice(0, 100).map(o => ({
      id:       `#${o.order_number}`,
      date:     o.created_at,
      amount:   parseFloat(o.total_price),
      status:   o.financial_status,
      customer: o.customer ? `${o.customer.first_name} ${o.customer.last_name}` : 'Guest',
      email:    o.customer?.email || '',
      city:     o.shipping_address?.city || '',
      source:   extractSource(o),
      items:    (o.line_items || []).length,
    })),
    customers: customers.slice(0, 200).map(c => ({
      id:           c.id,
      name:         `${c.first_name} ${c.last_name}`,
      email:        c.email,
      orders_count: c.orders_count,
      total_spent:  parseFloat(c.total_spent),
      city:         c.city || '',
      joined:       c.created_at,
    })),
    products: products.slice(0, 100).map(p => ({
      id:       p.id,
      name:     p.title,
      type:     p.product_type,
      status:   p.status,
      variants: (p.variants || []).map(v => ({
        sku: v.sku, price: parseFloat(v.price), inventory: v.inventory_quantity,
      })),
    })),
  };

  toCache(cacheKey, payload);
  return payload;
}

// ── Main handler ──────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  // CORS preflight
  if (req.method === 'OPTIONS') { return res.status(200).end(); }

  if (!STORE || !SECRET) {
    return res.status(500).json({ error: 'SHOPIFY_STORE or SHOPIFY_API_SECRET not set in environment variables.' });
  }

  const type = req.query.type || 'dashboard';
  const days = parseInt(req.query.days) || 30;

  try {
    let data;
    if      (type === 'health')    data = await handleHealth();
    else if (type === 'dashboard') data = await handleDashboard(days);
    else return res.status(400).json({ error: `Unknown type: ${type}. Use: health, dashboard` });

    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate');
    res.status(200).json(data);
  } catch (err) {
    console.error('[shopify]', err.message);
    res.status(500).json({ error: err.message });
  }
}
