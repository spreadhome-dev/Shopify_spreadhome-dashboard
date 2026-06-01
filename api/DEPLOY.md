# Deploy to Vercel — 3 steps, ~5 minutes

## What you'll need
- A free account at vercel.com
- A free account at github.com
- Node.js installed (just to run `npm i -g vercel` once)

---

## Step 1 — Put the files on GitHub

1. Go to github.com → New repository → name it `spreadhome-dashboard` → Create
2. Upload these 3 files:
   - `index.html`
   - `api/shopify.js`   ← must be inside an `api/` folder
   - `vercel.json`

---

## Step 2 — Connect to Vercel

1. Go to vercel.com → Add New Project → Import from GitHub
2. Select `spreadhome-dashboard`
3. Click **Deploy** (leave all settings default)

Your site will be live at `https://spreadhome-dashboard.vercel.app` — but it will show an error until you add the env vars below.

---

## Step 3 — Add your Shopify credentials

In Vercel → your project → **Settings → Environment Variables**, add:

| Name | Value |
|---|---|
| `SHOPIFY_STORE` | `spreadhome.myshopify.com` |
| `SHOPIFY_API_SECRET` | `your_api_secret_from_bi_app` |

Then go to **Deployments → Redeploy** (one click).

That's it — your dashboard is live at your Vercel URL. 🎉

---

## How it works (no server to maintain)

```
Browser  ──→  /api/shopify?type=dashboard  ──→  Vercel Edge Function  ──→  Shopify Admin API
         ←──  JSON data                    ←──  (runs for ~2s, then dies)  ←──  Your store data
```

- The edge function spins up, fetches Shopify, returns data, then disappears
- Vercel caches the response for 5 minutes (`s-maxage=300`)
- Your API secret is **never** in the HTML — only in Vercel's encrypted env vars
- Free tier: 100GB bandwidth + 100,000 function invocations/month (more than enough)

---

## Custom domain (optional)

Vercel → your project → Settings → Domains → Add `dashboard.spreadhome.com`
Then add a CNAME record in your DNS: `dashboard` → `cname.vercel-dns.com`

---

## Updates

Any time you push to GitHub, Vercel redeploys automatically in ~30 seconds.
