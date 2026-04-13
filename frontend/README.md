# adsGenerator Frontend

Next.js (App Router) UI for the multi-company jewellery video demo.

## Requirements

- Node.js 20+
- A Supabase project with the migrations applied
- Supabase Realtime enabled for `public.video_runs`

## Environment Variables

Create `frontend/.env.local` with:

- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`

An example template is provided in `frontend/.env.example`.

## Run Locally

From `frontend/`:

```bash
npm install
npm run dev
```

Open `http://localhost:3000`.

## Routes

- `/`: landing page (paste a product URL; routes to the correct demo)
- `/demo/<companySlug>`: company demo page

## How Company Routing Works

- The landing page detects which company a URL belongs to by hostname mapping in `frontend/src/lib/company.ts`.
- The backend still enforces the allowlist and will reject unsupported URLs even if the frontend routes them.

