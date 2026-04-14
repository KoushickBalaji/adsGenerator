
/* ── Sample video showcase ──────────────────────────────────────────────
   Set this to a public URL (e.g. Supabase Storage) to show a real
   generated video on the landing page. Leave empty to show a placeholder. */
const SAMPLE_VIDEO_URL =
  "https://yjfcfxrytcenwlfdbofp.supabase.co/storage/v1/object/public/generated-videos/d831a8c5-54c5-4579-8bdb-e3686e215037.mp4";
const SAMPLE_VIDEO_POSTER = "";

export default function Home() {
  return (
    <main className="mx-auto w-full max-w-screen-2xl px-6 py-14">
      <div className="grid items-start gap-10 lg:grid-cols-12">
      {/* ── Hero ─────────────────────────────────────────────────── */}
      <header className="rounded-2xl border border-zinc-200 bg-gradient-to-b from-zinc-50 to-white p-10 shadow-sm lg:col-span-5">
        <p className="text-xs font-medium tracking-[0.2em] text-blue-600">
          AI VIDEOS FOR JEWELRY BRANDS
        </p>
        <h1 className="mt-3 text-3xl font-semibold text-zinc-900 sm:text-4xl lg:text-5xl">
          Turn your product catalog into
          <br className="hidden sm:block" /> scroll-stopping videos.
        </h1>
        <p className="mt-5 max-w-3xl text-base leading-relaxed text-zinc-500">
          Video production is expensive, slow, and hard to scale across hundreds of SKUs.
          We fix that. Paste a product link, and our AI extracts the images, writes a short scene plan,
          and generates a cinematic video — ready for social, marketplaces, or your website.
        </p>

        <div className="mt-6 flex flex-wrap items-center gap-3">
          <a
            href="mailto:balajikoushick@gmail.com"
            className="inline-flex items-center justify-center rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-500"
          >
            Contact us
          </a>
        </div>
      </header>

      {/* ── Video Showcase ───────────────────────────────────────── */}
      <section className="mt-0 lg:col-span-7">
        <div className="overflow-hidden rounded-2xl border border-zinc-200 bg-black shadow-sm">
          <div className="aspect-video w-full">
            {SAMPLE_VIDEO_URL ? (
              <video
                src={SAMPLE_VIDEO_URL}
                poster={SAMPLE_VIDEO_POSTER || undefined}
                preload="auto"
                controls
                controlsList="nodownload noremoteplayback"
                disablePictureInPicture
                className="h-full w-full object-contain"
              />
            ) : (
              <div className="flex h-full w-full items-center justify-center bg-zinc-900/50">
                <div className="text-center">
                  <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full border border-zinc-200 bg-white shadow-sm">
                    <svg
                      className="h-7 w-7 text-blue-500"
                      fill="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path d="M8 5v14l11-7z" />
                    </svg>
                  </div>
                  <p className="mt-4 text-sm text-zinc-400">
                    Sample video coming soon
                  </p>
                </div>
              </div>
            )}
          </div>
        </div>
        <p className="mt-3 text-center text-xs text-zinc-400">
          Generated from a product page. No shoot. No editing. No crew.
        </p>
      </section>
      </div>

      {/* ── How It Works ─────────────────────────────────────────── */}
      <section className="mt-14">
        <h2 className="text-center text-lg font-semibold text-zinc-900">
          How it works
        </h2>
        <div className="mt-8 grid gap-6 sm:grid-cols-3">
          <Step
            number="1"
            title="Paste a product URL"
            body="Drop a link to any product from your store. We handle the rest."
          />
          <Step
            number="2"
            title="AI generates the video"
            body="Images are extracted, a short scene plan is written, and a cinematic video is produced automatically."
          />
          <Step
            number="3"
            title="Download and launch"
            body="Get a ready-to-use short video for Instagram Reels, marketplaces, or your website."
          />
        </div>
      </section>

      {/* ── Benefits ─────────────────────────────────────────────── */}
      <section className="mt-14 rounded-2xl border border-zinc-200 bg-gradient-to-b from-white to-zinc-50 p-8 shadow-sm">
        <h2 className="text-center text-lg font-semibold text-zinc-900">
          What you can generate
        </h2>
        <p className="mx-auto mt-2 max-w-3xl text-center text-sm leading-relaxed text-zinc-500">
          Use the same product page to generate multiple video formats — from clean product detail
          shots to lifestyle storytelling.
        </p>
        <div className="mt-7 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Format
            title="Angle-driven product video"
            body="Close-ups and rotations designed to highlight finish and sparkle."
          />
          <Format
            title="Collection teaser"
            body="Short clips to announce new drops across multiple SKUs."
          />
          <Format
            title="Website PDP video"
            body="Help customers understand size, texture, and details faster."
          />
          <Format
            title="Marketplace listing video"
            body="Richer visuals for high-intent shoppers comparing options."
          />
          <Format
            title="Campaign variants"
            body="Multiple hooks and story beats to keep content fresh."
          />
          <Format
            title="Localized versions"
            body="Adapt pacing and messaging for regions and audiences."
          />
        </div>
      </section>

      <section className="mt-14">
        <h2 className="text-center text-lg font-semibold text-zinc-900">
          Why jewelry teams adopt this
        </h2>
        <div className="mt-8 grid gap-5 sm:grid-cols-2">
          <Benefit
            title="Every piece deserves a video"
            body="You have hundreds of SKUs, each one unique. Generate a video for any product without booking a photoshoot."
          />
          <Benefit
            title="No studio, no crew, no delays"
            body="Skip the 2-week production cycle. Go from product page to a polished video in minutes, not months."
          />
          <Benefit
            title="Built for how jewelry sells"
            body="Lighting, motion, and close-ups optimized for jewelry — the sparkle, the detail, the craftsmanship that converts browsers into buyers."
          />
          <Benefit
            title="Fresh creatives on demand"
            body="New collection? Festival season? Generate fresh videos overnight without rebooking a shoot or waiting on an agency."
          />
        </div>
      </section>

      {/* ── Use Cases ────────────────────────────────────────────── */}
      <section className="mt-14">
        <h2 className="text-center text-lg font-semibold text-zinc-900">
          Use cases for AI video generation
        </h2>
        <p className="mx-auto mt-2 max-w-3xl text-center text-sm leading-relaxed text-zinc-500">
          Start with product videos, then expand into launches, listings, and campaigns. The same
          catalog can fuel multiple formats without adding production overhead.
        </p>
        <div className="mt-8 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          <UseCase
            title="Product detail videos"
            body="Show sparkle, craftsmanship, and scale with controlled motion and close-ups."
          />
          <UseCase
            title="Social videos"
            body="Create short videos for Reels/Shorts that look native in-feed while staying on-brand."
          />
          <UseCase
            title="Marketplace enhancements"
            body="Add richer visuals to listings where customers decide quickly between similar pieces."
          />
          <UseCase
            title="New collection teasers"
            body="Generate launch clips across many SKUs without waiting for production windows."
          />
          <UseCase
            title="Festival & seasonal drops"
            body="Create timely videos for moments like weddings, gifting, Akshaya Tritiya, and Diwali."
          />
          <UseCase
            title="Website merchandising"
            body="Use videos on PDPs, category pages, and landing pages to reduce hesitation and returns."
          />
          <UseCase
            title="Retargeting variants"
            body="Produce multiple angles and story beats so campaigns don’t go stale after a few days."
          />
          <UseCase
            title="Localization"
            body="Adapt pacing and messaging for different languages, regions, and audiences."
          />
          <UseCase
            title="Catalog experiments"
            body="Test hooks and styles to learn what drives engagement for your brand."
          />
        </div>
      </section>

      {/* ── Try It CTA ───────────────────────────────────────────── */}

      {/* ── Footer ───────────────────────────────────────────────── */}
      <section className="mt-14 overflow-hidden rounded-2xl border border-zinc-200 bg-gradient-to-b from-zinc-50 to-white p-8 shadow-sm">
        <div className="mx-auto max-w-3xl text-center">
          <h2 className="text-lg font-semibold text-zinc-900">
            Want this for your brand?
          </h2>
          <p className="mt-2 text-sm leading-relaxed text-zinc-500">
            Share your website link and we’ll set up a dedicated demo page for your store, with
            the right scraping rules and prompt style.
          </p>
          <div className="mt-6 flex justify-center">
            <a
              href="mailto:balajikoushick@gmail.com"
              className="inline-flex items-center justify-center rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-500"
            >
              Contact us
            </a>
          </div>
        </div>
      </section>

      <footer className="mt-12 rounded-2xl border border-zinc-200 bg-zinc-50 px-6 py-6 text-center text-xs text-zinc-500">
        This is a technology demonstration. Outputs are AI-generated and may vary.
      </footer>
    </main>
  );
}

/* ── Sub-components ───────────────────────────────────────────────────── */

function Step({
  number,
  title,
  body,
}: {
  number: string;
  title: string;
  body: string;
}) {
  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-6 text-center shadow-sm">
      <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-full bg-blue-50 text-sm font-bold text-blue-600">
        {number}
      </div>
      <h3 className="mt-4 text-sm font-semibold text-zinc-900">{title}</h3>
      <p className="mt-2 text-sm leading-relaxed text-zinc-500">{body}</p>
    </div>
  );
}

function Benefit({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-6 shadow-sm">
      <h3 className="text-sm font-semibold text-zinc-900">{title}</h3>
      <p className="mt-2 text-sm leading-relaxed text-zinc-500">{body}</p>
    </div>
  );
}

function Format({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-5 shadow-sm">
      <p className="text-sm font-semibold text-zinc-900">{title}</p>
      <p className="mt-1 text-sm leading-relaxed text-zinc-600">{body}</p>
    </div>
  );
}

function UseCase({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-6 shadow-sm transition-shadow hover:shadow-md">
      <h3 className="text-sm font-semibold text-zinc-900">{title}</h3>
      <p className="mt-2 text-sm leading-relaxed text-zinc-600">{body}</p>
    </div>
  );
}
