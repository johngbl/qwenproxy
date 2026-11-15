/**
 * Detects the "daily limit reached for this model" notice that Qwen returns
 * when an account exhausts the quota of a specific model.
 *
 * The notice arrives as regular answer content (sometimes with
 * `extra.update_member`, sometimes as plain text only), so matching the text
 * ensures failover works regardless of whether the metadata flag is present
 * and regardless of account locale.
 */

const QUOTA_PATTERNS: RegExp[] = [
  // English
  /you(?:'ve| have)? reached (?:today'?s|the) (?:daily )?(?:usage )?limit/i,
  /you(?:'ve| have)? hit (?:today'?s|the) (?:daily )?(?:usage )?limit/i,
  /daily limit (?:for|reached)/i,
  /upgrade your membership/i,
  /reach(?:ed)? your (?:daily )?(?:usage )?limit/i,
  /usage limit (?:for|reached)/i,
  /switch to another model/i,
  /moved to another model/i,
  // Portuguese
  /atingiu o limite de hoje/i,
  /atingiu o limite(?: di[áa]rio)? para/i,
  /fa[çc]a upgrade da sua membership/i,
  /upgrade da sua membership/i,
  /mude para (?:um )?outro modelo/i,
  /limite de uso di[áa]rio/i,
  // Spanish
  /alcanzaste el l[ií]mite (?:de hoy|diario)/i,
  /l[ií]mite (?:de hoy|diario|de uso) (?:para|alcanzado)/i,
  /actualiza tu membres[ií]a/i,
  /cambia a otro modelo/i,
  // German
  /du hast das (?:t[aä]gliche )?limit erreicht/i,
  /t[aä]gliches limit erreicht/i,
  /aktualisiere deine mitgliedschaft/i,
  /wechsle zu einem anderen modell/i,
  // French
  /vous avez atteint la limite (?:du jour|quotidienne)/i,
  /mettez [àa] niveau votre abonnement/i,
  /passez [àa] un autre mod[eè]le/i,
  // Italian
  /hai raggiunto il limite (?:di oggi|giornaliero)/i,
  /aggiorna il tuo abbonamento/i,
  /passa a un altro modello/i,
  // Japanese
  /本日の利用制限/,
  /今日の利用制限/,
  /プランをアップグレード/,
  /別のモデルに変更/,
  // Korean
  /오늘의 사용 한도/,
  /사용 한도에 도달/,
  /멤버십을 업그레이드/,
  /다른 모델로 전환/,
  // Chinese
  /已达(?:到)?今日(?:的)?(?:使用)?(?:限额|上限)/,
  /达到(?:了)?今日(?:的)?限额/,
  /升级(?:你的)?会员/,
  /切换到其他模型/,
  /今日限额/,
  // Russian
  /вы достигли (?:сегодняшнего|дневного) лимита/i,
  /обновите (?:свою )?(?:подписку|членство)/i,
  /переключит[ьи]с[яь] на другую модель/i,
  // Dutch
  /je hebt de (?:dagelijkse )?limiet bereikt/i,
  // Turkish
  /günlük (?:kullanım )?limitinize ulaştınız/i,
];

/** Models the limit notice can name, e.g. "Qwen3.8-Max". */
const MODEL_NAME_PATTERN = /\bQwen[0-9][\w.-]*(?:-[A-Za-z][\w-]*)?/i;

function trimModelName(name: string): string {
  return name.replace(/[.\-_:,;]+$/, "");
}

export const QUOTA_MESSAGE_MAX_LENGTH = 1000;

export interface QuotaLimitMatch {
  isQuotaLimit: boolean;
  model?: string;
}

/**
 * Detects the daily-limit notice and tries to extract the model it names.
 */
export function detectQuotaLimitMessage(
  content: string | null | undefined,
): QuotaLimitMatch {
  const text = (content || "").trim();
  if (!text || text.length > QUOTA_MESSAGE_MAX_LENGTH) {
    return { isQuotaLimit: false };
  }

  // Never flag code blocks or structured tool calls
  if (
    text.includes("```") ||
    text.includes("<tool_call") ||
    text.includes("<qpx_call") ||
    text.includes("</")
  ) {
    return { isQuotaLimit: false };
  }

  const isQuotaLimit = QUOTA_PATTERNS.some((re) => re.test(text));
  if (!isQuotaLimit) {
    return { isQuotaLimit: false };
  }

  const modelMatch = text.match(MODEL_NAME_PATTERN);
  return {
    isQuotaLimit: true,
    model: modelMatch ? trimModelName(modelMatch[0]) : undefined,
  };
}

export function isQuotaLimitMessage(
  content: string | null | undefined,
): boolean {
  return detectQuotaLimitMessage(content).isQuotaLimit;
}
