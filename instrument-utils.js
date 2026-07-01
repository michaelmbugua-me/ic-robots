/**
 * Instrument utilities — determine pip size, price precision, and instrument type
 * from a pair/instrument name string.
 */

const METALS = new Set(["XAU_USD", "XAG_USD", "XAUUSD", "XAGUSD"]);
const JFY_PAIRS = new Set([
  "USD_JPY", "EUR_JPY", "GBP_JPY", "AUD_JPY", "CHF_JPY", "NZD_JPY", "CAD_JPY",
]);
const CRYPTO = new Set(["BTC_USD", "ETH_USD", "BTCUSD", "ETHUSD"]);
const INDICES = new Set(["US30", "NAS100", "SPX500", "UK100", "GER40"]);

export function getInstrumentType(pair) {
  const p = String(pair || "").toUpperCase();
  if (METALS.has(p)) return "metal";
  if (CRYPTO.has(p)) return "crypto";
  if (INDICES.has(p)) return "index";
  return "forex";
}

export function getPipSize(pair) {
  const p = String(pair || "").toUpperCase();
  if (JFY_PAIRS.has(p)) return 0.01;
  if (METALS.has(p)) return 0.01;
  if (p.startsWith("USD_") || p.endsWith("_JPY")) return 0.01;
  if (CRYPTO.has(p)) return 0.01;
  if (INDICES.has(p)) return 1.0;
  // Try heuristic: last 3 chars = JPY
  if (p.endsWith("_JPY") || p.endsWith("/JPY")) return 0.01;
  return 0.0001;
}

export function getPriceDecimals(pair) {
  const type = getInstrumentType(pair);
  if (type === "index") return 2;
  if (type === "crypto") return 2;
  if (type === "metal") return 2;
  if (getPipSize(pair) === 0.01) return 3;
  return 5;
}

export function formatPrice(pair, value) {
  const d = getPriceDecimals(pair);
  return Number(Number(value).toFixed(d));
}

export function getLotSize(pair) {
  const type = getInstrumentType(pair);
  if (type === "metal") return 100;
  if (type === "index" || type === "crypto") return 1;
  return 100_000;
}

export function isJPY(pair) {
  return getPipSize(String(pair || "")) === 0.01;
}
