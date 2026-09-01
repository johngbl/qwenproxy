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
  { width: 1280, height: 720 },
  { width: 1280, height: 800 },
  { width: 1536, height: 864 },
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
    vendor: "Google Inc. (Intel)",
    renderer: "ANGLE (Intel, Intel(R) UHD Graphics 770 Direct3D11 vs_5_0 ps_5_0, D3D11)",
  },
  {
    vendor: "Google Inc. (NVIDIA)",
    renderer: "ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)",
  },
  {
    vendor: "Google Inc. (NVIDIA)",
    renderer: "ANGLE (NVIDIA, NVIDIA GeForce RTX 3070 Direct3D11 vs_5_0 ps_5_0, D3D11)",
  },
  {
    vendor: "Google Inc. (NVIDIA)",
    renderer: "ANGLE (NVIDIA, NVIDIA GeForce RTX 3080 Direct3D11 vs_5_0 ps_5_0, D3D11)",
  },
  {
    vendor: "Google Inc. (NVIDIA)",
    renderer: "ANGLE (NVIDIA, NVIDIA GeForce RTX 4060 Direct3D11 vs_5_0 ps_5_0, D3D11)",
  },
  {
    vendor: "Google Inc. (NVIDIA)",
    renderer: "ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Direct3D11 vs_5_0 ps_5_0, D3D11)",
  },
  {
    vendor: "Google Inc. (NVIDIA)",
    renderer: "ANGLE (NVIDIA, NVIDIA GeForce GTX 1660 SUPER Direct3D11 vs_5_0 ps_5_0, D3D11)",
  },
  {
    vendor: "Google Inc. (AMD)",
    renderer: "ANGLE (AMD, AMD Radeon RX 6600 Direct3D11 vs_5_0 ps_5_0, D3D11)",
  },
  {
    vendor: "Google Inc. (AMD)",
    renderer: "ANGLE (AMD, AMD Radeon RX 7600 Direct3D11 vs_5_0 ps_5_0, D3D11)",
  },
  {
    vendor: "Google Inc. (AMD)",
    renderer: "ANGLE (AMD, AMD Radeon RX 580 Direct3D11 vs_5_0 ps_5_0, D3D11)",
  },
] as const;

const LANGUAGE_PROFILES = [
  ["pt-BR", "pt", "en-US", "en"],
  ["pt-BR", "pt", "en-US", "en", "es"],
  ["pt-BR", "en-US", "en", "pt"],
  ["pt-BR", "pt", "en"],
  ["pt-BR", "pt;q=0.9", "en-US;q=0.8", "en;q=0.7"],
] as const;

const HARDWARE_CONCURRENCIES = [4, 6, 8, 8, 8, 12, 16, 16, 24, 32] as const;
const DEVICE_MEMORIES = [4, 8, 8, 8, 16, 16, 32] as const;

const PLATFORM_VERSIONS = [
  { platform: "Windows", platformVersion: "14.0.0", major: "10" },
  { platform: "Windows", platformVersion: "15.0.0", major: "11" },
  { platform: "Windows", platformVersion: "14.0.0", major: "10" },
  { platform: "Windows", platformVersion: "15.0.0", major: "11" },
] as const;

const NOT_A_BRAND_VARIANTS = [
  { brand: "Not/A)Brand", version: "99" },
  { brand: "Not)A_Brand", version: "99" },
  { brand: "Not/A)Brand", version: "8" },
  { brand: "Not?A_Brand", version: "24" },
  { brand: "Not/A)Brand", version: "99" },
] as const;

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
  architecture: string;
  bitness: string;
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
  canvasNoiseSeed: number;
  audioNoiseSeed: number;
  webglNoiseSeed: number;
  outerWidthOffset: number;
  outerHeightOffset: number;
}

const profileCache = new Map<string, FingerprintProfile>();

// Per-account rotation salt. The seed is normally derived ONLY from the
// accountId, so after a hard WAF block (captcha/TMD) the account would return
// from its cooldown on the SAME device identity the WAF already flagged — the
// flag re-propagates immediately. Bumping the salt (and closing the browser
// context) makes the next profile a fresh device identity.
const rotationSalts = new Map<string, number>();

export function rotateFingerprintSeed(accountId: string): number {
  const next = (rotationSalts.get(accountId) ?? 0) + 1;
  rotationSalts.set(accountId, next);
  profileCache.delete(accountId);
  return next;
}

export function getFingerprintRotation(accountId: string): number {
  return rotationSalts.get(accountId) ?? 0;
}

export function getFingerprintProfile(accountId: string): FingerprintProfile {
  const cached = profileCache.get(accountId);
  if (cached) return cached;

  const salt = rotationSalts.get(accountId) ?? 0;
  const seed = seedFromString(salt === 0 ? accountId : `${accountId}#r${salt}`);
  const rng = mulberry32(seed);
  const viewport = pick(rng, VIEWPORTS);
  const webgl = pick(rng, WEBGL_PROFILES);
  const languages = [...pick(rng, LANGUAGE_PROFILES)];
  const hardwareConcurrency = pick(rng, HARDWARE_CONCURRENCIES);
  const deviceMemory = pick(rng, DEVICE_MEMORIES);
  const platformInfo = pick(rng, PLATFORM_VERSIONS);
  const notABrand = pick(rng, NOT_A_BRAND_VARIANTS);

  const build = randInt(rng, 7300, 7600);
  const patch = randInt(rng, 0, 160);
  const chromeVersion = `${CHROME_MAJOR}.0.${build}.${patch}`;

  const brands = [
    { brand: notABrand.brand, version: notABrand.version },
    { brand: "Google Chrome", version: String(CHROME_MAJOR) },
    { brand: "Chromium", version: String(CHROME_MAJOR) },
  ];
  const fullVersionList = [
    { brand: notABrand.brand, version: chromeVersion },
    { brand: "Google Chrome", version: chromeVersion },
    { brand: "Chromium", version: chromeVersion },
  ];
  const secChUa = brands
    .map((brand) => `"${brand.brand}";v="${brand.version}"`)
    .join(", ");
  const userAgent = `Mozilla/5.0 (Windows NT ${platformInfo.major}.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`;

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
    platformVersion: platformInfo.platformVersion,
    architecture: "x86",
    bitness: "64",
    languages,
    locale: languages[0].split(";")[0],
    timezoneId: "America/Sao_Paulo",
    viewport,
    hardwareConcurrency,
    deviceMemory,
    webglVendor: webgl.vendor,
    webglRenderer: webgl.renderer,
    colorDepth: 24,
    pixelDepth: 24,
    canvasNoiseSeed: randInt(rng, 1, 2147483647),
    audioNoiseSeed: randInt(rng, 1, 2147483647),
    webglNoiseSeed: randInt(rng, 1, 2147483647),
    outerWidthOffset: randInt(rng, 0, 20),
    outerHeightOffset: randInt(rng, 75, 95),
  };

  profileCache.set(accountId, profile);
  return profile;
}

export function clearFingerprintCache(accountId?: string): void {
  if (accountId) profileCache.delete(accountId);
  else profileCache.clear();
}
