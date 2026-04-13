#!/usr/bin/env node
/**
 * Find LinkedIn entry points for each company:
 * - LinkedIn company page URL (if found)
 * - Founder/CXO LinkedIn profile URLs (best-effort, from web search results)
 *
 * Writes results to `public.company_prompt_profiles.social_links`:
 * - linkedin_company_url: string
 * - linkedin_people: [{ name, title, linkedin_url, role, confidence, match_reason, sources }]
 * - linkedin_people_audit: { audited_at, model, max_tool_calls, status, errors? }
 *
 * Notes:
 * - Uses OpenAI Responses API + `web_search` tool.
 * - We do not scrape LinkedIn pages directly; we only use public search results.
 *
 * Requirements:
 * - Node.js 18+ (Node 20+ recommended)
 * - Env vars (or .env.local):
 *   - OPENAI_API_KEY
 *   - (optional) OPENAI_BASE_URL (defaults to https://api.openai.com/v1)
 *   - SUPABASE_URL
 *   - SUPABASE_SERVICE_ROLE_KEY
 *
 * Usage:
 *   node scripts/company-linkedin-people-research.mjs --out-dir scripts/out/linkedin
 *   node scripts/company-linkedin-people-research.mjs --company giva --company bluestone
 *   node scripts/company-linkedin-people-research.mjs --concurrency 3 --max-tool-calls 8 --reasoning-effort low
 *   node scripts/company-linkedin-people-research.mjs --force
 *   node scripts/company-linkedin-people-research.mjs --dry-run
 */

import fs from "node:fs";
import path from "node:path";

function usage(message) {
  if (message) console.error(message);
  console.error(
    [
      "",
      "Usage:",
      "  node scripts/company-linkedin-people-research.mjs [options]",
      "",
      "Options:",
      "  --company <slug>          Only run for this company (repeatable)",
      "  --companies <path>        Optional JSON file to map slug->name: [{ slug, name, website }, ...]",
      "  --out-dir <path>          Write per-company JSON outputs",
      "  --model <id>              Model (default: gpt-5.2)",
      "  --reasoning-effort <lvl>  none|low|medium|high|xhigh (default: low)",
      "  --max-tool-calls <n>      Max web_search tool calls per company (default: 8)",
      "  --concurrency <n>         Parallel companies (default: 3)",
      "  --force                   Overwrite existing linkedin_people (default: skip if already present)",
      "  --dry-run                 Do not write to Supabase",
      "  -h, --help                Show help",
      "",
      "Env vars (or .env.local):",
      "  OPENAI_API_KEY, OPENAI_BASE_URL, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY",
      "",
    ].join("\n")
  );
  process.exit(1);
}

function parseArgs(argv) {
  const args = {
    companySlugs: [],
    companiesPath: null,
    outDir: null,
    model: "gpt-5.2",
    reasoningEffort: "low",
    maxToolCalls: 8,
    concurrency: 3,
    force: false,
    dryRun: false,
  };

  const validEfforts = new Set(["none", "low", "medium", "high", "xhigh"]);

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--company") {
      const slug = String(argv[i + 1] ?? "").trim();
      if (slug) args.companySlugs.push(slug.toLowerCase());
      i++;
      continue;
    }
    if (a === "--companies") {
      args.companiesPath = argv[i + 1] ?? null;
      i++;
      continue;
    }
    if (a === "--out-dir") {
      args.outDir = argv[i + 1] ?? null;
      i++;
      continue;
    }
    if (a === "--model") {
      args.model = String(argv[i + 1] ?? "").trim() || args.model;
      i++;
      continue;
    }
    if (a === "--reasoning-effort") {
      const effort = String(argv[i + 1] ?? "").trim().toLowerCase();
      if (!validEfforts.has(effort)) usage("Invalid --reasoning-effort");
      args.reasoningEffort = effort;
      i++;
      continue;
    }
    if (a === "--max-tool-calls") {
      const n = Number(argv[i + 1]);
      if (!Number.isFinite(n) || n <= 0) usage("Invalid --max-tool-calls");
      args.maxToolCalls = Math.max(1, Math.min(30, Math.trunc(n)));
      i++;
      continue;
    }
    if (a === "--concurrency") {
      const n = Number(argv[i + 1]);
      if (!Number.isFinite(n) || n <= 0) usage("Invalid --concurrency");
      args.concurrency = Math.max(1, Math.min(8, Math.trunc(n)));
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

  return args;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function normalizeSlug(raw) {
  const s = String(raw || "").trim().toLowerCase();
  if (!s) return "";
  return s
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function linkedinSchema() {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      linkedin_company_url: { type: "string" },
      linkedin_people: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            name: { type: "string" },
            title: { type: "string" },
            role: { type: "string", enum: ["founder", "cofounder", "ceo", "cxo", "owner", "director", "unknown"] },
            linkedin_url: { type: "string" },
            confidence: { type: "number" },
            match_reason: { type: "string" },
            sources: { type: "array", items: { type: "string" } },
          },
          required: ["name", "title", "role", "linkedin_url", "confidence", "match_reason", "sources"],
        },
      },
      notes: { type: "string" },
    },
    required: ["linkedin_company_url", "linkedin_people", "notes"],
  };
}

function parseUrlBase(baseUrl) {
  const u = String(baseUrl || "https://api.openai.com/v1").trim() || "https://api.openai.com/v1";
  return u.replace(/\/+$/, "");
}

async function openaiFetchJson({ apiKey, baseUrl, method, pathname, body }) {
  const url = new URL(parseUrlBase(baseUrl) + pathname);
  const res = await fetch(url.toString(), {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`OpenAI ${method} ${pathname} failed (${res.status}): ${text.slice(0, 500)}`);
  }
  return text.trim() ? JSON.parse(text) : {};
}

async function retrieveResponse({ apiKey, baseUrl, id }) {
  return openaiFetchJson({
    apiKey,
    baseUrl,
    method: "GET",
    pathname: `/responses/${encodeURIComponent(id)}`,
  });
}

async function pollUntilComplete({ apiKey, baseUrl, id, timeoutMs }) {
  const started = Date.now();
  let delay = 2000;
  while (true) {
    const res = await retrieveResponse({ apiKey, baseUrl, id });
    const status = String(res?.status ?? "");
    if (status === "failed") {
      const err = res?.error;
      const code = typeof err?.code === "string" ? err.code : "unknown_error";
      const message =
        typeof err?.message === "string" && err.message.trim()
          ? err.message.trim()
          : "OpenAI response failed with no error message.";
      throw new Error(`OpenAI response ${id} failed (${code}): ${message}`);
    }
    if (status === "cancelled") throw new Error(`OpenAI response ${id} was cancelled.`);
    if (status && !["queued", "in_progress"].includes(status)) return res;
    if (Date.now() - started > timeoutMs) {
      throw new Error(`Timed out waiting for response ${id} (last status: ${status || "unknown"})`);
    }
    await sleep(delay);
    delay = Math.min(8000, Math.round(delay * 1.35));
  }
}

function getOutputText(responseJson) {
  const out = responseJson?.output;
  if (!Array.isArray(out)) return "";
  const parts = [];
  for (const item of out) {
    const content = item?.content;
    if (!Array.isArray(content)) continue;
    for (const c of content) {
      if (c?.type === "output_text" && typeof c.text === "string") parts.push(c.text);
      if (c?.type === "text" && typeof c.text === "string") parts.push(c.text);
    }
  }
  return parts.join("\n").trim();
}

function shouldSkipExistingLinkedInPeople(socialLinks) {
  if (!isRecord(socialLinks)) return false;
  const people = socialLinks.linkedin_people;
  if (!Array.isArray(people)) return false;
  return people.length > 0;
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

async function supabasePatchCompany({ supabaseUrl, supabaseKey, slug, patch }) {
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
  if (!res.ok) throw new Error(`Supabase PATCH error ${res.status}: ${text}`);
}

function readCompaniesMap(companiesPath) {
  if (!companiesPath) return new Map();
  const filePath = path.resolve(companiesPath);
  if (!fs.existsSync(filePath)) return new Map();
  const json = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (!Array.isArray(json)) return new Map();
  const map = new Map();
  for (const item of json) {
    const slug = normalizeSlug(item?.slug ?? "");
    if (!slug) continue;
    const name = String(item?.name ?? "").trim();
    if (name) map.set(slug, name);
  }
  return map;
}

function buildPrompt({ slug, name, websiteUrl }) {
  const system =
    "You are a careful researcher.\n" +
    "Task: find LinkedIn entry points for outreach.\n" +
    "Rules:\n" +
    "- Use web_search results only; do NOT browse/scrape LinkedIn directly.\n" +
    "- Prefer the official LinkedIn company page and 1-3 key people (founder/CEO/CXO).\n" +
    "- Only include a person if the result clearly matches the company (title/experience/snippet mentions the company or the company website domain).\n" +
    "- If unsure, omit rather than guess.\n" +
    "- Output MUST match the JSON schema.\n" +
    "- Keep linkedin_people to <= 3 entries.\n" +
    "- confidence is 0.0–1.0.\n";

  const user =
    `Company:\n` +
    `- slug: ${slug}\n` +
    `- name: ${name}\n` +
    `- website: ${websiteUrl}\n\n` +
    `Find:\n` +
    `1) LinkedIn company page URL (linkedin.com/company/...)\n` +
    `2) Founder/CXO LinkedIn profile URLs (linkedin.com/in/...) if clearly matching.\n` +
    `\n` +
    `Return empty strings/arrays when not found.\n`;

  return { system, user };
}

async function createLinkedInResponse({
  apiKey,
  baseUrl,
  model,
  reasoningEffort,
  maxToolCalls,
  prompt,
}) {
  const body = {
    model,
    input: [
      { role: "system", content: prompt.system },
      { role: "user", content: prompt.user },
    ],
    background: true,
    max_tool_calls: maxToolCalls,
    tool_choice: "required",
    tools: [{ type: "web_search" }],
    text: {
      format: {
        type: "json_schema",
        name: "linkedin_people",
        strict: true,
        schema: linkedinSchema(),
      },
    },
  };

  if (String(model || "").startsWith("gpt-5") && reasoningEffort && reasoningEffort !== "none") {
    body.reasoning = { effort: reasoningEffort };
  }

  return openaiFetchJson({
    apiKey,
    baseUrl,
    method: "POST",
    pathname: "/responses",
    body,
  });
}

function sanitizeResult(result) {
  const linkedinCompanyUrl =
    typeof result?.linkedin_company_url === "string" ? result.linkedin_company_url.trim() : "";
  const rawPeople = Array.isArray(result?.linkedin_people) ? result.linkedin_people : [];
  const people = rawPeople
    .map((p) => ({
      name: typeof p?.name === "string" ? p.name.trim() : "",
      title: typeof p?.title === "string" ? p.title.trim() : "",
      role: typeof p?.role === "string" ? p.role : "unknown",
      linkedin_url: typeof p?.linkedin_url === "string" ? p.linkedin_url.trim() : "",
      confidence: Number.isFinite(p?.confidence) ? Math.max(0, Math.min(1, Number(p.confidence))) : 0,
      match_reason: typeof p?.match_reason === "string" ? p.match_reason.trim() : "",
      sources: Array.isArray(p?.sources) ? p.sources.map((s) => String(s)).slice(0, 6) : [],
    }))
    .filter((p) => p.name && p.linkedin_url)
    .slice(0, 3);

  const notes = typeof result?.notes === "string" ? result.notes.trim() : "";
  return { linkedin_company_url: linkedinCompanyUrl, linkedin_people: people, notes };
}

async function runPool({ items, concurrency, worker }) {
  const executing = new Set();
  const results = [];
  let idx = 0;

  const enqueue = async () => {
    while (idx < items.length && executing.size < concurrency) {
      const item = items[idx++];
      const p = (async () => worker(item))()
        .then((res) => results.push(res))
        .catch((err) => results.push({ __error: String(err), item }))
        .finally(() => executing.delete(p));
      executing.add(p);
    }
    if (executing.size === 0) return;
    await Promise.race(executing);
    return enqueue();
  };

  await enqueue();
  await Promise.all(executing);
  return results;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dotEnv = readDotEnvLocal();
  const openaiApiKey = getRequiredEnv(dotEnv, "OPENAI_API_KEY");
  const openaiBaseUrl = process.env.OPENAI_BASE_URL || dotEnv.OPENAI_BASE_URL || "https://api.openai.com/v1";
  const supabaseUrl = getRequiredEnv(dotEnv, "SUPABASE_URL");
  const supabaseKey = getRequiredEnv(dotEnv, "SUPABASE_SERVICE_ROLE_KEY");

  const nameMap = readCompaniesMap(args.companiesPath || "scripts/companies.india.json");
  const only = new Set(args.companySlugs.map(normalizeSlug).filter(Boolean));

  console.log(`Out dir: ${args.outDir ? path.resolve(args.outDir) : "(none)"}`);
  console.log(`Write to Supabase: ${args.dryRun ? "no (dry-run)" : "yes"}`);
  console.log(`Model: ${args.model} (reasoning=${args.reasoningEffort}, max_tool_calls=${args.maxToolCalls})`);
  console.log(`Concurrency: ${args.concurrency}`);

  const rows = await supabaseListCompanies({ supabaseUrl, supabaseKey });
  const companies = rows
    .map((row) => {
      const slug = normalizeSlug(row?.company_slug ?? "");
      const websiteUrl = typeof row?.website_url === "string" ? row.website_url.trim() : "";
      const socialLinks = row?.social_links;
      const name = nameMap.get(slug) || slug;
      return { slug, name, websiteUrl, socialLinks };
    })
    .filter((c) => c.slug && c.websiteUrl)
    .filter((c) => (only.size > 0 ? only.has(c.slug) : true))
    .filter((c) => (args.force ? true : !shouldSkipExistingLinkedInPeople(c.socialLinks)));

  let ok = 0;
  let skipped = 0;
  let failed = 0;

  const startedAt = new Date().toISOString();
  const results = await runPool({
    items: companies,
    concurrency: args.concurrency,
    worker: async (c) => {
      const auditBase = {
        audited_at: new Date().toISOString(),
        model: args.model,
        reasoning_effort: args.reasoningEffort,
        max_tool_calls: args.maxToolCalls,
      };

      try {
        const prompt = buildPrompt({ slug: c.slug, name: c.name, websiteUrl: c.websiteUrl });
        const res = await createLinkedInResponse({
          apiKey: openaiApiKey,
          baseUrl: openaiBaseUrl,
          model: args.model,
          reasoningEffort: args.reasoningEffort,
          maxToolCalls: args.maxToolCalls,
          prompt,
        });
        const id = res?.id;
        if (!id) throw new Error("OpenAI response missing id");

        const final = await pollUntilComplete({
          apiKey: openaiApiKey,
          baseUrl: openaiBaseUrl,
          id,
          timeoutMs: 4 * 60 * 1000,
        });

        const text = getOutputText(final);
        if (!text) throw new Error("OpenAI response missing output text");

        let parsed;
        try {
          parsed = JSON.parse(text);
        } catch {
          throw new Error(`Model output was not JSON: ${text.slice(0, 200)}...`);
        }

        const clean = sanitizeResult(parsed);
        const out = {
          company_slug: c.slug,
          company_name: c.name,
          website_url: c.websiteUrl,
          ...clean,
          audited_at: auditBase.audited_at,
          response_id: id,
        };

        writeOut(args.outDir, `${c.slug}.linkedin.json`, out);

        const current = isRecord(c.socialLinks) ? c.socialLinks : {};
        const next = {
          ...current,
          linkedin_company_url: clean.linkedin_company_url,
          linkedin_people: clean.linkedin_people,
          linkedin_people_notes: clean.notes,
          linkedin_people_audit: { ...auditBase, status: "ok" },
        };

        if (args.dryRun) {
          console.log(`[dry-run] ${c.slug}: people=${clean.linkedin_people.length}`);
          ok += 1;
          return { slug: c.slug, ok: true };
        }

        await supabasePatchCompany({
          supabaseUrl,
          supabaseKey,
          slug: c.slug,
          patch: { social_links: next },
        });

        console.log(`[ok] ${c.slug}: people=${clean.linkedin_people.length}`);
        ok += 1;
        return { slug: c.slug, ok: true };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[fail] ${c.slug}: ${msg}`);

        const current = isRecord(c.socialLinks) ? c.socialLinks : {};
        const next = {
          ...current,
          linkedin_people_audit: { ...auditBase, status: "error", error: msg },
        };
        writeOut(args.outDir, `${c.slug}.linkedin.json`, {
          company_slug: c.slug,
          company_name: c.name,
          website_url: c.websiteUrl,
          linkedin_company_url: "",
          linkedin_people: [],
          notes: "",
          audited_at: auditBase.audited_at,
          error: msg,
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
            // ignore secondary patch errors
          }
        }

        failed += 1;
        return { slug: c.slug, ok: false, error: msg };
      }
    },
  });

  // Determine skipped count based on eligibility and processed totals.
  const totalEligible = rows
    .map((row) => {
      const slug = normalizeSlug(row?.company_slug ?? "");
      const websiteUrl = typeof row?.website_url === "string" ? row.website_url.trim() : "";
      const socialLinks = row?.social_links;
      return { slug, websiteUrl, socialLinks };
    })
    .filter((c) => c.slug && c.websiteUrl)
    .filter((c) => (only.size > 0 ? only.has(c.slug) : true))
    .filter((c) => (args.force ? true : !shouldSkipExistingLinkedInPeople(c.socialLinks))).length;

  skipped = Math.max(0, totalEligible - ok - failed);

  console.log(`\nDone. ok=${ok} skipped=${skipped} failed=${failed} (started ${startedAt})`);
  // eslint-disable-next-line no-unused-vars
  for (const _r of results) {}
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

