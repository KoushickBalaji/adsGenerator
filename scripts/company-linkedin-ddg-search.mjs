#!/usr/bin/env node
/**
 * Best-effort LinkedIn discovery without OpenAI:
 * - Uses DuckDuckGo HTML search results fetched through r.jina.ai (to avoid bot challenges) to find:
 *   - LinkedIn company page URLs
 *   - LinkedIn people profile URLs (founder/CXO-ish query)
 *
 * Writes to `public.company_prompt_profiles.social_links` (merging, not overwriting):
 * - linkedin_company_urls: string[]
 * - linkedin_people_urls: string[]
 * - linkedin_ddg_audit: { audited_at, engine, kl, queries, counts, status, error? }
 *
 * Notes:
 * - We do not crawl LinkedIn pages. We only use public search result links.
 * - Results can include false positives; treat as outreach entry points, not verified identities.
 *
 * Usage:
 *   node scripts/company-linkedin-ddg-search.mjs --out-dir scripts/out/linkedin-ddg
 *   node scripts/company-linkedin-ddg-search.mjs --company bluestone --company melorra
 *   node scripts/company-linkedin-ddg-search.mjs --concurrency 2 --min-delay-ms 900 --max-delay-ms 1500
 *   node scripts/company-linkedin-ddg-search.mjs --force
 *   node scripts/company-linkedin-ddg-search.mjs --dry-run
 */

import fs from "node:fs";
import path from "node:path";

function usage(message) {
  if (message) console.error(message);
  console.error(
    [
      "",
      "Usage:",
      "  node scripts/company-linkedin-ddg-search.mjs [options]",
      "",
      "Options:",
      "  --company <slug>        Only run for this company (repeatable)",
      "  --companies <path>      Optional JSON mapping: [{ slug, name, website }, ...]",
      "  --out-dir <path>        Write per-company JSON outputs",
      "  --concurrency <n>       Parallel companies (default: 2)",
      "  --min-delay-ms <n>      Min delay between DDG requests (default: 900)",
      "  --max-delay-ms <n>      Max delay between DDG requests (default: 1500)",
      "  --force                 Run even if linkedin_* already present",
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
    force: false,
    dryRun: false,
    kl: "in-en",
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
    if (a === "--force") {
      args.force = true;
      continue;
    }
    if (a === "--dry-run") {
      args.dryRun = true;
      continue;
    }
    if (a === "--kl") {
      args.kl = String(argv[i + 1] ?? "").trim() || args.kl;
      i++;
      continue;
    }
    if (a === "-h" || a === "--help") usage();
    usage(`Unknown argument: ${a}`);
  }

  if (args.maxDelayMs < args.minDelayMs) {
    usage("--max-delay-ms must be >= --min-delay-ms");
  }

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

function normalizeLinkedInUrl(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";
  if (!/^https?:\/\//i.test(s)) return "";
  try {
    const u = new URL(s);
    const host = u.hostname.replace(/^www\./i, "").toLowerCase();
    if (!host.endsWith("linkedin.com")) return "";
    u.protocol = "https:";
    u.hash = "";
    u.search = "";
    // strip trailing slash for consistency
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

function decodeHtmlAttr(s) {
  return String(s || "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function extractDdgResultHrefs(html) {
  const out = [];
  const re = /<a[^>]+class=\"[^\"]*result__a[^\"]*\"[^>]+href=\"([^\"]+)\"/gi;
  let m;
  while ((m = re.exec(html))) out.push(decodeHtmlAttr(m[1]));
  return out;
}

function resolveDdgHref(href) {
  try {
    const u = new URL(href, "https://duckduckgo.com");
    // DDG uses redirect links: /l/?uddg=<encoded>
    if (u.hostname.endsWith("duckduckgo.com") && u.pathname === "/l/" && u.searchParams.has("uddg")) {
      const uddg = u.searchParams.get("uddg") || "";
      return decodeURIComponent(uddg);
    }
    return u.toString();
  } catch {
    return "";
  }
}

function extractDdgRedirectTargetsFromMarkdown(markdown) {
  const out = [];
  const re = /https?:\/\/duckduckgo\.com\/l\/\?[^\s\)\]]+/gi;
  let m;
  while ((m = re.exec(markdown))) {
    const resolved = resolveDdgHref(m[0]);
    if (resolved) out.push(resolved);
  }
  return out;
}

function extractDirectLinkedInUrlsFromMarkdown(markdown) {
  const out = [];
  const re = /https?:\/\/[a-z]{0,4}\.?linkedin\.com\/(?:company|in|pub)\/[^\s\)\]]+/gi;
  let m;
  while ((m = re.exec(markdown))) out.push(m[0]);
  return out;
}

function extractLinkedInUrlsFromMarkdown(markdown) {
  const candidates = [
    ...extractDdgRedirectTargetsFromMarkdown(markdown),
    ...extractDirectLinkedInUrlsFromMarkdown(markdown),
  ];

  const out = [];
  for (const u of candidates) {
    const normalized = normalizeLinkedInUrl(u);
    if (!normalized) continue;
    const lower = normalized.toLowerCase();
    if (lower.includes("/company/") || lower.includes("/in/") || lower.includes("/pub/")) {
      out.push(normalized);
    }
  }
  return uniq(out);
}

async function fetchDdgMarkdown({ query, kl, timeoutMs = 25000 }) {
  const ddgUrl = `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}&kl=${encodeURIComponent(kl)}`;
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

async function fetchDdgMarkdownWithRetries({ query, kl, timeoutMs = 25000, maxAttempts = 6 }) {
  let lastErr = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fetchDdgMarkdown({ query, kl, timeoutMs });
    } catch (err) {
      lastErr = err;
      const status = err && typeof err === "object" ? err.status : undefined;
      const msg = err instanceof Error ? err.message : String(err);
      const isRateLimit = status === 429;
      const isRetryableStatus =
        isRateLimit ||
        status === 422 || // r.jina.ai can transiently return 422 under load
        status === 502 ||
        status === 503 ||
        status === 504;
      const isNetworky =
        !status &&
        /(fetch failed|aborted|timed out|timeout|socket|ECONNRESET|ENOTFOUND)/i.test(
          msg
        );
      const isRetryable = isRetryableStatus || isNetworky;
      if (!isRetryable || attempt === maxAttempts) throw err;
      const base = isRateLimit ? 12000 : 3500;
      const backoff = base * Math.pow(2, attempt - 1);
      const jitter = randInt(250, 1250);
      await sleep(backoff + jitter);
    }
  }
  throw lastErr || new Error("fetch failed");
}

async function ddgSearch({ query, kl }) {
  const md = await fetchDdgMarkdownWithRetries({ query, kl });
  return extractLinkedInUrlsFromMarkdown(md);
}

function splitLinkedInUrls(urls) {
  const normalized = uniq(urls.map(normalizeLinkedInUrl).filter(Boolean));
  const company = [];
  const people = [];
  for (const u of normalized) {
    const lower = u.toLowerCase();
    if (lower.includes("/company/")) company.push(u);
    else if (lower.includes("/in/") || lower.includes("/pub/")) people.push(u);
  }
  return {
    linkedin_company_urls: company,
    linkedin_people_urls: people,
  };
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
  const hasCompany =
    (Array.isArray(social.linkedin_company_urls) && social.linkedin_company_urls.length > 0) ||
    (typeof social.linkedin_company_url === "string" && social.linkedin_company_url.trim());
  const hasPeople = Array.isArray(social.linkedin_people_urls) && social.linkedin_people_urls.length > 0;
  return hasCompany && hasPeople;
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
  const websiteMap = new Map();
  if (Array.isArray(companiesJson)) {
    for (const row of companiesJson) {
      const slug = normalizeSlug(row?.slug);
      const name = String(row?.name || "").trim();
      const website = String(row?.website || "").trim();
      if (slug && name) nameMap.set(slug, name);
      if (slug && website) websiteMap.set(slug, website);
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
      const website = websiteUrl || websiteMap.get(slug) || "";
      const domain = getDomainFromWebsite(website);
      return { slug, name, website, domain, socialLinks };
    })
    .filter((c) => c.slug && c.website)
    .filter((c) => (only.size > 0 ? only.has(c.slug) : true))
    .filter((c) => (args.force ? true : !shouldSkipExisting({ socialLinks: c.socialLinks, force: false })));

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
        kl: args.kl,
        queries: {},
        counts: {},
        status: "ok",
      };

      try {
        const domainHint = c.domain ? ` ${c.domain}` : "";

        const qCompany = `site:linkedin.com/company \"${c.name}\"${domainHint} India`;
        const qPeople1 = `site:linkedin.com/in ${c.name} founder India`;
        const qPeople2 = `site:linkedin.com/in ${c.name} \"co-founder\" India`;

        audit.queries = { company: qCompany, people: [qPeople1, qPeople2] };

        const current = isRecord(c.socialLinks) ? c.socialLinks : {};
        const existingCompanyUrls = uniq([
          ...(Array.isArray(current.linkedin_company_urls) ? current.linkedin_company_urls : []),
          ...(typeof current.linkedin_company_url === "string" && current.linkedin_company_url.trim()
            ? [current.linkedin_company_url.trim()]
            : []),
        ])
          .map(normalizeLinkedInUrl)
          .filter(Boolean);

        const existingPeopleUrls = uniq(
          (Array.isArray(current.linkedin_people_urls) ? current.linkedin_people_urls : [])
            .map(normalizeLinkedInUrl)
            .filter(Boolean)
        );

        const needCompany = existingCompanyUrls.length === 0;
        const needPeople = existingPeopleUrls.length === 0;

        const found = [];
        if (needCompany) {
          const companyRes = await ddgSearch({ query: qCompany, kl: args.kl });
          found.push(...companyRes);
          await sleep(randInt(args.minDelayMs, args.maxDelayMs));
        }

        let peopleRes1 = [];
        if (needPeople) {
          peopleRes1 = await ddgSearch({ query: qPeople1, kl: args.kl });
          found.push(...peopleRes1);
          await sleep(randInt(args.minDelayMs, args.maxDelayMs));
        }

        let peopleRes2 = [];
        if (needPeople) {
          const splitFirst = splitLinkedInUrls(peopleRes1);
          if (splitFirst.linkedin_people_urls.length === 0) {
            peopleRes2 = await ddgSearch({ query: qPeople2, kl: args.kl });
            found.push(...peopleRes2);
          }
        }

        const split = splitLinkedInUrls(found);
        const companyUrls = split.linkedin_company_urls.slice(0, 5);
        let peopleUrls = split.linkedin_people_urls.slice(0, 8);
        let rawUrlCount = uniq(found).length;

        // Fallback: if we didn't get any people URLs, try a domain-specific search once.
        if (peopleUrls.length === 0 && c.domain) {
          const qPeople3 = `site:linkedin.com/in ${c.domain} ${c.name} founder`;
          audit.queries.people.push(qPeople3);
          await sleep(randInt(args.minDelayMs, args.maxDelayMs));
          const peopleRes3 = await ddgSearch({ query: qPeople3, kl: args.kl });
          rawUrlCount = uniq([...found, ...peopleRes3]).length;
          const split2 = splitLinkedInUrls(peopleRes3);
          peopleUrls = uniq([...peopleUrls, ...split2.linkedin_people_urls]).slice(0, 8);
        }

        audit.counts = {
          raw_urls: rawUrlCount,
          linkedin_company_urls: companyUrls.length,
          linkedin_people_urls: peopleUrls.length,
        };

        const next = {
          ...current,
          linkedin_company_urls: uniq([...existingCompanyUrls, ...companyUrls]),
          linkedin_people_urls: uniq([...existingPeopleUrls, ...peopleUrls]),
          linkedin_ddg_audit: audit,
        };

        // Keep older single-value field in sync if absent.
        if (!next.linkedin_company_url && next.linkedin_company_urls.length > 0) {
          next.linkedin_company_url = next.linkedin_company_urls[0];
        }

        const out = {
          company_slug: c.slug,
          company_name: c.name,
          website_url: c.website,
          linkedin_company_urls: next.linkedin_company_urls,
          linkedin_people_urls: next.linkedin_people_urls,
          audit,
        };
        writeOut(args.outDir, `${c.slug}.linkedin-ddg.json`, out);

        if (args.dryRun) {
          console.log(`[dry-run] ${c.slug}: company=${companyUrls.length} people=${peopleUrls.length}`);
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
            linkedin_people_urls: next.linkedin_people_urls,
          },
        });
        console.log(`[ok] ${c.slug}: company=${companyUrls.length} people=${peopleUrls.length}`);
        ok += 1;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[fail] ${c.slug}: ${msg}`);
        failed += 1;

        const current = isRecord(c.socialLinks) ? c.socialLinks : {};
        const next = {
          ...current,
          linkedin_ddg_audit: {
            audited_at: auditedAt,
            kl: args.kl,
            status: "error",
            error: msg,
          },
        };

        writeOut(args.outDir, `${c.slug}.linkedin-ddg.json`, {
          company_slug: c.slug,
          company_name: c.name,
          website_url: c.website,
          linkedin_company_urls: [],
          linkedin_people_urls: [],
          audit: next.linkedin_ddg_audit,
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
            // ignore secondary patch failures
          }
        }
      }
    },
  });

  // Derive skipped based on eligibility vs processed totals.
  const totalEligible = rows
    .map((r) => {
      const slug = normalizeSlug(r?.company_slug);
      const websiteUrl = String(r?.website_url || "").trim();
      return { slug, websiteUrl, socialLinks: r?.social_links };
    })
    .filter((c) => c.slug && c.websiteUrl)
    .filter((c) => (only.size > 0 ? only.has(c.slug) : true))
    .filter((c) => (args.force ? true : !shouldSkipExisting({ socialLinks: c.socialLinks, force: false }))).length;

  skipped = Math.max(0, totalEligible - ok - failed);
  console.log(`\nDone. ok=${ok} skipped=${skipped} failed=${failed} (started ${startedAt})`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
