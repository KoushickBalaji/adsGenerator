Multi-Company Demo Mode Spec (adsGenerator)

Goal



Enable one shared UI to demo multiple companies safely and cleanly, without duplicating pages, while keeping the codebase maintainable and avoiding “if company === …” sprawl.



Definition of done



A single deployed frontend supports URLs like:

/demo/bluestone?key=...

/demo/companyX?key=...

companySlug is the human-readable company name (used in the URL).

The UI defaults to company-filtered history/settings based on the current companySlug. This is a shared GTM demo sandbox and is not intended to be a privacy boundary.

Backend enforces company constraints (hosts, scraper, ambassador, prompt style) regardless of frontend behavior.

Costs are protected via a lightweight demo gate (no auth system) plus per-company spend limits:

- demo key gate (mandatory)
- per-company lifetime credits (mandatory): 10 successful videos per company (success = mp4 created and URL recorded on the run)
- per-company concurrency cap (recommended)
- basic attempt throttles (recommended; protects against repeated failures / link sharing)

Demo links do not expire (no time-based expiry).

Non-goals

No “onboarding” flow, no user accounts.

No multi-tenant production design (billing, orgs, permissions).

No strict tenant isolation via auth/RLS. This is a shared sandbox intended for GTM links.

No generalized “paste any ecommerce URL” promise. Each demo is a controlled mode.

No per-video persona selection UI (personas/models are picked randomly from a curated pool per company config).

Current architecture summary (baseline)



Frontend:



Next.js app in frontend/

Calls edge functions create-run + refresh-run

Subscribes to Realtime updates for active run row



Backend:



Supabase Edge Functions:

create-run: orchestrates scrape → Gemini prompt → Kling job

kling-webhook: writes completion status + uploads mp4 to storage

refresh-run: polling fallback



Shared modules:



supabase/functions/\_shared/scraper.ts: strongly BlueStone-shaped scraping + generic fallback

supabase/functions/\_shared/kling.ts: hardcoded BRAND\_ELEMENT\_NAME\_PREFIX = "bluestone"

supabase/functions/\_shared/geminiPrompt.ts: jewellery + ambassador + businesswoman prompt template

Design approach

Key design choice: “Company Config” registry



Introduce a single company config registry used by backend (and optionally frontend) to define:



allowed hostnames

scraping adapter behavior

Kling defaults \& model candidates

whether ambassador/model element is required and which persona pool to use (element name prefixes)

prompt template / policy knobs

demo key gating

spend limits (lifetime credits, concurrency, attempt throttles)



Why this design



Centralizes all company-specific moving parts.

Avoids duplicating pages and avoids scattered conditionals.

Makes adding a new company a data entry + a small adapter, not a refactor.

Data model changes

1\) Add company\_slug column to video\_runs



Table: public.video\_runs



Add:



company\_slug text not null default 'bluestone'

index on (company\_slug, created\_at desc) for history

optional index on (company\_slug, status) for active count queries



Why



Prevents cross-company history pollution.

Enables per-company concurrency / throttling.

Enables cleanup and reporting per demo.



Migration tasks



Create migration SQL (Supabase migration file)

Backfill existing rows:

set company\_slug = 'bluestone' where null

Backend changes (Supabase Edge Functions)

2\) Add shared config module



New file: supabase/functions/\_shared/companyConfig.ts



Exports

type CompanyConfig

function getCompanyConfig(companySlug: string): CompanyConfig

function assertDemoKey(req: Request, config: CompanyConfig): void

function assertUrlAllowed(url: string, config: CompanyConfig): void

Suggested CompanyConfig shape

export type CompanyConfig = {

&#x20; slug: string;



&#x20; // Security / gating

&#x20; demoKey?: string; // if set, request must include correct key



&#x20; // Which product URLs are allowed in this demo mode

&#x20; allowedHosts: string\[];



&#x20; // Scraper strategy

&#x20; scraper: {

&#x20;   adapter: "bluestone" | "generic" | "shopify";

&#x20;   maxReferenceImages: number; // default 12

&#x20; };



&#x20; // Kling video settings

&#x20; kling: {

&#x20;   modelCandidates: string\[]; // e.g. \["kling-v3-omni","kling-v3"]

&#x20;   defaults: {

&#x20;     duration: string;     // e.g. "10"

&#x20;     aspectRatio: string;  // e.g. "1:1"

&#x20;     mode: "std" | "pro";

&#x20;   };



&#x20;   ambassador: {

&#x20;     enabled: boolean;

&#x20;     elementPrefixCandidates?: string\[]; // if enabled, required; random pick per run (brand ambassador OR curated generic persona pool)

&#x20;   };

&#x20; };



&#x20; // Prompt policy

&#x20; prompt: {

&#x20;   requiresAmbassador: boolean;

&#x20;   style: "jewellery\_businesswoman\_v1" | "product\_only\_v1";

&#x20;   // Future: per-company tone strings; for now keep style enums

&#x20; };



&#x20; // Spend / abuse limits

&#x20; limits: {

&#x20;   maxConcurrentRuns: number; // per company

&#x20;   maxLifetimeSuccessfulVideos: number; // per company; success = mp4 created and URL recorded on the run

&#x20;   maxAttemptsPerDay?: number; // optional; protects against repeated failures / link sharing

&#x20; };

};

Config registry content (initial)

bluestone:

allowedHosts: \["bluestone.com"]

scraper.adapter: "bluestone"

ambassador.enabled: true, elementPrefixCandidates \["bluestone"\] (replace hardcoded constant)

prompt.requiresAmbassador: true, style "jewellery\_businesswoman\_v1"

kling defaults: duration 10, aspect 1:1, mode pro

limits.maxConcurrentRuns: 3

limits.maxLifetimeSuccessfulVideos: 10

limits.maxAttemptsPerDay: 30 (optional)

generic-model (optional baseline demo for companies without brand ambassadors):

allowedHosts: \[] (disallow unless explicitly used)

scraper.adapter: "generic"

ambassador.enabled: true, elementPrefixCandidates \["generic-female-v1","generic-male-v1","generic-unisex-v1"\] (curated pool)

prompt.requiresAmbassador: true, style "jewellery\_businesswoman\_v1"

limits.maxConcurrentRuns: 1

limits.maxLifetimeSuccessfulVideos: 10

limits.maxAttemptsPerDay: 30 (optional)

product-only (optional baseline demo for companies that prefer no human likeness):

allowedHosts: \[] (disallow unless explicitly used)

scraper.adapter: "generic"

ambassador.enabled: false

prompt.requiresAmbassador: false, style "product\_only\_v1"

limits.maxConcurrentRuns: 1

limits.maxLifetimeSuccessfulVideos: 10

limits.maxAttemptsPerDay: 30 (optional)



Why



Back end becomes the source of truth.

Adding a new company becomes: add config entry + implement adapter if needed.

3\) Update create-run to be company-aware + gated



File: supabase/functions/create-run/index.ts



Change request body



Current: { url, runId }

New: { url, runId, companySlug, demoKey } (demoKey optional if passed via header)



Note: Prefer x-demo-key header over query param for cleaner URLs, but query param is acceptable for demos. Either way, implement both to reduce friction.



Processing changes

Parse request and load config:

const { url, runId, companySlug } = await req.json()

const config = getCompanyConfig(companySlug ?? "bluestone")

Gate early:

Validate demo key before any costly work (scrape/Gemini/Kling).

assertDemoKey(req, config)

Validate URL host against config:

assertUrlAllowed(url, config)

Remove hardcoded bluestone.com check.

Enforce per-company lifetime credits before any costly work:

- success = mp4 created and URL recorded on the run (e.g. status = 'completed' and video url column is non-null)
- if successes >= config.limits.maxLifetimeSuccessfulVideos → return a friendly “out of credits” response (“You have run out of demo credits. Reach out to the developer.”)

Optional attempt throttle (recommended):

- if config.limits.maxAttemptsPerDay is set, count runs created in last 24h for config.slug (any status)
- if attempts >= maxAttemptsPerDay → return 429 with a friendly “rate limited / reach out to developer” response

Concurrency guard must be per company:

Instead of counting active runs globally, count where:

company\_slug = config.slug

status in ('queued','processing')

Use config.limits.maxConcurrentRuns

Insert video\_runs row with company\_slug:

include company\_slug: config.slug

preserve existing “insert early” behavior for fast UI response

Scrape using adapter:

Update scrapeProduct(url) to accept adapter selection, or route:

if config.scraper.adapter === "bluestone" use existing BlueStone path

else call generic html fallback (JSON-LD/OG)

Limit images to config.scraper.maxReferenceImages

Ambassador selection should be config-driven:

if config.kling.ambassador.enabled:

pick a random namePrefix from config.kling.ambassador.elementPrefixCandidates and call getRandomElement({ namePrefix })

else:

skip element logic entirely

Prompt generation must accept policy:

call generateKlingPromptWithGemini(product, product.input\_images.length, { requiresAmbassador: config.prompt.requiresAmbassador, style: config.prompt.style })

details below in geminiPrompt section

Call Kling using config defaults:

use config.kling.modelCandidates

use config.kling.defaults for duration/aspect/mode

include element\_list only when ambassador enabled

Persist company\_slug always, plus prompt, images, provider\_job\_id

Update error mapping



Your toFriendlyError currently references BRAND\_ELEMENT\_NAME\_PREFIX and “Only BlueStone URLs”. Update messages to be company-aware:



“This tool works exclusively with {companyName} product URLs.”

“No eligible model persona configured for {companySlug} … prefixes: …”

When demo key missing: “Invalid or missing demo key.”



Why



create-run is the single point where cost can explode. It must enforce correctness and safety.

4\) Update \_shared/kling.ts to remove hardcoded prefix



File: supabase/functions/\_shared/kling.ts



Required changes

Remove or deprecate:

export const BRAND\_ELEMENT\_NAME\_PREFIX = "bluestone";

Update isElementNameEligible default:

currently defaults to BRAND\_ELEMENT\_NAME\_PREFIX

change signature to require explicit prefix or default to empty (and return false)

safest: isElementNameEligible(name, prefix) with no default

getRandomElement already accepts namePrefix; keep that, but ensure:

if elementPrefixCandidates is missing/empty and ambassador enabled, error early at config validation time



Why



This is a hidden company-specific dependency today.

Config should define the persona pool (prefix candidates), not the library.

5\) Refactor \_shared/geminiPrompt.ts to support policies



File: supabase/functions/\_shared/geminiPrompt.ts



Current behavior (problem)

Always assumes jewellery category logic.

Always requires <<<element\_1>>>.

Prompt is deeply shaped around “businesswoman / boardroom” and “no extra jewellery”.

Proposed refactor (minimal viable)



Add an options parameter:



export type PromptPolicy = {

&#x20; requiresAmbassador: boolean;

&#x20; style: "jewellery\_businesswoman\_v1" | "product\_only\_v1";

};



export async function generateKlingPromptWithGemini(

&#x20; product: ProductForPrompt,

&#x20; imageCount: number,

&#x20; policy: PromptPolicy

): Promise<{ prompt: string; request: GeminiKlingPromptRequest; usageMetadata?: unknown }>

Branching behavior

If policy.requiresAmbassador === false:

Remove all system prompt lines that introduce <<<element\_1>>>

Do not include ambassador rules

Do not validate presence of <<<element\_1>>> at the end

Modify examples to be product-only two-shot storyboard (studio product shots)

If policy.style === "product\_only\_v1":

Replace “modern successful woman” narrative with:

“premium studio product film”

slow camera orbit, controlled lighting, shallow DOF

Keep the two-shot JSON structure (so you don’t change Kling call shape)

Keep “avoid text/logos” rules

Keep image-token constraints (still valuable):

ensure <<<image\_1>>>.. are used

enforce no image tokens in Shot 2 (optional, but keep consistent for now)



Why



You need a non-ambassador mode for companies that don’t want or can’t accept human likenesses.

For companies without brand ambassadors, use a curated generic model persona pool (via elementPrefixCandidates) rather than turning ambassador mode off.

This is also the fastest way to generalize beyond the “ambassador” demo.

What not to do in this sprint

Don’t build a full templating engine.

Don’t implement category specs beyond jewellery.

Keep a small number of prompt “styles” as enums.

6\) Update webhook and refresh functions (sanity, not strictly required)

kling-webhook



File: supabase/functions/kling-webhook/index.ts



Add optional sanity update:



Fetch company\_slug too (when locating run)

No behavior change required, but log company for debugging:

select id, company\_slug from video\_runs where provider\_job\_id = ...



Why



When debugging multiple demos, logs without company are painful.

refresh-run



File: supabase/functions/refresh-run/index.ts



No fundamental changes, but:



Ensure it does not accidentally update a run from the wrong company context.

If you add gating, you may enforce demo key here too only if frontend calls it publicly.

Otherwise a malicious user can poll your jobs and cause storage uploads.



Recommendation: require demo key for refresh-run too (same assertDemoKey path).



It’s low friction and closes a cost/abuse hole.

Frontend changes (Next.js)

7\) Routing: company mode via route or query



Pick one:



Option A: Route-based (recommended)

frontend/src/app/demo/\[company]/page.tsx

Move existing page logic into this route.

Extract company from params.

Keeps URLs cleaner and easier to bookmark.

Option B: Query param

Keep page.tsx and parse company from searchParams.



Why route-based is better



Less error-prone for demos.

Easy to display company name/logo based on slug.

8\) History filtering by company



File: currently frontend/src/app/page.tsx loads:



.from("video\_runs").select("\*").order("created\_at"...).limit(20)



Change to:



.eq("company\_slug", companySlug)

Also include company\_slug in VideoRun type so UI has it.



Why



Prevents cross-demo contamination and accidental embarrassing history.

9\) Pass companySlug and demoKey to edge functions

create-run



Call:



supabase.functions.invoke("create-run", { body: { url, runId, companySlug, demoKey } })

or pass demoKey via header if supabase client allows (often not directly; body is easiest for demos).

refresh-run



Call:



supabase.functions.invoke("refresh-run", { body: { runId, companySlug, demoKey } })

Even if backend doesn’t need companySlug, include it for future-proofing.



Why



Backend must enforce company mode; frontend must supply the intent.

10\) UI branding + guardrails (minimal)

Show a small label/badge: Demo: {companySlug}

Optional: show a small credits indicator (e.g. 3/10 used) so users understand the demo limit.

Pre-fill example URL placeholder per company

If company is unknown, show a simple “invalid demo link” message

If backend returns “out of credits”, show the message prominently and stop further attempts.



Why



Makes demo feel intentional, not hacked together.

Reduces user error during live calls.

Storage changes

11\) Bucket path segregation (recommended)



Current uploads use:



${runId}.mp4 to generated-videos bucket



Change to:



${company\_slug}/${runId}.mp4



Update both:



kling-webhook

refresh-run



Why



Easy cleanup by company

Avoid collisions and confusion

Security / cost protection

12\) Demo key gate (mandatory)



Without this, your public demo endpoint is an API anyone can spam, and they will spend your Kling + Gemini credits.



Implementation

Each company config may have demoKey

assertDemoKey(req, config) checks:

x-demo-key header OR JSON body demoKey

matches config.demoKey

If missing/wrong: return 401/403



Apply gating to:



create-run (mandatory)

refresh-run (recommended)

kling-webhook already has optional WEBHOOK\_SECRET – keep it



Why



Minimal friction

Strong protection

No auth system required

12b\) Lifetime credits cap (mandatory)

This demo will be shared via emailed links, so enforce a per-company lifetime credits cap to prevent runaway spend and to create a clear “reach out to the developer” CTA.

Definition of success (for credit counting)

- Success = mp4 created and the mp4 URL is recorded on the run row.

High-level implementation

- Add config: limits.maxLifetimeSuccessfulVideos = 10 (per company)
- In create-run, before any costly work, count successful runs for config.slug and reject if the limit is reached.
- Make completion handling idempotent so webhook retries don’t double-count “success”.

UX

- When out of credits, return a friendly message: “You have run out of demo credits. Reach out to the developer.”
- Optional: show a small “credits used” indicator in the UI (e.g. 3/10 used).

12c\) Attempt throttles (recommended)

Even if only “successful” runs count against credits, repeated failed attempts can still burn time/money. Add a simple per-company throttle:

- If limits.maxAttemptsPerDay is set, count runs created in the last 24h for config.slug (any status) and return 429 when exceeded.

Scraper generalization (this sprint vs next)

13\) Adapter routing (minimal in this sprint)



Right now scraper.ts is BlueStone-first, then generic fallback.



Introduce a thin router:



New file (optional): supabase/functions/\_shared/scrapeRouter.ts



scrapeProductWithAdapter(url, adapter, opts)



Implementation:



if adapter === "bluestone" call existing scrapeProduct(url)

if adapter === "generic" call scrapeProduct(url) but force API path off and rely on scrapeFromHtml + OG/JSON-LD

easiest: add an option to scrapeProduct(url, { disableApi: true })

or expose scrapeFromHtml as a separate export



Why



You can add companies quickly with generic support first.

Then build dedicated adapters for high-value targets later.

Work breakdown (Sprint plan)

Phase 1 — Data + config + backend enforcement

DB migration: add company\_slug, indexes, backfill

Add companyConfig.ts with bluestone config

Update create-run:

accept companySlug

demo key gate

host allowlist

per-company concurrency count

enforce per-company lifetime credits cap (maxLifetimeSuccessfulVideos = 10 successes)

write company\_slug to DB

pick model persona prefix from elementPrefixCandidates (random)

pass prompt policy to Gemini generator

Update kling.ts: remove hardcoded prefix default

Update geminiPrompt.ts: add PromptPolicy, support requiresAmbassador=false (minimal)

Phase 2 — Frontend routing + history filtering

Add /demo/\[company] route (or query param approach)

Filter history by company\_slug

Pass companySlug + demoKey into functions

Add demo badge + placeholder URL per company

Phase 3 — Optional but recommended hardening

Gate refresh-run using same demo key

Storage path: ${company\_slug}/${runId}.mp4

Add basic “unknown company” handling in UI

Add maxAttemptsPerDay throttling in create-run (prevents repeated failures / link sharing from burning cost)

Testing plan

Functional tests

/demo/bluestone can generate video

history shows only bluestone runs

changing to /demo/other shows empty history (unless runs exist)

wrong demo key blocks create-run and refresh-run

after 10 successful videos for a company, create-run is blocked with a clear “out of credits” message

failed runs do not count towards the 10-video lifetime cap (success = mp4 created + URL recorded)

Abuse tests

call create-run without demo key → rejected quickly

call refresh-run without demo key → rejected (if implemented)

try URL not in allowedHosts for company → rejected

if maxAttemptsPerDay is set, exceeding it returns 429 (recommended)

Regression tests

existing BlueStone flow produces same output quality and uses ambassador element

Risks \& mitigations

Prompt refactor breaks output format → keep existing 2-shot JSON structure; change only ambassador requirement branch.

Kling element selection fails for new company → config requires elementPrefixCandidates when ambassador/model is enabled; otherwise product-only mode.

Credits cap exceeded due to concurrency/races → keep maxConcurrentRuns low for external demos (often 1) or reserve credits atomically.

Prospect confusion about shared sandbox/history → make it clear in the email pitch; optionally add a small in-app disclaimer label.

Scraper fails for other sites → for multi-company demos, expect to pre-build adapters. Generic fallback is “best effort”, not a promise.

Appendix: Exact files to modify



Backend:



supabase/functions/create-run/index.ts

supabase/functions/refresh-run/index.ts (recommended gating + storage path)

supabase/functions/kling-webhook/index.ts (storage path + logging)

supabase/functions/\_shared/kling.ts

supabase/functions/\_shared/geminiPrompt.ts

supabase/functions/\_shared/scraper.ts (optional: adapter hooks)

New: supabase/functions/\_shared/companyConfig.ts

Migration: supabase/migrations/<timestamp>\_add\_company\_slug.sql



Frontend:



frontend/src/app/page.tsx (if query param approach)

or

New/Move: frontend/src/app/demo/\[company]/page.tsx

frontend/src/lib/supabase.ts (add company\_slug to VideoRun type)

optionally: frontend/src/lib/company.ts (map slug → display name + placeholder URL)

