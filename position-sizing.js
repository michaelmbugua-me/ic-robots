export function calculateRiskVolume({
  pair,
  slPips,
  currentRate,
  accountCapitalKES,
  riskPerTradePercent,
  usdKesRate,
  maxLeverage,
  maxPositionSizeUnits,
  logger = null,
} = {}) {
  const normalizedPair = String(pair || "");
  const numericSlPips = Number(slPips);
  const numericRate = Number(currentRate);
  const numericCapitalKES = Number(accountCapitalKES);
  const numericRiskPercent = Number(riskPerTradePercent);
  const numericUsdKesRate = Number(usdKesRate);
  const numericMaxLeverage = Number(maxLeverage);
  const numericMaxPositionSizeUnits = Number(maxPositionSizeUnits);

  if (!normalizedPair || !Number.isFinite(numericSlPips) || numericSlPips <= 0) {
    logger?.error?.(`  ❌ PositionSizing: Invalid pair (${pair}) or SL pips (${slPips})`);
    return 0;
  }

  if (
    !Number.isFinite(numericRate) || numericRate <= 0 ||
    !Number.isFinite(numericCapitalKES) || numericCapitalKES <= 0 ||
    !Number.isFinite(numericRiskPercent) || numericRiskPercent <= 0 ||
    !Number.isFinite(numericUsdKesRate) || numericUsdKesRate <= 0
  ) {
    logger?.error?.(
      `  ❌ PositionSizing: Invalid sizing inputs rate=${currentRate}, capitalKES=${accountCapitalKES}, ` +
      `riskPercent=${riskPerTradePercent}, usdKesRate=${usdKesRate}`
    );
    return 0;
  }

  const pipValueUSD = calculatePipValueUSD(normalizedPair, numericRate);
  const pipValuePerUnitKES = (pipValueUSD * numericUsdKesRate) / 100_000;

  if (!Number.isFinite(pipValuePerUnitKES) || pipValuePerUnitKES <= 0) {
    logger?.error?.(`  ❌ PositionSizing: Invalid pip value (${pipValuePerUnitKES}) for ${normalizedPair}`);
    return 0;
  }

  const riskAmountPerTradeKES = numericCapitalKES * (numericRiskPercent / 100);
  let units = Math.floor(riskAmountPerTradeKES / (numericSlPips * pipValuePerUnitKES));

  if (Number.isFinite(numericMaxLeverage) && numericMaxLeverage > 0) {
    const notionalKESPerUnit = calculateNotionalKESPerUnit(normalizedPair, numericRate, numericUsdKesRate);
    const notionalKES = units * notionalKESPerUnit;
    const maxNotionalKES = numericCapitalKES * numericMaxLeverage;

    if (notionalKES > maxNotionalKES) {
      units = Math.floor(maxNotionalKES / notionalKESPerUnit);
      logger?.log?.(`  ⚠️  PositionSizing: Leverage cap applied (1:${numericMaxLeverage}). Units capped to ${units}`);
    }
  }

  if (Number.isFinite(numericMaxPositionSizeUnits) && numericMaxPositionSizeUnits > 0 && units > numericMaxPositionSizeUnits) {
    units = numericMaxPositionSizeUnits;
  }

  return Math.max(0, Math.floor(units));
}

export function calculatePipValueUSD(pair, currentRate) {
  const normalizedPair = String(pair || "");
  const numericRate = Number(currentRate);
  const pipSize = normalizedPair.includes("JPY") ? 0.01 : 0.0001;

  if (normalizedPair.endsWith("_USD") || normalizedPair.endsWith("/USD")) {
    return pipSize * 100_000;
  }

  if (normalizedPair.startsWith("USD_") || normalizedPair.startsWith("USD/")) {
    return (pipSize / numericRate) * 100_000;
  }

  return (pipSize / numericRate) * 100_000;
}

export function calculateNotionalKESPerUnit(pair, currentRate, usdKesRate) {
  const normalizedPair = String(pair || "");
  const numericRate = Number(currentRate);
  const numericUsdKesRate = Number(usdKesRate);

  if (!Number.isFinite(numericRate) || numericRate <= 0 || !Number.isFinite(numericUsdKesRate) || numericUsdKesRate <= 0) {
    return Infinity;
  }

  if (normalizedPair.startsWith("USD_") || normalizedPair.startsWith("USD/")) {
    return numericUsdKesRate;
  }

  if (normalizedPair.endsWith("_USD") || normalizedPair.endsWith("/USD")) {
    return numericRate * numericUsdKesRate;
  }

  return numericRate * numericUsdKesRate;
}


