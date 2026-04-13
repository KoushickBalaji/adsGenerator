#!/usr/bin/env node
/**
 * Generate and upsert `company_prompt_profiles` rows using an agentic web-search workflow
 * via the OpenAI Responses API.
 *
 * Requirements:
 * - Node.js 18+ (Node 20+ recommended)
 * - Env vars:
 *   - OPENAI_API_KEY
 *   - (optional) OPENAI_BASE_URL (defaults to https://api.openai.com/v1)
 *   - SUPABASE_URL
 *   - SUPABASE_SERVICE_ROLE_KEY
 *
 * Usage:
 *   node scripts/company-prompt-profiles-research.mjs --companies scripts/companies.example.json --dry-run
 *   node scripts/company-prompt-profiles-research.mjs --companies scripts/companies.example.json --out-dir scripts/out
 *   node scripts/company-prompt-profiles-research.mjs --companies scripts/companies.example.json --company <slug>
 *   node scripts/company-prompt-profiles-research.mjs --companies scripts/companies.example.json --force
 */

import fs from "node:fs";
import path from "node:path";

function usage(message) {
  if (message) console.error(message);
  console.error(
      [
        "",
        "Usage:",
        "  node scripts/company-prompt-profiles-research.mjs --companies <path> [options]",
        "",
        "Options:",
        "  --companies <path>        JSON file: [{ slug, name, website, notes? }, ...]",
        "  --company <slug>          Only run for this company (repeatable)",
        "  --model <id>              Research model (default: gpt-5.2)",
        "  --extract-model <id>      JSON extraction model (default: gpt-5.2)",
        "  --reasoning-effort <lvl>  Research reasoning effort: none|low|medium|high|xhigh (default: xhigh)",
        "  --extract-reasoning-effort <lvl>  Extract reasoning effort (default: none)",
      "  --max-tool-calls <n>      Limit web search tool calls (default: 60)",
      "  --out-dir <path>          Write raw + parsed outputs per company",
      "  --skip-research           Skip web research and reuse <slug>.deep-research.txt from --out-dir",
        "  --apply-style             Use the model-suggested prompt_style (default: false => always jewellery_generic_v1)",
      "  --force                   Overwrite existing rows (default: skip existing)",
      "  --dry-run                 Do not write to Supabase (still writes files if --out-dir is set)",
      "  -h, --help                Show help",
      "",
      "Env vars:",
      "  OPENAI_API_KEY, OPENAI_BASE_URL, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY",
      "",
    ].join("\n")
  );
  process.exit(1);
}

  function parseArgs(argv) {
    const args = {
      companiesPath: null,
      companySlugs: [],
      model: "gpt-5.2",
      extractModel: "gpt-5.2",
      reasoningEffort: "xhigh",
      extractReasoningEffort: "none",
      maxToolCalls: 60,
      outDir: null,
      skipResearch: false,
      applyStyle: false,
      force: false,
      dryRun: false,
    };

  const validEfforts = new Set(["none", "low", "medium", "high", "xhigh"]);

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--companies") {
      args.companiesPath = argv[i + 1] ?? null;
      i++;
      continue;
    }
    if (a === "--company") {
      const slug = String(argv[i + 1] ?? "").trim();
      if (slug) args.companySlugs.push(slug);
      i++;
      continue;
    }
    if (a === "--model") {
      args.model = String(argv[i + 1] ?? "").trim() || args.model;
      i++;
      continue;
    }
    if (a === "--extract-model") {
      args.extractModel = String(argv[i + 1] ?? "").trim() || args.extractModel;
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
    if (a === "--extract-reasoning-effort") {
      const effort = String(argv[i + 1] ?? "").trim().toLowerCase();
      if (!validEfforts.has(effort)) usage("Invalid --extract-reasoning-effort");
      args.extractReasoningEffort = effort;
      i++;
      continue;
    }
    if (a === "--max-tool-calls") {
      const n = Number(argv[i + 1]);
      if (!Number.isFinite(n) || n <= 0) usage("Invalid --max-tool-calls");
      args.maxToolCalls = Math.max(1, Math.min(200, Math.trunc(n)));
      i++;
      continue;
    }
    if (a === "--out-dir") {
      args.outDir = argv[i + 1] ?? null;
      i++;
      continue;
    }
    if (a === "--skip-research") {
      args.skipResearch = true;
      continue;
    }
    if (a === "--apply-style") {
      args.applyStyle = true;
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

function readJsonFile(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  return JSON.parse(raw);
}

function ensureDir(dir) {
  if (!dir) return;
  const resolved = path.resolve(dir);
  if (!fs.existsSync(resolved)) fs.mkdirSync(resolved, { recursive: true });
}

function writeOutFile(outDir, filename, contents) {
  if (!outDir) return;
  ensureDir(outDir);
  const full = path.join(path.resolve(outDir), filename);
  fs.writeFileSync(full, contents, "utf8");
}

function normalizeSlug(slug) {
  return String(slug || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/(^-|-$)/g, "");
}

function normalizeWebsite(website) {
  const raw = String(website || "").trim();
  if (!raw) return "";
  if (/^https?:\/\//i.test(raw)) return raw.replace(/\/+$/, "");
  return `https://${raw}`.replace(/\/+$/, "");
}

function getOutputText(response) {
  if (response && typeof response.output_text === "string" && response.output_text.trim()) {
    return response.output_text.trim();
  }

  const output = response?.output;
  if (!Array.isArray(output)) return "";

  const chunks = [];
  for (const item of output) {
    if (!item || typeof item !== "object") continue;
    if (item.type !== "message") continue;
    const content = Array.isArray(item.content) ? item.content : [];
    for (const part of content) {
      if (part?.type === "output_text" && typeof part.text === "string") {
        chunks.push(part.text);
      }
    }
  }

  return chunks.join("\n").trim();
}

async function openaiFetchJson({ apiKey, baseUrl, method, pathname, body }) {
  const url = `${baseUrl.replace(/\/+$/, "")}${pathname.startsWith("/") ? "" : "/"}${pathname}`;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`OpenAI API error ${res.status}: ${text}`);
  }

  if (!text.trim()) return null;
  return JSON.parse(text);
}

  async function createDeepResearchResponse({ 
      apiKey, 
      baseUrl, 
      model, 
      input, 
      maxToolCalls, 
      reasoningEffort, 
    }) { 
      const body = { 
        model, 
        input, 
        background: true, 
        max_tool_calls: maxToolCalls, 
        tool_choice: "required", 
        tools: [{ type: "web_search" }], 
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
  let lastLoggedAt = 0; 
  let lastStatus = ""; 
  while (true) { 
    const res = await retrieveResponse({ apiKey, baseUrl, id }); 
    const status = String(res?.status ?? ""); 
 
    const now = Date.now(); 
    const elapsedSec = Math.max(0, Math.round((now - started) / 1000)); 
    const shouldLog = 
      status !== lastStatus || (now - lastLoggedAt >= 15_000 && ["queued", "in_progress"].includes(status)); 
    if (shouldLog && status) { 
      console.log(`[research] status: ${status} (elapsed ${Math.floor(elapsedSec / 60)}m${String(elapsedSec % 60).padStart(2, "0")}s)`); 
      lastLoggedAt = now; 
      lastStatus = status; 
    } 
    if (status === "failed") { 
      const err = res?.error; 
      const code = typeof err?.code === "string" ? err.code : "unknown_error"; 
      const message = 
        typeof err?.message === "string" && err.message.trim() 
          ? err.message.trim()
          : "OpenAI response failed with no error message.";
      throw new Error(`OpenAI response ${id} failed (${code}): ${message}`);
    }

    if (status === "cancelled") {
      throw new Error(`OpenAI response ${id} was cancelled.`);
    }

    if (status && !["queued", "in_progress"].includes(status)) return res; 
 
    if (Date.now() - started > timeoutMs) { 
      throw new Error(`Timed out waiting for response ${id} (last status: ${status || "unknown"})`); 
    } 
 
    await sleep(delay);
    delay = Math.min(8000, Math.round(delay * 1.4));
  }
}

function profileSchema() {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      prompt_style: {
        type: "string",
        enum: ["jewellery_generic_v1", "jewellery_businesswoman_v1", "product_only_v1"],
      },
      requires_ambassador: { type: "boolean" },
      creative_brief: { type: "string" },
      social_links: {
        type: "object",
        additionalProperties: false,
        properties: {
          instagram: { type: "string" },
          youtube: { type: "string" },
          facebook: { type: "string" },
          tiktok: { type: "string" },
          pinterest: { type: "string" },
          linkedin: { type: "string" },
          x: { type: "string" },
        },
        required: [
          "instagram",
          "youtube",
          "facebook",
          "tiktok",
          "pinterest",
          "linkedin",
          "x",
        ],
      },
      variables: {
        type: "object",
        additionalProperties: false,
        properties: {
          vibe_keywords: { type: "array", items: { type: "string" } },
          target_audience: { type: "string" },
          character_archetype: { type: "string" },
          settings: { type: "array", items: { type: "string" } },
          wardrobe_directions: { type: "array", items: { type: "string" } },
          color_palette: { type: "array", items: { type: "string" } },
          lighting: { type: "string" },
          camera: { type: "string" },
          pacing: { type: "string" },
          materials_focus: { type: "string" },
          design_motifs: { type: "array", items: { type: "string" } },
          marketing_formats: { type: "array", items: { type: "string" } },
          ambassador_notes: { type: "string" },
          do: { type: "array", items: { type: "string" } },
          avoid: { type: "array", items: { type: "string" } },
        },
        required: [
          "vibe_keywords",
          "target_audience",
          "character_archetype",
          "settings",
          "wardrobe_directions",
          "color_palette",
          "lighting",
          "camera",
          "pacing",
          "materials_focus",
          "design_motifs",
          "marketing_formats",
          "ambassador_notes",
          "do",
          "avoid",
        ],
      },
    },
    required: [
      "prompt_style",
      "requires_ambassador",
      "creative_brief",
      "social_links",
      "variables",
    ],
    };
}

  async function extractProfileJson({ 
    apiKey, 
    baseUrl, 
    model, 
    company, 
    deepResearchText, 
    reasoningEffort, 
  }) { 
    const system = 
      "You convert a brand research report into a concise creative profile for generating AI video ads.\n" + 
      "Constraints:\n" + 
      "- Focus on jewellery ads only.\n" + 
      "- Output MUST be valid JSON matching the provided schema.\n" + 
      "- Make the output brand-distinct: incorporate concrete cues from the research (materials, motifs, persona, settings, lighting, camera language, pacing, and marketing formats). Avoid generic boilerplate.\n" + 
      "- Ensure the creative brief includes at least 6 distinct cues traceable to the research (do not reuse the same 'sunlit apartment / mirror moment' brief unless strongly supported).\n" + 
      "- Do NOT include the brand name, product names, or slogans in creative_brief or variables.\n" + 
      "- It is OK if the brand name appears inside social_links URLs.\n" + 
      "- Do NOT include names of celebrity ambassadors/creators; describe the talent strategy generically (e.g., 'actor-led', 'creator-led', 'celebrity capsule').\n" + 
      "- Do NOT mention text overlays, logos, voiceover, music, or sound.\n" + 
      "- Keep creative_brief compact (<= 1200 characters).\n" + 
      "- Keep arrays short (<= 8 items each).\n" + 
      "- For social_links, output official profile URLs when found; otherwise use an empty string. If the report includes a social-profiles JSON line, prefer using it."; 

  const user =
    `Company context:\n` +
    `- slug: ${company.slug}\n` +
    `- name: ${company.name}\n` +
    `- website: ${company.website}\n\n` +
    `Research report:\n` +
    deepResearchText;

    const body = {
      model,
      input: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "company_prompt_profile",
          strict: true,
          schema: profileSchema(),
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

function sanitizeProfile({ company, profile, applyStyle }) {
  const safeStyle = applyStyle
    ? profile.prompt_style
    : "jewellery_generic_v1";

    // In this demo, "requires_ambassador" means "include a human model persona".
    // Even if the brand doesn't have a dedicated ambassador, we still use a generic character element.
    const safeRequiresAmbassador = safeStyle !== "product_only_v1";

    const cleanUrl = (value) => {
      const raw = typeof value === "string" ? value.trim() : "";
      if (!raw) return "";
      try {
        const url = new URL(raw);
        const keys = Array.from(url.searchParams.keys());
        for (const key of keys) {
          if (key.toLowerCase().startsWith("utm_")) url.searchParams.delete(key);
        }
        url.hash = "";
        return url.toString().replace(/\/+$/, "");
      } catch {
        return raw;
      }
    };

    const stripBrand = (value) => {
      if (typeof value !== "string") return value;
      const name = String(company.name || "").trim();
    if (!name) return value.trim();
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return value.replace(new RegExp(escaped, "gi"), "the brand").trim();
  };

  const cleanArray = (arr) =>
    Array.isArray(arr)
      ? arr
          .map((v) => (typeof v === "string" ? stripBrand(v) : String(v)))
          .map((v) => v.trim())
          .filter(Boolean)
          .slice(0, 8)
      : undefined;

    const variables = profile.variables && typeof profile.variables === "object" ? profile.variables : {};
    const socialLinks =
      profile.social_links && typeof profile.social_links === "object"
        ? profile.social_links
        : {};

  const out = {
      prompt_style: safeStyle,
      requires_ambassador: safeRequiresAmbassador,
      creative_brief: stripBrand(String(profile.creative_brief || "")).slice(0, 1500),
      social_links: {
        instagram: cleanUrl(socialLinks.instagram),
        youtube: cleanUrl(socialLinks.youtube),
        facebook: cleanUrl(socialLinks.facebook),
        tiktok: cleanUrl(socialLinks.tiktok),
        pinterest: cleanUrl(socialLinks.pinterest),
        linkedin: cleanUrl(socialLinks.linkedin),
        x: cleanUrl(socialLinks.x),
      },
      variables: {
        ...(variables.vibe_keywords ? { vibe_keywords: cleanArray(variables.vibe_keywords) } : {}),
        ...(variables.target_audience ? { target_audience: stripBrand(String(variables.target_audience)) } : {}),
        ...(variables.character_archetype
          ? { character_archetype: stripBrand(String(variables.character_archetype)) }
          : {}),
        ...(variables.settings ? { settings: cleanArray(variables.settings) } : {}),
        ...(variables.wardrobe_directions
          ? { wardrobe_directions: cleanArray(variables.wardrobe_directions) }
          : {}),
        ...(variables.color_palette ? { color_palette: cleanArray(variables.color_palette) } : {}),
        ...(variables.lighting ? { lighting: stripBrand(String(variables.lighting)) } : {}),
        ...(variables.camera ? { camera: stripBrand(String(variables.camera)) } : {}),
        ...(variables.pacing ? { pacing: stripBrand(String(variables.pacing)) } : {}),
        ...(variables.materials_focus
          ? { materials_focus: stripBrand(String(variables.materials_focus)) }
          : {}),
        ...(variables.design_motifs ? { design_motifs: cleanArray(variables.design_motifs) } : {}),
        ...(variables.marketing_formats
          ? { marketing_formats: cleanArray(variables.marketing_formats) }
          : {}),
        ...(variables.ambassador_notes
          ? { ambassador_notes: stripBrand(String(variables.ambassador_notes)) }
          : {}),
        ...(variables.do ? { do: cleanArray(variables.do) } : {}),
        ...(variables.avoid ? { avoid: cleanArray(variables.avoid) } : {}),
      },
    };

  if (!out.creative_brief.trim()) out.creative_brief = "";
  return out;
}

async function supabaseGetExisting({ supabaseUrl, supabaseKey, slug }) {
  const url =
    `${supabaseUrl.replace(/\/+$/, "")}` +
    `/rest/v1/company_prompt_profiles?company_slug=eq.${encodeURIComponent(slug)}&select=company_slug`;

  const res = await fetch(url, {
    method: "GET",
    headers: {
      apikey: supabaseKey,
      Authorization: `Bearer ${supabaseKey}`,
    },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Supabase GET error ${res.status}: ${text}`);
  }
  const json = text.trim() ? JSON.parse(text) : [];
  return Array.isArray(json) && json.length > 0;
}

async function supabaseUpsert({ supabaseUrl, supabaseKey, row }) {
  const url =
    `${supabaseUrl.replace(/\/+$/, "")}` +
    `/rest/v1/company_prompt_profiles?on_conflict=company_slug`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      apikey: supabaseKey,
      Authorization: `Bearer ${supabaseKey}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates",
    },
    body: JSON.stringify(row),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Supabase upsert error ${res.status}: ${text}`);
  }
}

function buildDeepResearchPrompt(company) {
  return [
    `Research the jewellery brand behind this website: ${company.website}`,
    company.notes ? `Notes: ${company.notes}` : "",
    "",
    "Goal:",
    "Generate a brand-specific creative profile for a 10-second AI-generated video ad showing ONE jewellery product (ring/necklace/earrings/bracelet) worn by a model persona in a lifestyle setting.",
    "",
    "Research tasks (be concrete, not generic):",
    "- Find the OFFICIAL social profiles for the brand (Instagram, YouTube, Facebook, TikTok, Pinterest, LinkedIn, X). Prefer links from the brand's website header/footer; otherwise use reputable sources. Include direct URLs.",
    "- Identify 3-6 specific marketing/campaign references (lookbooks, campaign pages, YouTube ads, Instagram reels/posts, press articles describing campaigns). Include direct links and cite them.",
    "- Determine whether the brand uses celebrity ambassadors / creators / influencer partnerships. If you can find a clear named ambassador/collab, list it with citations. If not, explicitly say no clear public ambassador found (and what you checked).",
    "- Infer brand vibe/aesthetic grounded in evidence: modern vs traditional, minimal vs ornate, playful vs serious, premium cues, cultural/festive cues, typical color palettes, lighting styles, common settings, and editing pace.",
    "- Infer target audience and the most common character archetypes used in their marketing (age range, vibe, gender signals).",
    "- Translate findings into practical video-prompt guidance: scenes, wardrobe directions, camera feel, pacing, and 'avoid' guidance.",
    "- IMPORTANT: Your Creative brief must include at least 6 brand-distinct cues derived from the evidence (materials focus, design motifs, setting/wardrobe palette, lighting/camera language, and an ad-format cue). Do not reuse a generic brief.",
    "",
    "Hard constraints for the final creative guidance we will use later:",
    "- The Creative brief and Prompt variables must be brand-neutral: do not include the brand name, product names, taglines, or slogans.",
    "- Do not recommend text overlays, logos, voiceover, music, or sound.",
    "",
    "Output format:",
    "1) Evidence bullets (10-20) with inline citations (URLs).",
    "2) Social profiles as a JSON object on its own line, like: {\"instagram\":\"...\",\"youtube\":\"...\",...} (use empty string if unknown).",
    "3) Marketing/campaign references (3-8 bullets) with inline citations (URLs).",
    "4) Ambassador / creator strategy (2-6 bullets) with inline citations (URLs).",
    "5) A compact 'Creative brief' section (<= ~1200 characters) that is brand-neutral (no brand name).",
    "6) A compact 'Prompt variables' section as plain JSON: keys must include vibe_keywords, target_audience, character_archetype, settings, wardrobe_directions, color_palette, lighting, camera, pacing, materials_focus, design_motifs, marketing_formats, ambassador_notes, do, avoid.",
  ].filter(Boolean).join("\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.companiesPath) usage("Missing --companies");
  if (args.skipResearch && !args.outDir) usage("--skip-research requires --out-dir");

  const openaiApiKey = process.env.OPENAI_API_KEY;
  if (!openaiApiKey) usage("Missing OPENAI_API_KEY in environment.");

  const openaiBaseUrl = process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1";

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey) {
    usage("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in environment.");
  }

  const companiesPath = path.resolve(args.companiesPath);
  const companiesRaw = readJsonFile(companiesPath);
  const companies = Array.isArray(companiesRaw) ? companiesRaw : [];
  if (companies.length === 0) usage("Companies file has no entries.");

  const only = new Set(args.companySlugs.map(normalizeSlug).filter(Boolean));

    console.log(`Research model: ${args.model}`);
    console.log(`Extract model: ${args.extractModel}`);
    console.log(`Reasoning effort: ${args.reasoningEffort}`);
    console.log(`Extract reasoning effort: ${args.extractReasoningEffort}`);
    console.log(`Max tool calls: ${args.maxToolCalls}`);
  console.log(`Apply suggested style: ${args.applyStyle ? "yes" : "no (force generic)"}`);
  console.log(`Write to Supabase: ${args.dryRun ? "no (dry-run)" : "yes"}`);
  if (args.outDir) console.log(`Out dir: ${path.resolve(args.outDir)}`);

  let okCount = 0;
  let skipCount = 0;
  let failCount = 0;

  for (const item of companies) {
    try {
      const slug = normalizeSlug(item?.slug ?? "");
      if (!slug) continue;
      if (only.size > 0 && !only.has(slug)) continue;

      const company = {
        slug,
        name: String(item?.name ?? slug).trim() || slug,
        website: normalizeWebsite(item?.website ?? ""),
        notes: item?.notes ? String(item.notes) : "",
      };

      if (!company.website) {
        console.warn(`\n[skip] ${slug}: missing website`);
        skipCount += 1;
        continue;
      }

      console.log(`\n=== ${company.slug} ===`);

      const exists = await supabaseGetExisting({
        supabaseUrl,
        supabaseKey,
        slug: company.slug,
      });

      if (exists && !args.force) {
        console.log("[skip] Row already exists (use --force to overwrite).");
        skipCount += 1;
        continue;
      }

      let deepText = "";
      if (args.skipResearch) {
        const existingPath = path.join(path.resolve(args.outDir), `${company.slug}.deep-research.txt`);
        if (!fs.existsSync(existingPath)) {
          throw new Error(`Missing research file: ${existingPath}`);
        }
        deepText = fs.readFileSync(existingPath, "utf8").trim();
      } else {
        const deepPrompt = buildDeepResearchPrompt(company);
          const deepRes = await createDeepResearchResponse({
            apiKey: openaiApiKey,
            baseUrl: openaiBaseUrl,
            model: args.model,
            input: deepPrompt,
            maxToolCalls: args.maxToolCalls,
            reasoningEffort: args.reasoningEffort,
          });

        const deepId = deepRes?.id;
        if (!deepId) throw new Error("Research response missing id");
        console.log(`[research] started: ${deepId}`);

        const deepFinal = await pollUntilComplete({
          apiKey: openaiApiKey,
          baseUrl: openaiBaseUrl,
          id: deepId,
          timeoutMs: 45 * 60 * 1000,
        });

        deepText = getOutputText(deepFinal);
        if (!deepText) throw new Error("Research response missing output text");

        writeOutFile(args.outDir, `${company.slug}.deep-research.txt`, deepText);
      }

      let extracted;
      try {
          extracted = await extractProfileJson({
            apiKey: openaiApiKey,
            baseUrl: openaiBaseUrl,
            model: args.extractModel,
            company,
            deepResearchText: deepText,
            reasoningEffort: args.extractReasoningEffort,
          });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[extract] failed with model "${args.extractModel}": ${msg}`);
        console.warn('[extract] retrying with fallback model "gpt-4o-2024-08-06"...');
          extracted = await extractProfileJson({
            apiKey: openaiApiKey,
            baseUrl: openaiBaseUrl,
            model: "gpt-4o-2024-08-06",
            company,
            deepResearchText: deepText,
            reasoningEffort: "none",
          });
      }

      const extractedText = getOutputText(extracted);
      if (!extractedText) throw new Error("Extraction response missing output text");

      let profile;
      try {
        profile = JSON.parse(extractedText);
      } catch {
        throw new Error(`Extraction did not return JSON: ${extractedText.slice(0, 200)}...`);
      }

      const clean = sanitizeProfile({ company, profile, applyStyle: args.applyStyle });

      writeOutFile(args.outDir, `${company.slug}.profile.json`, JSON.stringify(clean, null, 2));

        const row = {
          company_slug: company.slug,
          website_url: company.website,
          prompt_style: clean.prompt_style,
          requires_ambassador: clean.requires_ambassador,
          creative_brief: clean.creative_brief || null,
          social_links: clean.social_links ?? {},
          variables: clean.variables ?? {},
        };

      if (args.dryRun) {
        console.log("[dry-run] Would upsert:", JSON.stringify(row, null, 2));
        okCount += 1;
        continue;
      }

      await supabaseUpsert({ supabaseUrl, supabaseKey, row });
      console.log("[ok] Upserted prompt profile.");
      okCount += 1;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[fail] ${String(item?.slug ?? "unknown")}: ${msg}`);
      failCount += 1;
      continue;
    }
  }

  console.log(`\nDone. ok=${okCount} skipped=${skipCount} failed=${failCount}`);
  if (failCount > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
