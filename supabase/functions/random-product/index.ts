import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { getCompanyConfig } from "../_shared/companyConfig.ts";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const DEFAULT_CATEGORIES = ["ring", "earring", "necklace"];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "application/json",
    },
  });
}

function normalizeCompanySlug(input: unknown): string {
  return typeof input === "string" ? input.trim().toLowerCase() : "";
}

function isHostnameAllowed(hostname: string, allowedHost: string): boolean {
  const h = hostname.trim().toLowerCase();
  const a = allowedHost.trim().toLowerCase();
  return h === a || h.endsWith(`.${a}`);
}

function decodeXmlText(input: string): string {
  return input
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", "\"")
    .replaceAll("&#39;", "'");
}

function extractLocs(xml: string): string[] {
  const out: string[] = [];
  const re = /<loc>([\s\S]*?)<\/loc>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const raw = decodeXmlText(m[1].trim());
    if (raw) out.push(raw);
  }
  return out;
}

async function fetchText(url: string, timeoutMs: number): Promise<string> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "user-agent":
          "Mozilla/5.0 (compatible; ads-generator-demo/1.0; +https://example.com)",
        accept: "application/xml,text/xml,text/plain,*/*",
      },
    });
    if (!res.ok) throw new Error(`Fetch failed: ${res.status} ${res.statusText}`);
    return await res.text();
  } finally {
    clearTimeout(t);
  }
}

function extractSitemapUrlsFromRobots(robotsTxt: string): string[] {
  return robotsTxt
    .split(/\r?\n/g)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const m = l.match(/^sitemap:\s*(.+)\s*$/i);
      return m ? m[1].trim() : "";
    })
    .filter(Boolean);
}

function isProbablyProductUrl(rawUrl: string): boolean {
  const lower = rawUrl.toLowerCase();
  if (lower.endsWith(".xml")) return false;
  if (lower.includes("sitemap")) return false;
  if (lower.includes("/blogs/") || lower.includes("/blog/")) return false;
  if (lower.includes("/pages/") || lower.includes("/page/")) return false;
  if (lower.includes("/account") || lower.includes("/cart") || lower.includes("/search")) return false;
  if (lower.includes("/collections/") && !lower.includes("/products/")) return false;

  const productSignals = [
    "/products/",
    "/product/",
    "/rings/",
    "/earrings/",
    "/necklace",
    "/necklaces/",
    "ring",
    "earring",
    "necklace",
    ".html",
  ];
  return productSignals.some((s) => lower.includes(s));
}

function isPreferredCategory(url: string, categories: string[]): boolean {
  try {
    const u = new URL(url);
    const p = (u.pathname || "").toLowerCase();
    return categories.some((c) => c && p.includes(c.toLowerCase()));
  } catch {
    return false;
  }
}

async function discoverSitemapStartUrls(allowedHost: string, requestId: string): Promise<string[]> {
  const baseCandidates = [`https://${allowedHost}`, `https://www.${allowedHost}`];
  const sitemapPaths = ["/sitemap.xml", "/sitemap_index.xml", "/sitemapindex.xml"];

  const startUrls = new Set<string>();
  for (const base of baseCandidates) {
    for (const p of sitemapPaths) startUrls.add(`${base}${p}`);
  }

  // robots.txt fallback (some sites publish nonstandard sitemap URLs here)
  for (const base of baseCandidates) {
    const robotsUrl = `${base}/robots.txt`;
    try {
      const robotsTxt = await fetchText(robotsUrl, 6000);
      const robotSitemaps = extractSitemapUrlsFromRobots(robotsTxt);
      if (robotSitemaps.length > 0) {
        console.log(
          `[random-product][${requestId}] robots.txt sitemaps from ${robotsUrl}: ${robotSitemaps.length}`
        );
        for (const u of robotSitemaps) startUrls.add(u);
      } else {
        console.log(
          `[random-product][${requestId}] robots.txt had no sitemaps: ${robotsUrl}`
        );
      }
    } catch (err) {
      console.log(
        `[random-product][${requestId}] robots.txt fetch failed: ${robotsUrl}`,
        err
      );
    }
  }

  return Array.from(startUrls);
}

async function discoverRandomProductUrl(opts: {
  allowedHosts: string[];
  categories: string[];
  requestId: string;
}): Promise<string> {
  const allowedHost = opts.allowedHosts[0];
  const sitemapStartUrls = await discoverSitemapStartUrls(allowedHost, opts.requestId);
  console.log(
    `[random-product][${opts.requestId}] sitemap start URLs: ${sitemapStartUrls.length}`
  );

  const seenSitemaps = new Set<string>();
  const toVisit = sitemapStartUrls.slice(0, 6);
  const discoveredUrls: string[] = [];

  while (toVisit.length > 0 && seenSitemaps.size < 12 && discoveredUrls.length < 6000) {
    const sitemapUrl = toVisit.shift()!;
    if (seenSitemaps.has(sitemapUrl)) continue;
    seenSitemaps.add(sitemapUrl);

    let xml: string;
    try {
      xml = await fetchText(sitemapUrl, 8000);
    } catch {
      console.log(
        `[random-product][${opts.requestId}] sitemap fetch failed: ${sitemapUrl}`
      );
      continue;
    }

    const locs = extractLocs(xml);
    console.log(
      `[random-product][${opts.requestId}] sitemap locs: ${locs.length} (${sitemapUrl})`
    );

    for (const loc of locs) {
      if (loc.toLowerCase().endsWith(".xml")) {
        if (!seenSitemaps.has(loc) && toVisit.length < 20) toVisit.push(loc);
        continue;
      }
      discoveredUrls.push(loc);
      if (discoveredUrls.length >= 6000) break;
    }
  }

  const candidates = Array.from(new Set(discoveredUrls)).filter((raw) => {
    try {
      const u = new URL(raw);
      const ok = opts.allowedHosts.some((h) => isHostnameAllowed(u.hostname, h));
      if (!ok) return false;
      return isProbablyProductUrl(raw);
    } catch {
      return false;
    }
  });

  console.log(
    `[random-product][${opts.requestId}] discovered urls: ${discoveredUrls.length}, unique candidates: ${candidates.length}`
  );

  if (candidates.length === 0) {
    throw new Error(
      "Couldn't find a random product automatically for this website. Please paste a product URL instead."
    );
  }

  const preferred = candidates.filter((u) => isPreferredCategory(u, opts.categories));
  const pool = preferred.length > 0 ? preferred : candidates;
  const picked = pool[Math.floor(Math.random() * pool.length)];
  console.log(
    `[random-product][${opts.requestId}] picked (${preferred.length > 0 ? "preferred" : "any"}): ${picked}`
  );
  return picked;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });

  try {
    const requestId =
      typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}`;

    const body = await req.json().catch(() => ({}));
    const companySlug = normalizeCompanySlug((body as Record<string, unknown>).companySlug);
    const rawCategories = (body as Record<string, unknown>).categories;

    const categories = Array.isArray(rawCategories)
      ? rawCategories.map((v) => String(v || "").trim()).filter(Boolean)
      : DEFAULT_CATEGORIES;

    const config = getCompanyConfig(companySlug);
    if (!config) return jsonResponse({ error: "Invalid demo link." }, 404);
    if (!Array.isArray(config.allowedHosts) || config.allowedHosts.length === 0) {
      return jsonResponse({ error: "This demo link is not configured yet." }, 400);
    }

    console.log(
      `[random-product][${requestId}] start company=${companySlug} allowedHosts=${config.allowedHosts.join(",")}`
    );

    const url = await discoverRandomProductUrl({
      allowedHosts: config.allowedHosts,
      categories,
      requestId,
    });

    return jsonResponse({ url }, 200);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to find a random product.";
    console.error("random-product error:", err);
    return jsonResponse({ error: msg }, 500);
  }
});
