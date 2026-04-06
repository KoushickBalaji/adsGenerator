export type CompanyScraperAdapter = "bluestone" | "generic" | "shopify";

export type PromptStyle = "jewellery_businesswoman_v1" | "product_only_v1";

export type PromptPolicy = {
  requiresAmbassador: boolean;
  style: PromptStyle;
};

export type CompanyConfig = {
  slug: string;
  displayName: string;

  // Which product URLs are allowed in this demo mode
  allowedHosts: string[];

  // Scraper strategy
  scraper: {
    adapter: CompanyScraperAdapter;
    maxReferenceImages: number;
  };

  // Kling video settings
  kling: {
    modelCandidates: string[];
    defaults: {
      duration: string;
      aspectRatio: string;
      mode: "std" | "pro";
    };
    ambassador: {
      enabled: boolean;
      elementPrefixCandidates?: string[];
    };
  };

  // Prompt policy
  prompt: PromptPolicy;

  // Spend / abuse limits
  limits: {
    maxConcurrentRuns: number;
    maxLifetimeSuccessfulVideos: number;
    maxAttemptsPerDay?: number;
  };
};

export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const COMPANY_REGISTRY: Record<string, CompanyConfig> = {
  bluestone: {
    slug: "bluestone",
    displayName: "BlueStone",
    allowedHosts: ["bluestone.com"],
    scraper: {
      adapter: "bluestone",
      maxReferenceImages: 12,
    },
    kling: {
      modelCandidates: ["kling-v3-omni", "kling-v3"],
      defaults: {
        duration: "10",
        aspectRatio: "1:1",
        mode: "pro",
      },
      ambassador: {
        enabled: true,
        elementPrefixCandidates: ["bluestone"],
      },
    },
    prompt: {
      requiresAmbassador: true,
      style: "jewellery_businesswoman_v1",
    },
    limits: {
      maxConcurrentRuns: 3,
      maxLifetimeSuccessfulVideos: 10,
      maxAttemptsPerDay: 30,
    },
  },

  // Optional baselines / examples:
  "generic-model": {
    slug: "generic-model",
    displayName: "Generic Model Demo",
    allowedHosts: [],
    scraper: {
      adapter: "generic",
      maxReferenceImages: 12,
    },
    kling: {
      modelCandidates: ["kling-v3-omni", "kling-v3"],
      defaults: {
        duration: "10",
        aspectRatio: "1:1",
        mode: "pro",
      },
      ambassador: {
        enabled: true,
        elementPrefixCandidates: ["generic-female-v1", "generic-male-v1", "generic-unisex-v1"],
      },
    },
    prompt: {
      requiresAmbassador: true,
      style: "jewellery_businesswoman_v1",
    },
    limits: {
      maxConcurrentRuns: 1,
      maxLifetimeSuccessfulVideos: 10,
      maxAttemptsPerDay: 30,
    },
  },

  "product-only": {
    slug: "product-only",
    displayName: "Product-only Demo",
    allowedHosts: [],
    scraper: {
      adapter: "generic",
      maxReferenceImages: 12,
    },
    kling: {
      modelCandidates: ["kling-v3-omni", "kling-v3"],
      defaults: {
        duration: "10",
        aspectRatio: "1:1",
        mode: "pro",
      },
      ambassador: {
        enabled: false,
      },
    },
    prompt: {
      requiresAmbassador: false,
      style: "product_only_v1",
    },
    limits: {
      maxConcurrentRuns: 1,
      maxLifetimeSuccessfulVideos: 10,
      maxAttemptsPerDay: 30,
    },
  },
};

function normalizeCompanySlug(companySlug: string): string {
  return (companySlug || "").trim().toLowerCase();
}

function isHostnameAllowed(hostname: string, allowedHost: string): boolean {
  const h = hostname.trim().toLowerCase();
  const a = allowedHost.trim().toLowerCase();
  return h === a || h.endsWith(`.${a}`);
}

export function getCompanyConfig(companySlug: string): CompanyConfig | null {
  const slug = normalizeCompanySlug(companySlug);
  if (!slug) return null;

  const config = COMPANY_REGISTRY[slug];
  if (!config) return null;

  validateCompanyConfig(config);
  return config;
}

export function assertUrlAllowed(url: string, config: CompanyConfig): void {
  if (!Array.isArray(config.allowedHosts) || config.allowedHosts.length === 0) {
    throw new HttpError(
      400,
      "This demo link is not configured for URL generation yet. Reach out to the developer."
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new HttpError(400, "Invalid URL.");
  }

  const ok = config.allowedHosts.some((h) => isHostnameAllowed(parsed.hostname, h));
  if (!ok) {
    throw new HttpError(
      400,
      `This tool works exclusively with ${config.displayName} product URLs.`
    );
  }
}

function validateCompanyConfig(config: CompanyConfig): void {
  if (config.prompt.requiresAmbassador && !config.kling.ambassador.enabled) {
    throw new Error(
      `[companyConfig] ${config.slug}: prompt.requiresAmbassador=true but kling.ambassador.enabled=false`
    );
  }

  if (config.kling.ambassador.enabled) {
    const c = config.kling.ambassador.elementPrefixCandidates;
    if (!Array.isArray(c) || c.length === 0) {
      throw new Error(
        `[companyConfig] ${config.slug}: ambassador.enabled=true but elementPrefixCandidates is missing/empty`
      );
    }
  }

  if (!config.limits.maxLifetimeSuccessfulVideos || config.limits.maxLifetimeSuccessfulVideos <= 0) {
    throw new Error(
      `[companyConfig] ${config.slug}: limits.maxLifetimeSuccessfulVideos must be > 0`
    );
  }
}
