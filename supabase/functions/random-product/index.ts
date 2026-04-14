import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { getCompanyConfig } from "../_shared/companyConfig.ts";
import { getServiceClient } from "../_shared/supabase.ts";

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

function filterSampleUrls(opts: {
  sampleUrls: string[];
  allowedHosts: string[];
  categories: string[];
}): { preferred: string[]; all: string[] } {
  const cleaned = opts.sampleUrls
    .map((u) => String(u || "").trim())
    .filter(Boolean);

  const all = cleaned.filter((raw) => {
    try {
      const u = new URL(raw);
      return opts.allowedHosts.some((h) => isHostnameAllowed(u.hostname, h));
    } catch {
      return false;
    }
  });

  const preferred = all.filter((u) => isPreferredCategory(u, opts.categories));
  return { preferred, all };
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

async function fetchJson(
  url: string,
  timeoutMs: number
): Promise<{ status: number; ok: boolean; json: unknown | null }> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "user-agent":
          "Mozilla/5.0 (compatible; ads-generator-demo/1.0; +https://example.com)",
        accept: "application/json,*/*",
      },
    });
    const status = res.status;
    if (!res.ok) return { status, ok: false, json: null };
    try {
      const json = (await res.json()) as unknown;
      return { status, ok: true, json };
    } catch {
      return { status, ok: true, json: null };
    }
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

function extractShopifyHandlesFromHtml(html: string): string[] {
  const out: string[] = [];
  const re = /href=(?:"|')([^"']+)(?:"|')/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const href = (m[1] || "").trim();
    if (!href) continue;
    if (!href.startsWith("/products/")) continue;
    const handle = href.split("/products/")[1]?.split(/[?#/]/)[0]?.trim();
    if (handle) out.push(handle);
  }
  return Array.from(new Set(out));
}

async function tryShopifyProductsJson(opts: {
  allowedHost: string;
  categories: string[];
  requestId: string;
}): Promise<string | null> {
  const baseCandidates = [
    `https://${opts.allowedHost}`,
    `https://www.${opts.allowedHost}`,
  ];

  for (const base of baseCandidates) {
    const url = `${base}/products.json?limit=250`;
    const res = await fetchJson(url, 8000);
    console.log(
      `[random-product][${opts.requestId}] try products.json: ${url} -> ${res.status}`
    );
    if (!res.ok || !res.json) continue;

    const products = (res.json as { products?: unknown })?.products;
    if (!Array.isArray(products) || products.length === 0) continue;

    const handles = products
      .map((p) => (p as { handle?: unknown })?.handle)
      .filter((h): h is string => typeof h === "string" && h.trim().length > 0)
      .map((h) => h.trim());

    if (handles.length === 0) continue;

    const categoryPool = products
      .filter((p) => {
        const title = String((p as { title?: unknown })?.title ?? "").toLowerCase();
        const productType = String(
          (p as { product_type?: unknown })?.product_type ?? ""
        ).toLowerCase();
        return opts.categories.some((c) => {
          const cc = c.toLowerCase();
          return title.includes(cc) || productType.includes(cc);
        });
      })
      .map((p) => (p as { handle?: unknown })?.handle)
      .filter((h): h is string => typeof h === "string" && h.trim().length > 0)
      .map((h) => h.trim());

    const pickedHandlePool = categoryPool.length > 0 ? categoryPool : handles;
    const pickedHandle =
      pickedHandlePool[Math.floor(Math.random() * pickedHandlePool.length)];

    const picked = `${base}/products/${pickedHandle}`;
    console.log(
      `[random-product][${opts.requestId}] picked via products.json (${categoryPool.length > 0 ? "category" : "any"}): ${picked}`
    );
    return picked;
  }

  return null;
}

async function tryShopifyCollectionsAll(opts: {
  allowedHost: string;
  requestId: string;
}): Promise<string | null> {
  const baseCandidates = [
    `https://${opts.allowedHost}`,
    `https://www.${opts.allowedHost}`,
  ];

  for (const base of baseCandidates) {
    const url = `${base}/collections/all?sort_by=best-selling`;
    try {
      const html = await fetchText(url, 10000);
      const handles = extractShopifyHandlesFromHtml(html);
      console.log(
        `[random-product][${opts.requestId}] collections/all handles: ${handles.length} (${url})`
      );
      if (handles.length === 0) continue;
      const pickedHandle = handles[Math.floor(Math.random() * handles.length)];
      const picked = `${base}/products/${pickedHandle}`;
      console.log(
        `[random-product][${opts.requestId}] picked via collections/all: ${picked}`
      );
      return picked;
    } catch (err) {
      console.log(
        `[random-product][${opts.requestId}] collections/all fetch failed: ${url}`,
        err
      );
    }
  }

  return null;
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

  // Best-effort Shopify shortcut (works on many stores and avoids sitemap gaps).
  const shopifyPicked =
    (await tryShopifyProductsJson({
      allowedHost,
      categories: opts.categories,
      requestId: opts.requestId,
    })) ??
    (await tryShopifyCollectionsAll({
      allowedHost,
      requestId: opts.requestId,
    }));

  if (shopifyPicked) return shopifyPicked;

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

    // Prioritize product sitemaps when present (helps Shopify).
    const xmlSitemaps = locs.filter((l) => l.toLowerCase().endsWith(".xml"));
    const urlLocs = locs.filter((l) => !l.toLowerCase().endsWith(".xml"));

    const scoredXml = xmlSitemaps
      .map((u) => {
        const lower = u.toLowerCase();
        const score = lower.includes("product")
          ? 100
          : lower.includes("products")
          ? 90
          : lower.includes("collection")
          ? 10
          : lower.includes("page")
          ? 5
          : lower.includes("blog")
          ? 1
          : 0;
        return { u, score };
      })
      .sort((a, b) => b.score - a.score)
      .map((x) => x.u);

    for (const loc of scoredXml) {
      if (loc.toLowerCase().endsWith(".xml")) {
        if (!seenSitemaps.has(loc) && toVisit.length < 20) toVisit.push(loc);
      }
    }

    for (const loc of urlLocs) {
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
    // One last Shopify-specific fallback before giving up.
    const fallback = await tryShopifyCollectionsAll({
      allowedHost,
      requestId: opts.requestId,
    });
    if (fallback) return fallback;

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

    // Prefer curated samples from DB (more reliable than sitemaps).
    try {
      const supabase = getServiceClient();
      const { data, error } = await supabase
        .from("company_prompt_profiles")
        .select("sample_product_urls")
        .eq("company_slug", companySlug)
        .maybeSingle();

      if (error) {
        console.log(
          `[random-product][${requestId}] sample_product_urls query failed (will fallback):`,
          error
        );
      } else {
        const sampleUrls =
          (data as { sample_product_urls?: unknown } | null)?.sample_product_urls;
        if (Array.isArray(sampleUrls) && sampleUrls.length > 0) {
          const { preferred, all } = filterSampleUrls({
            sampleUrls: sampleUrls as string[],
            allowedHosts: config.allowedHosts,
            categories,
          });

          console.log(
            `[random-product][${requestId}] db samples: total=${sampleUrls.length}, host_ok=${all.length}, preferred=${preferred.length}`
          );

          const pool = preferred.length > 0 ? preferred : all;
          if (pool.length > 0) {
            const picked = pool[Math.floor(Math.random() * pool.length)];
            console.log(
              `[random-product][${requestId}] picked via db samples (${preferred.length > 0 ? "preferred" : "any"}): ${picked}`
            );
            return jsonResponse({ url: picked }, 200);
          }
        } else {
          console.log(`[random-product][${requestId}] db samples: none configured`);
        }
      }
    } catch (err) {
      console.log(
        `[random-product][${requestId}] db samples lookup crashed (will fallback):`,
        err
      );
    }

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
