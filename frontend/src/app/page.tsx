export default function Home() {
  return (
    <main className="mx-auto w-full max-w-6xl px-6 py-14">
      <header className="rounded-2xl border border-zinc-800 bg-gradient-to-b from-zinc-900 to-zinc-950 p-10 shadow-2xl">
        <p className="text-xs font-medium tracking-[0.2em] text-blue-300/90">AI VIDEO ADS</p>
        <h1 className="mt-3 text-3xl font-semibold text-zinc-100 sm:text-4xl">
          Generate product ad videos with AI.
        </h1>
        <p className="mt-4 max-w-3xl text-sm leading-relaxed text-zinc-300/90">
          Modern advertising is won on iteration speed. AI-generated video helps you turn a product page into
          multiple scroll-stopping creatives in minutes — so you can test more angles, personalize for different
          audiences, and keep campaigns fresh without a full production pipeline.
        </p>

        <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Feature
            title="More creative variants"
            body="Generate multiple hooks, storylines, and visuals to A/B test what converts."
          />
          <Feature
            title="Faster time-to-launch"
            body="Go from product URL to ad-ready video without scheduling shoots or editing timelines."
          />
          <Feature
            title="Localization at scale"
            body="Adapt messaging for markets, languages, and seasonal moments with minimal effort."
          />
          <Feature
            title="Catalog-style production"
            body="Create consistent videos across hundreds of SKUs with repeatable framing and pacing."
          />
          <Feature
            title="Always-on refresh"
            body="Keep paid social and marketplace listings from going stale by refreshing creatives regularly."
          />
          <Feature
            title="Brand-safe defaults"
            body="Use pre-configured rules (style, personas, allowed URLs) to keep demos controlled."
          />
        </div>
      </header>

      <section className="mt-10 grid gap-6 lg:grid-cols-2">
        <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-8">
          <h2 className="text-lg font-semibold text-zinc-100">Where this fits</h2>
          <ul className="mt-4 space-y-3 text-sm text-zinc-300/90">
            <li className="flex gap-3">
              <span className="mt-1 h-2 w-2 flex-shrink-0 rounded-full bg-blue-400" />
              <span>
                <span className="font-medium text-zinc-200">Performance marketing</span>: rapid creative testing for
                Meta/Google/YouTube.
              </span>
            </li>
            <li className="flex gap-3">
              <span className="mt-1 h-2 w-2 flex-shrink-0 rounded-full bg-blue-400" />
              <span>
                <span className="font-medium text-zinc-200">Marketplace listings</span>: richer PDP visuals to improve
                engagement.
              </span>
            </li>
            <li className="flex gap-3">
              <span className="mt-1 h-2 w-2 flex-shrink-0 rounded-full bg-blue-400" />
              <span>
                <span className="font-medium text-zinc-200">Seasonal campaigns</span>: quickly update storylines for new
                drops and festivals.
              </span>
            </li>
          </ul>
        </div>

        <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-8">
          <h2 className="text-lg font-semibold text-zinc-100">Try the demo</h2>
          <p className="mt-3 text-sm leading-relaxed text-zinc-300/90">
            This deployment is accessed through a company-specific demo link.
          </p>
          <div className="mt-4 rounded-xl border border-zinc-800 bg-zinc-950 p-4">
            <p className="text-xs text-zinc-400">Format</p>
            <p className="mt-2 font-mono text-xs text-zinc-300">/demo/&lt;companySlug&gt;?key=&lt;demoKey&gt;</p>
          </div>
          <p className="mt-4 text-xs text-zinc-500">
            Demo links are intentionally gated to protect compute costs. If you don&apos;t have a link, reach out to the
            developer.
          </p>
        </div>
      </section>

      <footer className="mt-10 text-xs text-zinc-500">
        This is a technology demonstration. Outputs may vary and are not intended for commercial use.
      </footer>
    </main>
  );
}

function Feature({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-950/40 p-5">
      <h3 className="text-sm font-semibold text-zinc-100">{title}</h3>
      <p className="mt-2 text-sm leading-relaxed text-zinc-300/80">{body}</p>
    </div>
  );
}
