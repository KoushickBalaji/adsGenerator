#!/usr/bin/env node
/**
 * Smoke-test + seed History by generating 1-2 videos per company.
 *
 * For each shoppable company in `public.company_prompt_profiles`, this:
 * - reads `scrape_profile.discovered_product_url` as a representative product URL
 * - calls Supabase Edge Function `create-run`
 * - polls `video_runs` and triggers `refresh-run` until completed/failed
 *
 * Requirements:
 * - Node.js 18+ (Node 20+ recommended)
 * - Env vars (or .env.local):
 *   - SUPABASE_URL
 *   - SUPABASE_SERVICE_ROLE_KEY
 */

import fs from "node:fs";
import path from "node:path";

function usage(message) {
  if (message) console.error(message);
  console.error(
    [
      "",
      "Usage:",
      "  node scripts/company-smoke-generate.mjs [options]",
      "",
      "Options:",
      "  --company <slug>            Only run for this company (repeatable)",
      "  --videos-per-company <n>    Target completed videos per company (default: 1)",
      "  --out-dir <path>            Write a JSON report file",
      "  --skip-existing             Skip companies that already have >= target completed runs (default: true)",
      "  --timeout-minutes <n>       Timeout per run (default: 14)",
      "  --poll-seconds <n>          Poll interval (default: 20)",
      "  --dry-run                   Do not create runs (still prints plan)",
      "  -h, --help                  Show help",
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
    videosPerCompany: 1,
    outDir: null,
    skipExisting: true,
    timeoutMinutes: 14,
    pollSeconds: 20,
    dryRun: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--company") {
      const slug = String(argv[i + 1] ?? "").trim().toLowerCase();
      if (slug) args.companySlugs.push(slug);
      i++;
      continue;
    }
    if (a === "--videos-per-company") {
      const n = Number(argv[i + 1]);
      if (!Number.isFinite(n) || n <= 0) usage("Invalid --videos-per-company");
      args.videosPerCompany = Math.max(1, Math.min(5, Math.trunc(n)));
      i++;
      continue;
    }
    if (a === "--out-dir") {
      args.outDir = argv[i + 1] ?? null;
      i++;
      continue;
    }
    if (a === "--skip-existing") {
      args.skipExisting = true;
      continue;
    }
    if (a === "--no-skip-existing") {
      args.skipExisting = false;
      continue;
    }
    if (a === "--timeout-minutes") {
      const n = Number(argv[i + 1]);
      if (!Number.isFinite(n) || n <= 0) usage("Invalid --timeout-minutes");
      args.timeoutMinutes = Math.max(2, Math.min(60, Math.trunc(n)));
      i++;
      continue;
    }
    if (a === "--poll-seconds") {
      const n = Number(argv[i + 1]);
      if (!Number.isFinite(n) || n <= 0) usage("Invalid --poll-seconds");
      args.pollSeconds = Math.max(5, Math.min(120, Math.trunc(n)));
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

function ensureDir(dirPath) {
  if (!dirPath) return;
  fs.mkdirSync(path.resolve(dirPath), { recursive: true });
}

function writeOut(outDir, filename, json) {
  if (!outDir) return;
  ensureDir(outDir);
  fs.writeFileSync(path.join(path.resolve(outDir), filename), JSON.stringify(json, null, 2));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function asNonEmptyString(value) {
  const s = typeof value === "string" ? value.trim() : "";
  return s ? s : null;
}

async function listCompanies({ restBase, headers }) {
  const url =
    `${restBase}/company_prompt_profiles` +
    `?select=company_slug,website_url,has_ecommerce,scrape_profile` +
    `&order=company_slug.asc`;
  const res = await fetchJson(url, { headers });
  if (!res.ok) throw new Error(`Supabase GET company_prompt_profiles ${res.status}: ${res.text}`);
  return Array.isArray(res.json) ? res.json : [];
}

async function countCompletedRuns({ restBase, headers, slug, limit }) {
  const url =
    `${restBase}/video_runs` +
    `?company_slug=eq.${encodeURIComponent(slug)}` +
    `&status=eq.completed` +
    `&output_video_url=not.is.null` +
    `&select=id` +
    `&limit=${encodeURIComponent(limit)}`;
  const res = await fetchJson(url, { headers });
  if (!res.ok) {
    throw new Error(`Supabase GET video_runs ${res.status}: ${res.text}`);
  }
  return Array.isArray(res.json) ? res.json.length : 0;
}

async function getRun({ restBase, headers, runId }) {
  const url =
    `${restBase}/video_runs` +
    `?id=eq.${encodeURIComponent(runId)}` +
    `&select=id,company_slug,status,error_message,output_video_url,provider_job_id,created_at,updated_at`;
  const res = await fetchJson(url, { headers });
  if (!res.ok) throw new Error(`Supabase GET video_runs ${res.status}: ${res.text}`);
  const arr = Array.isArray(res.json) ? res.json : [];
  return arr[0] ?? null;
}

async function callCreateRun({ functionsBase, headers, companySlug, url }) {
  const res = await fetchJson(`${functionsBase}/create-run`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: { url, companySlug },
  });
  if (!res.ok) {
    const msg = (res.json && res.json.error) || res.text;
    throw new Error(`create-run ${res.status}: ${msg}`);
  }
  const runId = res.json?.runId;
  if (!runId || typeof runId !== "string") {
    throw new Error(`create-run missing runId: ${JSON.stringify(res.json)}`);
  }
  return runId;
}

async function callRefreshRun({ functionsBase, headers, companySlug, runId }) {
  const res = await fetchJson(`${functionsBase}/refresh-run`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: { runId, companySlug },
  });
  // refresh-run is best-effort; ignore errors and rely on DB polling
  return res.ok;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dotEnv = readDotEnvLocal();
  const supabaseUrl = getRequiredEnv(dotEnv, "SUPABASE_URL").replace(/\/+$/, "");
  const supabaseKey = getRequiredEnv(dotEnv, "SUPABASE_SERVICE_ROLE_KEY");

  const restBase = `${supabaseUrl}/rest/v1`;
  const functionsBase = `${supabaseUrl}/functions/v1`;
  const headers = { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` };

  const only = new Set(args.companySlugs);

  console.log(`Target completed videos/company: ${args.videosPerCompany}`);
  console.log(`Skip existing: ${args.skipExisting ? "yes" : "no"}`);
  console.log(`Timeout/run: ${args.timeoutMinutes} min`);
  console.log(`Poll: ${args.pollSeconds}s`);
  console.log(`Write to Supabase: ${args.dryRun ? "no (dry-run)" : "yes"}`);
  console.log(`Out dir: ${args.outDir ? path.resolve(args.outDir) : "(none)"}`);

  const companiesRaw = await listCompanies({ restBase, headers });
  const companies = companiesRaw
    .map((r) => ({
      slug: String(r.company_slug || "").trim().toLowerCase(),
      websiteUrl: asNonEmptyString(r.website_url),
      hasEcommerce: typeof r.has_ecommerce === "boolean" ? r.has_ecommerce : null,
      scrapeProfile: r.scrape_profile && typeof r.scrape_profile === "object" ? r.scrape_profile : {},
    }))
    .filter((c) => c.slug)
    .filter((c) => (only.size > 0 ? only.has(c.slug) : true))
    .filter((c) => c.websiteUrl)
    .filter((c) => c.hasEcommerce !== false);

  const startedAt = new Date().toISOString().replace(/[:.]/g, "-");
  const report = {
    started_at: new Date().toISOString(),
    videos_per_company: args.videosPerCompany,
    skip_existing: args.skipExisting,
    timeout_minutes: args.timeoutMinutes,
    poll_seconds: args.pollSeconds,
    results: [],
  };

  for (const company of companies) {
    const discoveredProductUrl = asNonEmptyString(company.scrapeProfile?.discovered_product_url);
    if (!discoveredProductUrl) {
      console.log(`\n[skip] ${company.slug}: missing scrape_profile.discovered_product_url`);
      report.results.push({
        company_slug: company.slug,
        status: "skipped",
        reason: "missing_discovered_product_url",
      });
      continue;
    }

    let existing = 0;
    try {
      existing = await countCompletedRuns({
        restBase,
        headers,
        slug: company.slug,
        limit: args.videosPerCompany,
      });
    } catch (err) {
      console.warn(
        `[warn] ${company.slug}: failed to count existing runs: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }

    if (args.skipExisting && existing >= args.videosPerCompany) {
      console.log(`\n[skip] ${company.slug}: already has ${existing} completed run(s)`);
      report.results.push({
        company_slug: company.slug,
        status: "skipped",
        reason: "already_seeded",
        completed_runs: existing,
      });
      continue;
    }

    const toMake = Math.max(0, args.videosPerCompany - existing);
    console.log(`\n=== ${company.slug} (need ${toMake}) ===`);

    for (let i = 0; i < toMake; i++) {
      const runLabel = `${company.slug}#${existing + i + 1}/${args.videosPerCompany}`;
      const item = {
        company_slug: company.slug,
        index: existing + i + 1,
        product_url: discoveredProductUrl,
        run_id: null,
        status: "started",
        output_video_url: null,
        error: null,
        started_at: new Date().toISOString(),
        finished_at: null,
      };

      try {
        if (args.dryRun) {
          console.log(`[dry-run] Would create-run for ${runLabel}: ${discoveredProductUrl}`);
          item.status = "dry_run";
          item.finished_at = new Date().toISOString();
          report.results.push(item);
          continue;
        }

        console.log(`[run] create-run ${runLabel}`);
        const runId = await callCreateRun({
          functionsBase,
          headers,
          companySlug: company.slug,
          url: discoveredProductUrl,
        });
        item.run_id = runId;

        const timeoutAt = Date.now() + args.timeoutMinutes * 60 * 1000;
        while (Date.now() < timeoutAt) {
          const run = await getRun({ restBase, headers, runId });
          const status = String(run?.status || "");
          const outputVideoUrl = asNonEmptyString(run?.output_video_url);
          const errorMessage = asNonEmptyString(run?.error_message);

          if (status === "completed" && outputVideoUrl) {
            item.status = "completed";
            item.output_video_url = outputVideoUrl;
            item.finished_at = new Date().toISOString();
            break;
          }

          if (status === "failed") {
            item.status = "failed";
            item.error = errorMessage || "failed";
            item.finished_at = new Date().toISOString();
            break;
          }

          await callRefreshRun({
            functionsBase,
            headers,
            companySlug: company.slug,
            runId,
          });
          await sleep(args.pollSeconds * 1000);
        }

        if (!item.finished_at) {
          item.status = "timeout";
          item.error = `Timed out after ${args.timeoutMinutes} minutes`;
          item.finished_at = new Date().toISOString();
        }

        if (item.status === "completed") {
          console.log(`[ok] ${runLabel}: ${item.output_video_url}`);
        } else {
          console.warn(`[fail] ${runLabel}: ${item.status} ${item.error || ""}`.trim());
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        item.status = "error";
        item.error = msg;
        item.finished_at = new Date().toISOString();
        console.warn(`[error] ${runLabel}: ${msg}`);
      } finally {
        report.results.push(item);
        writeOut(args.outDir, `smoke-${startedAt}.json`, report);
      }
    }
  }

  report.finished_at = new Date().toISOString();
  writeOut(args.outDir, `smoke-${startedAt}.json`, report);
  console.log("\nDone.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

