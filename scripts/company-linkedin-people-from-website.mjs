#!/usr/bin/env node
/**
 * Derive LinkedIn company + people profile URLs from the already-scraped website social links.
 *
 * Source:
 * - `company_prompt_profiles.social_links.linkedin` (array of LinkedIn URLs discovered on-site by
 *   `company-contacts-extract.mjs`)
 *
 * Writes:
 * - social_links.linkedin_company_urls: string[]   (linkedin.com/company/...)
 * - social_links.linkedin_people_urls: string[]    (linkedin.com/in/... or /pub/...)
 * - social_links.linkedin_derived_audit: { derived_at, source }
 *
 * This does NOT do web search.
 *
 * Usage:
 *   node scripts/company-linkedin-people-from-website.mjs
 *   node scripts/company-linkedin-people-from-website.mjs --company bluestone --company melorra
 *   node scripts/company-linkedin-people-from-website.mjs --dry-run
 */

import fs from "node:fs";
import path from "node:path";

function usage(message) {
  if (message) console.error(message);
  console.error(
    [
      "",
      "Usage:",
      "  node scripts/company-linkedin-people-from-website.mjs [options]",
      "",
      "Options:",
      "  --company <slug>   Only run for this company (repeatable)",
      "  --dry-run          Do not write to Supabase",
      "  -h, --help         Show help",
      "",
      "Env vars (or .env.local):",
      "  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY",
      "",
    ].join("\n")
  );
  process.exit(1);
}

function parseArgs(argv) {
  const args = { companySlugs: [], dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--company") {
      const slug = String(argv[i + 1] ?? "").trim();
      if (slug) args.companySlugs.push(slug.toLowerCase());
      i++;
      continue;
    }
    if (a === "--dry-run") {
      args.dryRun = true;
      continue;
    }
    if (a === "-h" || a === "--help") usage();
    usage(`Unknown argument: ${a}`);
  }
  return args;
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
    if (!/linkedin\.com$/i.test(u.hostname) && !/linkedin\.com$/i.test(u.hostname.replace(/^www\./i, ""))) return "";
    u.protocol = "https:";
    u.hash = "";
    // strip common tracking params
    u.search = "";
    return u.toString();
  } catch {
    return "";
  }
}

function uniq(list) {
  return Array.from(new Set((list || []).map(String).map((s) => s.trim()).filter(Boolean)));
}

function splitLinkedInLinks(links) {
  const normalized = uniq(links.map(normalizeLinkedInUrl).filter(Boolean));
  const company = [];
  const people = [];
  const other = [];
  for (const u of normalized) {
    const lower = u.toLowerCase();
    if (lower.includes("/company/")) company.push(u);
    else if (lower.includes("/in/") || lower.includes("/pub/")) people.push(u);
    else other.push(u);
  }
  return {
    linkedin_company_urls: company,
    linkedin_people_urls: people,
    linkedin_other_urls: other,
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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dotEnv = readDotEnvLocal();
  const supabaseUrl = getRequiredEnv(dotEnv, "SUPABASE_URL");
  const supabaseKey = getRequiredEnv(dotEnv, "SUPABASE_SERVICE_ROLE_KEY");

  const only = new Set(args.companySlugs.map(normalizeSlug).filter(Boolean));
  console.log(`Write to Supabase: ${args.dryRun ? "no (dry-run)" : "yes"}`);

  const rows = await supabaseListCompanies({ supabaseUrl, supabaseKey });
  let ok = 0;
  let skipped = 0;
  let failed = 0;

  for (const row of rows) {
    const slug = normalizeSlug(row?.company_slug ?? "");
    if (!slug) continue;
    if (only.size > 0 && !only.has(slug)) continue;
    const websiteUrl = typeof row?.website_url === "string" ? row.website_url.trim() : "";
    if (!websiteUrl) continue;

    const social = isRecord(row?.social_links) ? row.social_links : {};
    const linkedinList = Array.isArray(social.linkedin) ? social.linkedin : [];
    if (linkedinList.length === 0) {
      skipped += 1;
      continue;
    }

    const split = splitLinkedInLinks(linkedinList);

    const next = {
      ...social,
      linkedin_company_urls: split.linkedin_company_urls,
      linkedin_people_urls: split.linkedin_people_urls,
      linkedin_derived_audit: {
        derived_at: new Date().toISOString(),
        source: "company-contacts-extract.mjs social_links.linkedin",
      },
    };
    if (!next.linkedin_company_url && next.linkedin_company_urls.length > 0) {
      next.linkedin_company_url = next.linkedin_company_urls[0];
    }

    if (args.dryRun) {
      console.log(`[dry-run] ${slug}: company=${split.linkedin_company_urls.length} people=${split.linkedin_people_urls.length}`);
      ok += 1;
      continue;
    }

    try {
      await supabasePatchCompany({
        supabaseUrl,
        supabaseKey,
        slug,
        patch: {
          social_links: next,
          ...(next.linkedin_company_url ? { linkedin_company_url: next.linkedin_company_url } : {}),
          linkedin_people_urls: next.linkedin_people_urls,
        },
      });
      ok += 1;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[fail] ${slug}: ${msg}`);
      failed += 1;
    }
  }

  console.log(`\nDone. ok=${ok} skipped=${skipped} failed=${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
