import type { PromptPolicy, PromptStyle } from "./geminiPrompt.ts";
import type { ScraperAdapter } from "./scraper.ts";

export type CompanyPromptProfileOverrides = {
  promptStyle?: PromptStyle;
  requiresAmbassador?: boolean;
  creativeBrief?: string;
  variables?: Record<string, unknown>;
  klingElementIds?: string[];
  scrapeAdapter?: ScraperAdapter;
  ambassadorReferenceImageUrl?: string;
};

type SupabaseClientLike = {
  from: (table: string) => {
    select: (columns: string) => {
      eq: (column: string, value: string) => {
        maybeSingle: () => Promise<{ data: unknown; error: unknown }>;
      };
    };
  };
};

const KNOWN_PROMPT_STYLES: PromptStyle[] = [
  "jewellery_businesswoman_v1",
  "jewellery_generic_v1",
  "product_only_v1",
];

const KNOWN_SCRAPER_ADAPTERS: ScraperAdapter[] = ["bluestone", "generic", "shopify"];

function isPromptStyle(value: unknown): value is PromptStyle {
  return (
    typeof value === "string" &&
    (KNOWN_PROMPT_STYLES as readonly string[]).includes(value)
  );
}

function isScraperAdapter(value: unknown): value is ScraperAdapter {
  return (
    typeof value === "string" &&
    (KNOWN_SCRAPER_ADAPTERS as readonly string[]).includes(value)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function toNonEmptyStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const out = value
    .map((v) => (typeof v === "string" ? v : String(v)))
    .map((v) => v.trim())
    .filter(Boolean);
  return out.length > 0 ? out : null;
}

export function resolvePromptPolicy(
  base: PromptPolicy,
  overrides?: CompanyPromptProfileOverrides | null
): { policy: PromptPolicy; creativeBrief: string | null; variables: Record<string, unknown> } {
  const style = overrides?.promptStyle ?? base.style;
  const requiresAmbassador =
    typeof overrides?.requiresAmbassador === "boolean"
      ? overrides.requiresAmbassador
      : base.requiresAmbassador;

  const creativeBrief =
    typeof overrides?.creativeBrief === "string" && overrides.creativeBrief.trim()
      ? overrides.creativeBrief.trim()
      : null;

  const variables = isRecord(overrides?.variables) ? overrides.variables : {};

  return {
    policy: { style, requiresAmbassador },
    creativeBrief,
    variables,
  };
}

export async function getCompanyPromptProfileOverrides(
  supabase: SupabaseClientLike,
  companySlug: string
): Promise<CompanyPromptProfileOverrides | null> {
  const slug = String(companySlug || "").trim().toLowerCase();
  if (!slug) return null;

  const { data, error } = await supabase
    .from("company_prompt_profiles")
    .select(
      "prompt_style, requires_ambassador, creative_brief, variables, kling_element_ids, scrape_profile, ambassador_reference_image_url"
    )
    .eq("company_slug", slug)
    .maybeSingle();

  if (error) {
    console.warn("[prompt_profile] Failed to load company_prompt_profiles:", error);
    return null;
  }

  if (!data) return null;
  if (!isRecord(data)) return null;

  const out: CompanyPromptProfileOverrides = {};

  if (isPromptStyle(data.prompt_style)) {
    out.promptStyle = data.prompt_style;
  }

  if (typeof data.requires_ambassador === "boolean") {
    out.requiresAmbassador = data.requires_ambassador;
  }

  if (typeof data.creative_brief === "string" && data.creative_brief.trim()) {
    out.creativeBrief = data.creative_brief.trim();
  }

  if (isRecord(data.variables)) {
    out.variables = data.variables;
  }

  const elementIds = toNonEmptyStringArray(data.kling_element_ids);
  if (elementIds) {
    out.klingElementIds = elementIds;
  }

  if (isRecord(data.scrape_profile) && isScraperAdapter(data.scrape_profile.adapter)) {
    out.scrapeAdapter = data.scrape_profile.adapter;
  }

  if (
    typeof data.ambassador_reference_image_url === "string" &&
    data.ambassador_reference_image_url.trim()
  ) {
    out.ambassadorReferenceImageUrl = data.ambassador_reference_image_url.trim();
  }

  return out;
}
