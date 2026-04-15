/**
 * Lightweight frontend mirror of backend allowedHosts → companySlug mapping.
 * Keep in sync with supabase/functions/_shared/companyConfig.ts when onboarding new companies.
 */

const HOST_TO_COMPANY: Record<string, string> = {
  "bluestone.com": "bluestone",
  "www.bluestone.com": "bluestone",
  "giva.co": "giva",
  "melorra.com": "melorra",
  "kushals.com": "kushals",
  "shopklarity.com": "klarity",
  "quirksmith.com": "quirksmith",
  "iyalsilvers.com": "iyal-silvers",
  "onyadiamonds.com": "onya",
  "aukerajewellery.com": "aukera",
  "caratcult.com": "caratcult",
  "shravia.com": "shravia",
  "houseofmila.co": "houseofmila",
  "ishhaara.com": "ishhaara",
  "thangamayil.com": "thangamayil",
};

/**
 * Given a product URL, detect which company it belongs to by matching the hostname.
 * Returns the company slug or null if unrecognized.
 */
export function detectCompanyFromUrl(url: string): string | null {
  try {
    const { hostname } = new URL(url);
    const lower = hostname.toLowerCase();

    // Exact match first
    if (HOST_TO_COMPANY[lower]) return HOST_TO_COMPANY[lower];

    // Subdomain match: strip leading segments and retry
    const parts = lower.split(".");
    for (let i = 1; i < parts.length - 1; i++) {
      const parent = parts.slice(i).join(".");
      if (HOST_TO_COMPANY[parent]) return HOST_TO_COMPANY[parent];
    }

    return null;
  } catch {
    return null;
  }
}

export function formatCompanyLabel(slug: string): string {
  const cleaned = (slug || "").trim();
  if (!cleaned) return "Unknown";
  return cleaned
    .split(/[-_]+/g)
    .filter(Boolean)
    .map((s) => s.slice(0, 1).toUpperCase() + s.slice(1))
    .join(" ");
}
