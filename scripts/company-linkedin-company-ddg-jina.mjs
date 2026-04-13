#!/usr/bin/env node
/**
 * Discover LinkedIn company page URLs via DuckDuckGo HTML, fetched through r.jina.ai.
 *
 * Why r.jina.ai?
 * - Direct DuckDuckGo HTML frequently triggers bot challenges from server-side fetches.
 * - r.jina.ai fetches and returns a readable markdown representation that is stable for our usage.
 *
 * Writes to `public.company_prompt_profiles.social_links` (merging, not overwriting):
 * - linkedin_company_urls: string[]
 * - linkedin_company_audit: { audited_at, engine, queries_tried, counts, status, error? }
 *
 * Notes:
 * - We do NOT crawl LinkedIn pages. We only parse public search result links.
 * - Best-effort: some companies won’t have LinkedIn pages or are ambiguous.
 *
 * Usage:
 *   node scripts/company-linkedin-company-ddg-jina.mjs --out-dir scripts/out/linkedin-company
 *   node scripts/company-linkedin-company-ddg-jina.mjs --company bluestone --company melorra
 *   node scripts/company-linkedin-company-ddg-jina.mjs --concurrency 2 --min-delay-ms 900 --max-delay-ms 1500
 *   node scripts/company-linkedin-company-ddg-jina.mjs --force
 *   node scripts/company-linkedin-company-ddg-jina.mjs --dry-run
 */

import fs from "node:fs";
import path from "node:path";

function usage(message) {
  if (message) console.error(message);
  console.error(
    [
      "",
      "Usage:",
      "  node scripts/company-linkedin-company-ddg-jina.mjs [options]",
      "",
      "Options:",
      "  --company <slug>        Only run for this company (repeatable)",
      "  --companies <path>      Optional JSON mapping: [{ slug, name, website }, ...] (default: scripts/companies.india.json)",
      "  --out-dir <path>        Write per-company JSON outputs",
      "  --concurrency <n>       Parallel companies (default: 2)",
      "  --min-delay-ms <n>      Min delay between requests per worker (default: 900)",
      "  --max-delay-ms <n>      Max delay between requests per worker (default: 1500)",
      "  --max-queries <n>       Max search queries per company (default: 2)",
      "  --force                 Run even if linkedin_company_urls already present",
      "  --dry-run               Do not write to Supabase",
      "  -h, --help              Show help",
      "",
      "Env vars (or .env.local):",
      "  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY",
      "",
    ].join("\n")
  );
  process.exit(1);
}

function parseArgs(argv) {
  const args = {
    companySlugs: [],
    companiesPath: "scripts/companies.india.json",
    outDir: null,
    concurrency: 2,
    minDelayMs: 900,
    maxDelayMs: 1500,
    maxQueries: 2,
    force: false,
    dryRun: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--company") {
      const slug = String(argv[i + 1] ?? "").trim();
      if (slug) args.companySlugs.push(slug.toLowerCase());
      i++;
      continue;
    }
    if (a === "--companies") {
      args.companiesPath = String(argv[i + 1] ?? "").trim() || args.companiesPath;
      i++;
      continue;
    }
    if (a === "--out-dir") {
      args.outDir = argv[i + 1] ?? null;
      i++;
      continue;
    }
    if (a === "--concurrency") {
      const n = Number(argv[i + 1]);
      if (!Number.isFinite(n) || n <= 0) usage("Invalid --concurrency");
      args.concurrency = Math.max(1, Math.min(6, Math.trunc(n)));
      i++;
      continue;
    }
    if (a === "--min-delay-ms") {
      const n = Number(argv[i + 1]);
      if (!Number.isFinite(n) || n < 0) usage("Invalid --min-delay-ms");
      args.minDelayMs = Math.max(0, Math.trunc(n));
      i++;
      continue;
    }
    if (a === "--max-delay-ms") {
      const n = Number(argv[i + 1]);
      if (!Number.isFinite(n) || n < 0) usage("Invalid --max-delay-ms");
      args.maxDelayMs = Math.max(0, Math.trunc(n));
      i++;
      continue;
    }
    if (a === "--max-queries") {
      const n = Number(argv[i + 1]);
      if (!Number.isFinite(n) || n <= 0) usage("Invalid --max-queries");
      args.maxQueries = Math.max(1, Math.min(4, Math.trunc(n)));
      i++;
      continue;
    }
    if (a === "--force") {
      args.force = true;
      continue;
    }
    if (a === "--dry-run") {
      args.dryRun = true;
      continue;
    }
    if (a === "-h" || a === "--help") usage();
    usage(`Unknown argument: ${a}`);
  }

  if (args.maxDelayMs < args.minDelayMs) usage("--max-delay-ms must be >= --min-delay-ms");
  return args;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randInt(min, max) {
  if (max <= min) return min;
  return min + Math.floor(Math.random() * (max - min + 1));
}

function ensureDir(dirPath) {
  if (!dirPath) return;
  fs.mkdirSync(path.resolve(dirPath), { recursive: true });
}

function writeOut(outDir, filename, json) {
  if (!outDir) return;
  ensureDir(outDir);
  fs.writeFileSync(path.join(path.resolve(outDir), filename), JSON.stringify(json, null, 2));
}

function readJsonIfExists(filePath) {
  const p = path.resolve(filePath);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function readDotEnvLocal() {
  const filePath = path.resolve(".env.local");
  if (!fs.existsSync(filePath)) return {};
  const raw = fs.readFileSync(filePath, "utf8");
  const out = {};
  for (const line of raw.split(/\r?\n/)) {
    if (!line || /^\s*#/.test(line)) continue;
    const idx = line.indexOf("=");
    if (idx < 0) continue;
    const k = line.slice(0, idx).trim();
    const v = line.slice(idx + 1).trim();
    if (!k) continue;
    out[k] = v;
  }
  return out;
}

function getRequiredEnv(dotEnv, key) {
  const v = process.env[key] || dotEnv[key];
  if (!v) usage(`Missing ${key} (set env var or add to .env.local)`);
  return v;
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function uniq(list) {
  return Array.from(new Set((list || []).map(String).map((s) => s.trim()).filter(Boolean)));
}

function normalizeSlug(raw) {
  const s = String(raw || "").trim().toLowerCase();
  if (!s) return "";
  return s
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
}

function normalizeLinkedInCompanyUrl(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";
  if (!/^https?:\/\//i.test(s)) return "";
  try {
    const u = new URL(s);
    const host = u.hostname.replace(/^www\./i, "").toLowerCase();
    if (!host.endsWith("linkedin.com")) return "";
    if (!u.pathname.toLowerCase().startsWith("/company/")) return "";
    u.protocol = "https:";
    u.hash = "";
    u.search = "";
    u.pathname = u.pathname.replace(/\/+$/, "");
    return u.toString();
  } catch {
    return "";
  }
}

function getDomainFromWebsite(websiteUrl) {
  try {
    const u = new URL(websiteUrl);
    return u.hostname.replace(/^www\./i, "");
  } catch {
    return "";
  }
}

function extractDdgRedirectTargets(markdown) {
  const out = [];
  const re = /https:\/\/duckduckgo\.com\/l\/\?uddg=([^&\s\)]+)/gi;
  let m;
  while ((m = re.exec(markdown))) {
    try {
      const target = decodeURIComponent(m[1]);
      out.push(target);
    } catch {
      // ignore bad encodings
    }
  }
  return out;
}

function extractDirectLinkedInUrls(markdown) {
  const out = [];
  const re = /https?:\/\/[a-z]{0,4}\.?linkedin\.com\/company\/[^\s\)\]]+/gi;
  let m;
  while ((m = re.exec(markdown))) out.push(m[0]);
  return out;
}

function extractLinkedInCompanyUrlsFromMarkdown(markdown) {
  const candidates = [
    ...extractDdgRedirectTargets(markdown),
    ...extractDirectLinkedInUrls(markdown),
  ];
  return uniq(candidates.map(normalizeLinkedInCompanyUrl).filter(Boolean));
}

async function fetchDdgMarkdown({ query, timeoutMs = 25000 }) {
  const ddgUrl = `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const url = `https://r.jina.ai/${ddgUrl}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        Accept: "text/plain,*/*;q=0.8",
      },
      redirect: "follow",
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      const e = new Error(`r.jina.ai HTTP ${res.status}`);
      e.status = res.status;
      throw e;
    }
    // r.jina.ai can return an error page in-band
    if (/Title:\s+Error/i.test(text) && /Markdown Content:/i.test(text)) {
      throw new Error("r.jina.ai returned an error page");
    }
    return text;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchDdgMarkdownWithRetries({ query, timeoutMs = 25000, maxAttempts = 5 }) {
  let lastErr = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fetchDdgMarkdown({ query, timeoutMs });
    } catch (err) {
      lastErr = err;
      const status = err && typeof err === "object" ? err.status : undefined;
      const isRateLimit = status === 429;
      const isRetryable = isRateLimit || status === 502 || status === 503 || status === 504;
      if (!isRetryable || attempt === maxAttempts) throw err;
      const base = isRateLimit ? 8000 : 3000;
      const backoff = base * Math.pow(2, attempt - 1);
      const jitter = randInt(250, 1250);
      await sleep(backoff + jitter);
    }
  }
  // should not reach
  throw lastErr || new Error("fetch failed");
}

function buildQueries({ name, domain }) {
  const q1 = `${name} LinkedIn company India`.trim();
  const q2 = domain ? `${domain} LinkedIn company` : `${name} LinkedIn company`.trim();
  const q3 = `${name} jewellery LinkedIn company`.trim();
  const q4 = `site:linkedin.com/company ${name}`.trim();
  return uniq([q1, q2, q3, q4]);
}

function getCompanyIdFromLinkedInUrl(u) {
  const s = String(u || "");
  const m = s.match(/linkedin\.com\/company\/([^/?#]+)/i);
  return m ? m[1].toLowerCase() : "";
}

function normalizeKey(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function extractDomainRoot(domain) {
  const d = String(domain || "").toLowerCase().replace(/^www\./, "");
  const parts = d.split(".").filter(Boolean);
  if (parts.length < 2) return d;
  // naive second-level domain extraction (good enough for .com/.in/.co etc)
  return parts[0];
}

function buildBrandKeys({ slug, name, domain }) {
  const keys = [];
  const slugKey = normalizeKey(slug);
  if (slugKey) keys.push(slugKey);
  const nameKey = normalizeKey(name);
  if (nameKey) keys.push(nameKey);
  const root = normalizeKey(extractDomainRoot(domain));
  if (root) keys.push(root);
  // Also add first 2 slug tokens to handle cases like "giva-co"
  const slugTokens = String(slug || "")
    .toLowerCase()
    .split("-")
    .map((t) => t.replace(/[^a-z0-9]+/g, ""))
    .filter((t) => t.length >= 3);
  keys.push(...slugTokens);

  // Add name tokens, excluding common jewellery words to reduce false positives.
  const stop = new Set([
    "jewellery",
    "jewelry",
    "jewels",
    "jewel",
    "jeweller",
    "jewellers",
    "silver",
    "silvers",
    "gold",
    "diamond",
    "diamonds",
    "store",
    "official",
    "india",
    "fashion",
    "the",
    "by",
  ]);
  const nameTokens = String(name || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .map((t) => t.trim())
    .filter(Boolean)
    .filter((t) => t.length >= 4 && !stop.has(t));
  keys.push(...nameTokens);

  return uniq(keys).filter((k) => k.length >= 3);
}

function filterLikelyMatches({ urls, brandKeys, strongKeys }) {
  const scored = [];
  for (const url of urls) {
    const id = normalizeKey(getCompanyIdFromLinkedInUrl(url));
    if (!id) continue;
    if (Array.isArray(strongKeys) && strongKeys.length > 0) {
      const ok = strongKeys.some((k) => k && id.includes(k));
      if (!ok) continue;
    }
    let score = 0;
    for (const k of brandKeys) {
      if (id === k) score += 6;
      else if (id.includes(k)) score += 4;
    }
    // Prefer explicit brand IDs over extremely short/generic IDs
    if (id.length <= 4) score -= 2;
    scored.push({ url, id, score });
  }
  scored.sort((a, b) => b.score - a.score);
  const best = scored.filter((x) => x.score >= 4).map((x) => x.url);
  return uniq(best);
}

async function supabaseListCompanies({ supabaseUrl, supabaseKey }) {
  const url =
    `${supabaseUrl.replace(/\/+$/, "")}` +
    `/rest/v1/company_prompt_profiles?select=company_slug,website_url,social_links&order=company_slug.asc`;
  const res = await fetch(url, {
    method: "GET",
    headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Supabase GET error ${res.status}: ${text}`);
  const json = text.trim() ? JSON.parse(text) : [];
  if (!Array.isArray(json)) throw new Error("Supabase GET did not return an array");
  return json;
}

function isSchemaCacheError(text) {
  const s = String(text || "");
  return /schema cache|could not find|PGRST/i.test(s);
}

async function supabasePatchCompany({ supabaseUrl, supabaseKey, slug, patch, _allowFallback = true }) {
  const url =
    `${supabaseUrl.replace(/\/+$/, "")}` +
    `/rest/v1/company_prompt_profiles?company_slug=eq.${encodeURIComponent(slug)}`;

  const res = await fetch(url, {
    method: "PATCH",
    headers: {
      apikey: supabaseKey,
      Authorization: `Bearer ${supabaseKey}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify(patch),
  });
  const text = await res.text();
  if (!res.ok) {
    const hasExtraKeys = patch && typeof patch === "object" && Object.keys(patch).length > 1;
    const canFallback = _allowFallback && hasExtraKeys && patch && patch.social_links;
    if (canFallback && (res.status === 400 || res.status === 404) && isSchemaCacheError(text)) {
      return supabasePatchCompany({
        supabaseUrl,
        supabaseKey,
        slug,
        patch: { social_links: patch.social_links },
        _allowFallback: false,
      });
    }
    throw new Error(`Supabase PATCH error ${res.status}: ${text}`);
  }
}

function shouldSkipExisting({ socialLinks, force }) {
  if (force) return false;
  const social = isRecord(socialLinks) ? socialLinks : {};
  if (Array.isArray(social.linkedin_company_urls) && social.linkedin_company_urls.length > 0) return true;
  const audit = isRecord(social.linkedin_company_audit) ? social.linkedin_company_audit : null;
  if (audit && audit.no_company_page_found === true) return true;
  return false;
}

async function runPool({ items, concurrency, worker }) {
  const q = items.slice();
  const active = new Set();

  async function runOne() {
    const item = q.shift();
    if (!item) return;
    const p = Promise.resolve()
      .then(() => worker(item))
      .finally(() => active.delete(p));
    active.add(p);
    if (active.size >= concurrency) await Promise.race(active);
    return runOne();
  }

  const starters = [];
  for (let i = 0; i < Math.min(concurrency, items.length); i++) starters.push(runOne());
  await Promise.all(starters);
  await Promise.all(active);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dotEnv = readDotEnvLocal();
  const supabaseUrl = getRequiredEnv(dotEnv, "SUPABASE_URL");
  const supabaseKey = getRequiredEnv(dotEnv, "SUPABASE_SERVICE_ROLE_KEY");

  const companiesJson = readJsonIfExists(args.companiesPath);
  const nameMap = new Map();
  if (Array.isArray(companiesJson)) {
    for (const row of companiesJson) {
      const slug = normalizeSlug(row?.slug);
      const name = String(row?.name || "").trim();
      if (slug && name) nameMap.set(slug, name);
    }
  }

  const only = new Set(args.companySlugs.map(normalizeSlug).filter(Boolean));
  console.log(`Out dir: ${args.outDir ? path.resolve(args.outDir) : "(none)"}`);
  console.log(`Write to Supabase: ${args.dryRun ? "no (dry-run)" : "yes"}`);
  console.log(`Concurrency: ${args.concurrency} (delay ${args.minDelayMs}-${args.maxDelayMs}ms)`);

  const rows = await supabaseListCompanies({ supabaseUrl, supabaseKey });
  const companies = rows
    .map((r) => {
      const slug = normalizeSlug(r?.company_slug);
      const websiteUrl = String(r?.website_url || "").trim();
      const socialLinks = r?.social_links;
      const name = nameMap.get(slug) || slug;
      const domain = websiteUrl ? getDomainFromWebsite(websiteUrl) : "";
      return { slug, name, websiteUrl, domain, socialLinks };
    })
    .filter((c) => c.slug && c.websiteUrl)
    .filter((c) => (only.size > 0 ? only.has(c.slug) : true))
    .filter((c) => !shouldSkipExisting({ socialLinks: c.socialLinks, force: args.force }));

  let ok = 0;
  let skipped = 0;
  let failed = 0;

  const startedAt = new Date().toISOString();

  await runPool({
    items: companies,
    concurrency: args.concurrency,
    worker: async (c) => {
      const auditedAt = new Date().toISOString();
      const audit = {
        audited_at: auditedAt,
        engine: "ddg_jina",
        queries_tried: [],
        counts: {},
        status: "ok",
      };

      try {
        const queries = buildQueries({ name: c.name, domain: c.domain }).slice(0, args.maxQueries);
        const found = [];

        for (const q of queries) {
          audit.queries_tried.push(q);
          const md = await fetchDdgMarkdownWithRetries({ query: q });
          const urls = extractLinkedInCompanyUrlsFromMarkdown(md);
          found.push(...urls);
          await sleep(randInt(args.minDelayMs, args.maxDelayMs));
        }

        const rawUrls = uniq(found);
        const brandKeys = buildBrandKeys({ slug: c.slug, name: c.name, domain: c.domain });
        const strongKeys = uniq([normalizeKey(c.slug), normalizeKey(extractDomainRoot(c.domain))]).filter(
          (k) => k && k.length >= 4
        );
        const filtered = filterLikelyMatches({ urls: rawUrls, brandKeys, strongKeys });
        const companyUrls = (filtered.length > 0 ? filtered : []).slice(0, 5);
        audit.counts = {
          found_total: rawUrls.length,
          stored_filtered: companyUrls.length,
          stored: companyUrls.length,
        };

        const current = isRecord(c.socialLinks) ? c.socialLinks : {};
        const merged = uniq([...(Array.isArray(current.linkedin_company_urls) ? current.linkedin_company_urls : []), ...companyUrls]);

        const next = {
          ...current,
          linkedin_company_urls: merged,
          linkedin_company_audit: {
            ...audit,
            no_company_page_found: companyUrls.length === 0,
          },
        };

        if (!next.linkedin_company_url && merged.length > 0) {
          next.linkedin_company_url = merged[0];
        }

        writeOut(args.outDir, `${c.slug}.linkedin-company.json`, {
          company_slug: c.slug,
          company_name: c.name,
          website_url: c.websiteUrl,
          linkedin_company_urls: merged,
          audit,
        });

        if (args.dryRun) {
          console.log(`[dry-run] ${c.slug}: found=${companyUrls.length}`);
          ok += 1;
          return;
        }

        await supabasePatchCompany({
          supabaseUrl,
          supabaseKey,
          slug: c.slug,
          patch: {
            social_links: next,
            ...(next.linkedin_company_url ? { linkedin_company_url: next.linkedin_company_url } : {}),
          },
        });

        console.log(`[ok] ${c.slug}: found=${companyUrls.length}`);
        ok += 1;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[fail] ${c.slug}: ${msg}`);
        failed += 1;

        const current = isRecord(c.socialLinks) ? c.socialLinks : {};
        const next = {
          ...current,
          linkedin_company_audit: { ...audit, status: "error", error: msg },
        };

        writeOut(args.outDir, `${c.slug}.linkedin-company.json`, {
          company_slug: c.slug,
          company_name: c.name,
          website_url: c.websiteUrl,
          linkedin_company_urls: Array.isArray(current.linkedin_company_urls) ? current.linkedin_company_urls : [],
          audit: next.linkedin_company_audit,
        });

        if (!args.dryRun) {
          try {
            await supabasePatchCompany({
              supabaseUrl,
              supabaseKey,
              slug: c.slug,
              patch: { social_links: next },
            });
          } catch {
            // ignore secondary failures
          }
        }
      }
    },
  });

  const totalEligible = rows
    .map((r) => {
      const slug = normalizeSlug(r?.company_slug);
      const websiteUrl = String(r?.website_url || "").trim();
      return { slug, websiteUrl, socialLinks: r?.social_links };
    })
    .filter((c) => c.slug && c.websiteUrl)
    .filter((c) => (only.size > 0 ? only.has(c.slug) : true))
    .filter((c) => !shouldSkipExisting({ socialLinks: c.socialLinks, force: args.force })).length;

  skipped = Math.max(0, totalEligible - ok - failed);
  console.log(`\nDone. ok=${ok} skipped=${skipped} failed=${failed} (started ${startedAt})`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
