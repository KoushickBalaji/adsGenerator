#!/usr/bin/env node
/**
 * Report how many reference images were stored on the latest completed run per company.
 *
 * Reads companies from `public.company_prompt_profiles` and then fetches the most recent
 * completed `video_runs` row (with output_video_url) for each company.
 *
 * Requirements:
 * - Node.js 18+
 * - SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (env vars or .env.local)
 */

import fs from "node:fs";
import path from "node:path";

function usage(message) {
  if (message) console.error(message);
  console.error(
    [
      "",
      "Usage:",
      "  node scripts/report-reference-images.mjs [options]",
      "",
      "Options:",
      "  --company <slug>   Only report for this company (repeatable)",
      "  --limit <n>        Runs to show per company (default: 1, max: 5)",
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
  const args = {
    companySlugs: [],
    limit: 1,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--company") {
      const slug = String(argv[i + 1] ?? "").trim().toLowerCase();
      if (slug) args.companySlugs.push(slug);
      i++;
      continue;
    }
    if (a === "--limit") {
      const n = Number(argv[i + 1]);
      if (!Number.isFinite(n) || n <= 0) usage("Invalid --limit");
      args.limit = Math.max(1, Math.min(5, Math.trunc(n)));
      i++;
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

async function fetchJson(url, { method = "GET", headers, body } = {}) {
  const res = await fetch(url, {
    method,
    headers,
    body: body != null ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = text.trim() ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { ok: res.ok, status: res.status, text, json };
}

async function listCompanies({ restBase, headers }) {
  const url =
    `${restBase}/company_prompt_profiles` +
    `?select=company_slug,website_url,has_ecommerce` +
    `&order=company_slug.asc`;
  const res = await fetchJson(url, { headers });
  if (!res.ok) {
    throw new Error(`Failed to list companies: ${res.status} ${res.text}`);
  }
  return Array.isArray(res.json) ? res.json : [];
}

async function listRecentCompletedRuns({ restBase, headers, slug, limit }) {
  const url =
    `${restBase}/video_runs` +
    `?select=id,company_slug,input_images,created_at,source_url,product_title,output_video_url` +
    `&company_slug=eq.${encodeURIComponent(slug)}` +
    `&status=eq.completed` +
    `&output_video_url=not.is.null` +
    `&order=created_at.desc` +
    `&limit=${limit}`;

  const res = await fetchJson(url, { headers });
  if (!res.ok) {
    throw new Error(`Failed to fetch video_runs for ${slug}: ${res.status} ${res.text}`);
  }
  return Array.isArray(res.json) ? res.json : [];
}

function countImages(run) {
  if (!run || !Array.isArray(run.input_images)) return 0;
  return run.input_images.filter((u) => typeof u === "string" && u.trim()).length;
}

function asHostname(url) {
  try {
    return new URL(String(url)).hostname;
  } catch {
    return "";
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dotEnv = readDotEnvLocal();
  const supabaseUrl = getRequiredEnv(dotEnv, "SUPABASE_URL").replace(/\/+$/, "");
  const supabaseKey = getRequiredEnv(dotEnv, "SUPABASE_SERVICE_ROLE_KEY");

  const restBase = `${supabaseUrl}/rest/v1`;
  const headers = {
    apikey: supabaseKey,
    authorization: `Bearer ${supabaseKey}`,
  };

  const only = new Set(args.companySlugs);
  const companies = (await listCompanies({ restBase, headers }))
    .map((r) => ({
      slug: String(r.company_slug || "").trim().toLowerCase(),
      hasEcommerce: typeof r.has_ecommerce === "boolean" ? r.has_ecommerce : null,
      websiteUrl: typeof r.website_url === "string" ? r.website_url.trim() : null,
    }))
    .filter((c) => c.slug)
    .filter((c) => (only.size > 0 ? only.has(c.slug) : true))
    .filter((c) => c.hasEcommerce !== false);

  console.log(`Companies: ${companies.length}`);
  console.log("company_slug\trun_id\timages\tfirst_image_host\tsource_url");

  for (const company of companies) {
    const runs = await listRecentCompletedRuns({
      restBase,
      headers,
      slug: company.slug,
      limit: args.limit,
    });
    if (runs.length === 0) {
      console.log(`${company.slug}\t(none)\t0\t\t`);
      continue;
    }
    for (const run of runs) {
      const n = countImages(run);
      const firstHost = n > 0 ? asHostname(run.input_images[0]) : "";
      console.log(
        [
          company.slug,
          String(run.id || ""),
          String(n),
          firstHost,
          String(run.source_url || ""),
        ].join("\t")
      );
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

