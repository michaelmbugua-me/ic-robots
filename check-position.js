/**
 * check-position.js — Look up a specific broker position/trade by ID
 *
 * Queries cTrader directly (the account configured in .env) for:
 *   - Current open position status (SL/TP, if still open on the broker)
 *   - Any live protection/pending orders still linked to the position
 *   - Historical orders tied to the position (was SL/TP ever requested?)
 *   - Historical deals (fills/closes) tied to the position
 *
 * This is a read-only diagnostic script — it never places, amends, or
 * closes anything. Useful when a trade was triggered by a remote/server
 * instance and isn't visible in local logs.
 *
 * Usage:
 *   node check-position.js --position 654859075
 *   node check-position.js --position 654859075 --days 60
 *   node check-position.js --position 654859075 --from 2026-06-01 --to 2026-07-22
 */

import { ICMarketsClient } from "./icmarkets.js";
import { config } from "./config.js";

function parseArgs() {
  const args = process.argv.slice(2);
  const out = { position: null, days: 45, from: null, to: null };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--position" || a === "--positionId") out.position = args[++i];
    else if (a === "--days") out.days = Number(args[++i]);
    else if (a === "--from") out.from = args[++i];
    else if (a === "--to") out.to = args[++i];
  }
  return out;
}

function toNum(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === "object" && typeof v.toNumber === "function") return v.toNumber();
  return Number(v);
}

function fmtEAT(ms) {
  if (!ms) return null;
  return new Date(ms).toLocaleString("en-GB", { timeZone: "Africa/Nairobi", hour12: false }) + " EAT";
}

const SYMBOL_NAME_BY_ID = Object.fromEntries(
  Object.entries(config.ctraderSymbolIds || {}).map(([name, id]) => [String(id), name])
);

function pairName(symbolId) {
  return SYMBOL_NAME_BY_ID[String(toNum(symbolId))] || `symbolId ${symbolId}`;
}

async function run() {
  const { position: positionIdArg, days, from, to } = parseArgs();
  if (!positionIdArg) {
    console.error("Usage: node check-position.js --position <positionId> [--days 45] [--from ISO] [--to ISO]");
    process.exit(1);
  }
  const positionId = String(positionIdArg);

  const toMs = to ? new Date(to).getTime() : Date.now();
  const fromMs = from ? new Date(from).getTime() : toMs - days * 24 * 60 * 60 * 1000;

  console.log(`\nLooking up position ${positionId} on cTrader (${config.ctraderEnv})...`);
  console.log(`Search window: ${new Date(fromMs).toISOString()} → ${new Date(toMs).toISOString()}\n`);

  const client = new ICMarketsClient();
  await client.connect();
  await client.authenticate();
  console.log("✅ Connected & authenticated.\n");

  // 1) Is it still open right now?
  const { positions, orders: liveOrders } = await client.reconcile();
  const openPosition = positions.find(p => String(p.positionId) === positionId);

  if (openPosition) {
    console.log("── OPEN POSITION FOUND (still live on the broker) ──");
    console.log("Pair:              ", pairName(openPosition.tradeData.symbolId));
    console.log("Side:              ", openPosition.tradeData.tradeSide);
    console.log("Volume (units):    ", toNum(openPosition.tradeData.volume) / 100);
    console.log("VWAP entry price:  ", openPosition.price);
    console.log("Stop Loss:         ", openPosition.stopLoss ?? "❌ NOT SET");
    console.log("Take Profit:       ", openPosition.takeProfit ?? "❌ NOT SET");
    console.log("Opened:            ", fmtEAT(toNum(openPosition.tradeData.openTimestamp)));
    console.log("Last updated:      ", fmtEAT(toNum(openPosition.utcLastUpdateTimestamp)));
    console.log();
  } else {
    console.log("Position is NOT in the current open-positions list (already closed, or outside reconcile scope).\n");
  }

  const relatedLiveOrders = liveOrders.filter(o => String(o.positionId) === positionId);
  if (relatedLiveOrders.length) {
    console.log(`── ${relatedLiveOrders.length} live protection/pending order(s) linked to this position ──`);
    for (const o of relatedLiveOrders) {
      console.log(` orderId=${o.orderId} type=${o.orderType} status=${o.orderStatus} stopLoss=${o.stopLoss ?? "-"} takeProfit=${o.takeProfit ?? "-"}`);
    }
    console.log();
  }

  // 2) Search historical deals + orders in weekly chunks (cTrader restricts range per call)
  const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
  const matchedDeals = [];
  const matchedOrders = [];

  let chunkTo = toMs;
  while (chunkTo > fromMs) {
    const chunkFrom = Math.max(fromMs, chunkTo - WEEK_MS);
    try {
      const { deals } = await client.getDeals(chunkFrom, chunkTo);
      matchedDeals.push(...deals.filter(d => String(d.positionId) === positionId));
    } catch (err) {
      console.warn(`  ⚠️  getDeals(${new Date(chunkFrom).toISOString()} → ${new Date(chunkTo).toISOString()}) failed: ${err.message}`);
    }
    try {
      const { orders } = await client.getOrders(chunkFrom, chunkTo);
      matchedOrders.push(...orders.filter(o => String(o.positionId) === positionId));
    } catch (err) {
      console.warn(`  ⚠️  getOrders(${new Date(chunkFrom).toISOString()} → ${new Date(chunkTo).toISOString()}) failed: ${err.message}`);
    }
    chunkTo = chunkFrom;
  }

  if (matchedOrders.length) {
    console.log(`── ${matchedOrders.length} historical order(s) linked to this position ──`);
    for (const o of matchedOrders) {
      console.log(JSON.stringify({
        orderId: String(o.orderId),
        orderType: o.orderType,
        orderStatus: o.orderStatus,
        tradeSide: o.tradeData?.tradeSide,
        volume: toNum(o.tradeData?.volume) / 100,
        requestedStopLoss: o.stopLoss ?? null,
        requestedTakeProfit: o.takeProfit ?? null,
        relativeStopLoss: o.relativeStopLoss ? toNum(o.relativeStopLoss) / 100000 : null,
        relativeTakeProfit: o.relativeTakeProfit ? toNum(o.relativeTakeProfit) / 100000 : null,
        executionPrice: o.executionPrice ?? null,
        createdEAT: fmtEAT(toNum(o.tradeData?.openTimestamp)),
        lastUpdateEAT: fmtEAT(toNum(o.utcLastUpdateTimestamp)),
        label: o.tradeData?.label,
        comment: o.tradeData?.comment,
      }, null, 2));
    }
    console.log();
  } else {
    console.log("No historical orders matched this position ID in the search window (try widening --days).\n");
  }

  if (matchedDeals.length) {
    console.log(`── ${matchedDeals.length} historical deal(s) (executions) linked to this position ──`);
    for (const d of matchedDeals) {
      console.log(JSON.stringify({
        dealId: String(d.dealId),
        orderId: String(d.orderId),
        pair: pairName(d.symbolId),
        tradeSide: d.tradeSide,
        dealStatus: d.dealStatus,
        volume: toNum(d.volume) / 100,
        filledVolume: toNum(d.filledVolume) / 100,
        executionPrice: d.executionPrice,
        executedEAT: fmtEAT(toNum(d.executionTimestamp)),
        closePositionDetail: d.closePositionDetail ? {
          entryPrice: d.closePositionDetail.entryPrice,
          grossProfit: toNum(d.closePositionDetail.grossProfit),
          swap: toNum(d.closePositionDetail.swap),
          commission: toNum(d.closePositionDetail.commission),
          balanceAfter: toNum(d.closePositionDetail.balance),
        } : null,
      }, null, 2));
    }
  } else {
    console.log("No historical deals matched this position ID in the search window (try widening --days).\n");
  }

  process.exit(0);
}

run().catch(err => {
  console.error("Error:", err.message);
  process.exit(1);
});
