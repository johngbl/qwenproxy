function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seedFromString(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i++) {
    hash = ((hash << 5) - hash + value.charCodeAt(i)) | 0;
  }
  return hash >>> 0;
}

function pick<T>(rng: () => number, values: readonly T[]): T {
  return values[Math.floor(rng() * values.length)];
}

function randInt(rng: () => number, min: number, max: number): number {
  return Math.floor(rng() * (max - min + 1)) + min;
}

const CHROME_MAJOR = 149;

const VIEWPORTS = [
  { width: 1366, height: 768 },
  { width: 1440, height: 900 },
  { width: 1536, height: 864 },
  { width: 1600, height: 900 },
  { width: 1680, height: 1050 },
  { width: 1920, height: 1080 },
  { width: 1920, height: 1200 },
] as const;

const WEBGL_PROFILES = [
  {
    vendor: "Google Inc. (Intel)",
    renderer: "ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)",
  },
  {
    vendor: "Google Inc. (Intel)",
    renderer: "ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)",
  },
  {
    vendor: "Google Inc. (NVIDIA)",
    renderer: "ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)",
  },
  {
    vendor: "Google Inc. (AMD)",
    renderer: "ANGLE (AMD, AMD Radeon RX 6600 Direct3D11 vs_5_0 ps_5_0, D3D11)",
  },
] as const;

const LANGUAGE_PROFILES = [
  ["pt-BR", "pt", "en-US", "en"],
  ["pt-BR", "pt", "en-US", "en", "es"],
  ["pt-BR", "en-US", "en", "pt"],
] as const;

const HARDWARE_CONCURRENCIES = [4, 6, 8, 8, 12, 16] as const;
const DEVICE_MEMORIES = [4, 8, 8, 16] as const;

export interface FingerprintProfile {
  accountId: string;
  seed: number;
  userAgent: string;
  appVersion: string;
  chromeMajor: number;
  chromeVersion: string;
  brands: Array<{ brand: string; version: string }>;
  fullVersionList: Array<{ brand: string; version: string }>;
  secChUa: string;
  platform: string;
  platformVersion: string;
  languages: string[];
  locale: string;
  timezoneId: string;
  viewport: { width: number; height: number };
  hardwareConcurrency: number;
  deviceMemory: number;
  webglVendor: string;
  webglRenderer: string;
  colorDepth: number;
  pixelDepth: number;
}

const profileCache = new Map<string, FingerprintProfile>();

export function getFingerprintProfile(accountId: string): FingerprintProfile {
  const cached = profileCache.get(accountId);
  if (cached) return cached;

  const seed = seedFromString(accountId);
  const rng = mulberry32(seed);
  const viewport = pick(rng, VIEWPORTS);
  const webgl = pick(rng, WEBGL_PROFILES);
  const languages = [...pick(rng, LANGUAGE_PROFILES)];
  const hardwareConcurrency = pick(rng, HARDWARE_CONCURRENCIES);
  const deviceMemory = pick(rng, DEVICE_MEMORIES);
  const build = randInt(rng, 7300, 7600);
  const patch = randInt(rng, 0, 160);
  const chromeVersion = `${CHROME_MAJOR}.0.${build}.${patch}`;
  const notABrandVersion = String(pick(rng, ["8", "24", "99"] as const));
  const notABrand = pick(
    rng,
    ["Not/A)Brand", "Not)A_Brand", "Not?A_Brand"] as const,
  );
  const brands = [
    { brand: notABrand, version: notABrandVersion },
    { brand: "Google Chrome", version: String(CHROME_MAJOR) },
    { brand: "Chromium", version: String(CHROME_MAJOR) },
  ];
  const fullVersionList = brands.map((brand) => ({
    brand: brand.brand,
    version: brand.brand.startsWith("Not") ? "99.0.0.0" : chromeVersion,
  }));
  const secChUa = brands
    .map((brand) => `"${brand.brand}";v="${brand.version}"`)
    .join(", ");
  const userAgent = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`;

  const profile: FingerprintProfile = {
    accountId,
    seed,
    userAgent,
    appVersion: userAgent.replace("Mozilla/", ""),
    chromeMajor: CHROME_MAJOR,
    chromeVersion,
    brands,
    fullVersionList,
    secChUa,
    platform: "Win32",
    platformVersion: "10.0.0",
    languages,
    locale: languages[0],
    timezoneId: "America/Sao_Paulo",
    viewport,
    hardwareConcurrency,
    deviceMemory,
    webglVendor: webgl.vendor,
    webglRenderer: webgl.renderer,
    colorDepth: 24,
    pixelDepth: 24,
  };

  profileCache.set(accountId, profile);
  return profile;
}

export function clearFingerprintCache(accountId?: string): void {
  if (accountId) profileCache.delete(accountId);
  else profileCache.clear();
}
