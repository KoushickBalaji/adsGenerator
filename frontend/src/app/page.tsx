import { Suspense } from "react";
import { DemoRedirectForm } from "./demo-redirect-form";

/* ── Sample video showcase ──────────────────────────────────────────────
   Set this to a public URL (e.g. Supabase Storage) to show a real
   generated video on the landing page. Leave empty to show a placeholder. */
const SAMPLE_VIDEO_URL = "";
const SAMPLE_VIDEO_POSTER = "";

export default function Home() {
  return (
    <main className="mx-auto w-full max-w-6xl px-6 py-14">
      {/* ── Hero ─────────────────────────────────────────────────── */}
      <header className="rounded-2xl border border-zinc-800 bg-gradient-to-b from-zinc-900 to-zinc-950 p-10 shadow-2xl">
        <p className="text-xs font-medium tracking-[0.2em] text-blue-300/90">
          AI VIDEO ADS FOR JEWELLERY BRANDS
        </p>
        <h1 className="mt-3 text-3xl font-semibold text-zinc-100 sm:text-4xl lg:text-5xl">
          Turn your product catalog into
          <br className="hidden sm:block" /> scroll-stopping video ads.
        </h1>
        <p className="mt-5 max-w-3xl text-base leading-relaxed text-zinc-300/90">
          Video production is expensive, slow, and impossible to scale across hundreds of SKUs.
          We fix that. Paste a product link, and our AI extracts the images, writes the script,
          and generates a cinematic ad — ready for social, marketplaces, or your website.
        </p>
      </header>

      {/* ── Video Showcase ───────────────────────────────────────── */}
      <section className="mt-10">
        <div className="overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-900">
          {SAMPLE_VIDEO_URL ? (
            <video
              src={SAMPLE_VIDEO_URL}
              poster={SAMPLE_VIDEO_POSTER || undefined}
              controls
              controlsList="nodownload noremoteplayback"
              disablePictureInPicture
              className="aspect-square w-full object-contain sm:aspect-video"
            />
          ) : (
            <div className="flex aspect-square items-center justify-center bg-zinc-950/60 sm:aspect-video">
              <div className="text-center">
                <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full border border-zinc-700 bg-zinc-800">
                  <svg
                    className="h-7 w-7 text-blue-400"
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
        <p className="mt-3 text-center text-xs text-zinc-500">
          Generated from a product page. No shoot. No editing. No crew.
        </p>
      </section>

      {/* ── How It Works ─────────────────────────────────────────── */}
      <section className="mt-14">
        <h2 className="text-center text-lg font-semibold text-zinc-100">
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
            title="AI generates the ad"
            body="Images are extracted, a script is written, and a cinematic video is produced automatically."
          />
          <Step
            number="3"
            title="Download and launch"
            body="Get an ad-ready video for Instagram Reels, Meta, Amazon, or your own website."
          />
        </div>
      </section>

      {/* ── Benefits ─────────────────────────────────────────────── */}
      <section className="mt-14">
        <h2 className="text-center text-lg font-semibold text-zinc-100">
          Why jewellery brands need this
        </h2>
        <div className="mt-8 grid gap-5 sm:grid-cols-2">
          <Benefit
            title="Every piece deserves a video"
            body="You have hundreds of SKUs, each one unique. Generate a video for any product without booking a photoshoot."
          />
          <Benefit
            title="No studio, no crew, no delays"
            body="Skip the 2-week production cycle. Go from product page to ad-ready video in minutes, not months."
          />
          <Benefit
            title="Built for how jewellery sells"
            body="Lighting, motion, and close-ups optimized for jewellery — the sparkle, the detail, the craftsmanship that converts browsers into buyers."
          />
          <Benefit
            title="Fresh creatives on demand"
            body="New collection? Festival season? Generate fresh ads overnight without rebooking a shoot or waiting on an agency."
          />
        </div>
      </section>

      {/* ── Use Cases ────────────────────────────────────────────── */}
      <section className="mt-14">
        <h2 className="text-center text-lg font-semibold text-zinc-100">
          Where it fits
        </h2>
        <div className="mt-8 grid gap-5 sm:grid-cols-3">
          <UseCase
            title="Social ads"
            body="Instagram Reels, Meta, YouTube Shorts — generate scroll-stopping creatives at the pace your campaigns demand."
          />
          <UseCase
            title="Marketplace listings"
            body="Richer product pages on Amazon, Flipkart, or your own store. Video listings get more engagement, period."
          />
          <UseCase
            title="Collection launches"
            body="Turn a new drop into a full video campaign overnight. No lead time, no coordination, just results."
          />
        </div>
      </section>

      {/* ── Try It CTA ───────────────────────────────────────────── */}
      <Suspense fallback={null}>
        <DemoRedirectForm />
      </Suspense>

      {/* ── Footer ───────────────────────────────────────────────── */}
      <footer className="mt-10 text-center text-xs text-zinc-500">
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
    <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-6 text-center">
      <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-full bg-blue-600/20 text-sm font-bold text-blue-400">
        {number}
      </div>
      <h3 className="mt-4 text-sm font-semibold text-zinc-100">{title}</h3>
      <p className="mt-2 text-sm leading-relaxed text-zinc-400">{body}</p>
    </div>
  );
}

function Benefit({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-950/40 p-6">
      <h3 className="text-sm font-semibold text-zinc-100">{title}</h3>
      <p className="mt-2 text-sm leading-relaxed text-zinc-300/80">{body}</p>
    </div>
  );
}

function UseCase({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-6">
      <h3 className="text-sm font-semibold text-zinc-200">{title}</h3>
      <p className="mt-2 text-sm leading-relaxed text-zinc-400">{body}</p>
    </div>
  );
}
