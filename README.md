# EMI Tracker on Vercel + Supabase (same data on phone and PC)

public/index.html     the web app
api/[...path].js      Vercel Function: handles every /api/* request
lib/core.js           API logic (login, customers, payments, reports data, users, documents, AI)
supabase/schema.sql   database tables (run once)
vercel.json           output folder = public, security headers

## 1. Supabase (once)
1. supabase.com > New project (pick a region near you).
2. SQL Editor > New query > paste supabase/schema.sql > Run.
3. Project Settings > API: copy the Project URL and the service_role key (secret).

## 2. GitHub
Create a PRIVATE repository and upload everything from this zip. index.html must end up at public/index.html and the api folder must be at the top level (you will see: api, lib, public, supabase, package.json, vercel.json).

## 3. Vercel
1. vercel.com > Add New > Project > import the repository.
2. Framework Preset: Other. Leave Build Command and Output Directory empty (vercel.json sets them).
3. Environment Variables (add before Deploy):
   SUPABASE_URL           your Project URL
   SUPABASE_SERVICE_KEY   your service_role key
   SESSION_SECRET         any long random text (40+ characters)
   SETUP_KEY              a word only you know
   optional: MIN_PASSWORD=4 (allows a password like 1234), ANTHROPIC_API_KEY or GEMINI_API_KEY
4. Deploy. Open https://YOUR-PROJECT.vercel.app/api/health  -> "db": true and "sessionSecret": true

## 4. First login and moving your existing data
1. Open the site on the device that has your CORRECT data. First screen = First-time setup:
   business name, setup key, username, password > Create account.
2. Press "Upload this data" in the box "Server has no data yet". Wait 10 to 20 seconds.
3. On every other device just open the site and sign in. Same data everywhere.

## Clearing all data
The "Clear data" button (top right, Admin only) calls `POST /api/clear`, which deletes every
customer, payment, document, category and collection figure straight from the Supabase tables.
Once it reports success the data is gone on every device, not just the one you pressed it on.
If the button cannot reach the server at all, run `supabase/clear-all.sql` in the Supabase SQL Editor.

Nothing is stored in the browser any more: every figure on the screen comes from Supabase, and
every change (customers, payments, documents, categories, opening balances, company name and logo)
is written back to Supabase within a second.

## Already deployed earlier?
If you used an older version, run supabase/add-documents.sql once, then redeploy.
Changing an environment variable needs a Redeploy in Vercel.

## Login right after deploying (no setup key needed)
On a brand-new server just sign in with  admin  /  1234 . The first login creates your Admin account.
Then press the "Password" button (top right) and set a strong password. Anyone who opens the link before you
could do the same, so open your site and sign in right after deploying, and change the password at once.
Optional variables: ADMIN_USER and ADMIN_PASSWORD (use your own first login instead of admin / 1234),
DISABLE_DEFAULT_ADMIN=1 (turn this default off and use the First-time setup with SETUP_KEY instead).
