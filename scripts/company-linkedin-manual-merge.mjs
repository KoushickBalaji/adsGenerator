#!/usr/bin/env node
/**
 * Merge manually-collected LinkedIn URLs into `public.company_prompt_profiles.social_links`.
 *
 * Intended workflow:
 * 1) Collect LinkedIn URLs via manual research (or web.run in chat)
 * 2) Save them as JSON
 * 3) Run this script to merge into Supabase
 *
 * Input JSON format:
 * [
 *   {
 *     "slug": "melorra",
 *     "linkedin_company_urls": ["https://www.linkedin.com/company/melorra"],
 *     "linkedin_people_urls": ["https://www.linkedin.com/in/..."],
 *     "notes": "optional"
 *   }
 * ]
 *
 * Writes:
 * - social_links.linkedin_company_urls (merged/uniq)
 * - social_links.linkedin_people_urls (merged/uniq)
 * - social_links.linkedin_manual_audit: { audited_at, source, notes? }
 */

import fs from "node:fs";
import path from "node:path";

function usage(message) {
  if (message) console.error(message);
  console.error(
    [
      "",
      "Usage:",
      "  node scripts/company-linkedin-manual-merge.mjs --in <path> [--dry-run]",
      "",
      "Options:",
      "  --in <path>      Input JSON file (see header comment)",
      "  --dry-run        Do not write to Supabase",
      "  -h, --help       Show help",
      "",
      "Env vars (or .env.local):",
      "  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY",
      "",
    ].join("\n")
  );
  process.exit(1);
}

function parseArgs(argv) {
  const args = { inPath: null, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--in") {
      args.inPath = String(argv[i + 1] ?? "").trim() || null;
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
  if (!args.inPath) usage("Missing --in <path>");
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
    u.pathname = u.pathname.replace(/\/+$/, "");
    return u.toString();
  } catch {
    return "";
  }
}

async function supabaseGetCompany({ supabaseUrl, supabaseKey, slug }) {
  const url =
    `${supabaseUrl.replace(/\/+$/, "")}` +
    `/rest/v1/company_prompt_profiles?select=company_slug,social_links&company_slug=eq.${encodeURIComponent(slug)}`;
  const res = await fetch(url, {
    method: "GET",
    headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Supabase GET error ${res.status}: ${text}`);
  const json = text.trim() ? JSON.parse(text) : [];
  if (!Array.isArray(json) || json.length === 0) return null;
  return json[0];
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

  const inPath = path.resolve(args.inPath);
  const raw = fs.readFileSync(inPath, "utf8");
  const items = JSON.parse(raw);
  if (!Array.isArray(items)) throw new Error("Input JSON must be an array");

  console.log(`Write to Supabase: ${args.dryRun ? "no (dry-run)" : "yes"}`);

  let ok = 0;
  let skipped = 0;
  let failed = 0;

  for (const item of items) {
    const slug = normalizeSlug(item?.slug);
    if (!slug) continue;

    const companyUrls = uniq((item?.linkedin_company_urls || []).map(normalizeLinkedInUrl).filter(Boolean));
    const peopleUrls = uniq((item?.linkedin_people_urls || []).map(normalizeLinkedInUrl).filter(Boolean));
    const notes = typeof item?.notes === "string" ? item.notes.trim() : "";

    if (companyUrls.length === 0 && peopleUrls.length === 0) {
      skipped += 1;
      continue;
    }

    try {
      const row = await supabaseGetCompany({ supabaseUrl, supabaseKey, slug });
      if (!row) {
        console.warn(`[skip] ${slug}: not found in company_prompt_profiles`);
        skipped += 1;
        continue;
      }
      const current = isRecord(row?.social_links) ? row.social_links : {};
      const next = {
        ...current,
        linkedin_company_urls: uniq([...(Array.isArray(current.linkedin_company_urls) ? current.linkedin_company_urls : []), ...companyUrls]),
        linkedin_people_urls: uniq([...(Array.isArray(current.linkedin_people_urls) ? current.linkedin_people_urls : []), ...peopleUrls]),
        linkedin_manual_audit: {
          audited_at: new Date().toISOString(),
          source: path.basename(inPath),
          ...(notes ? { notes } : {}),
        },
      };
      if (!next.linkedin_company_url && next.linkedin_company_urls.length > 0) {
        next.linkedin_company_url = next.linkedin_company_urls[0];
      }

      if (args.dryRun) {
        console.log(`[dry-run] ${slug}: company+=${companyUrls.length} people+=${peopleUrls.length}`);
        ok += 1;
        continue;
      }

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
      console.log(`[ok] ${slug}: company+=${companyUrls.length} people+=${peopleUrls.length}`);
      ok += 1;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[fail] ${slug}: ${msg}`);
      failed += 1;
    }
  }

  console.log(`\\nDone. ok=${ok} skipped=${skipped} failed=${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
