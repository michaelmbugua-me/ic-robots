/**
 * get-symbols.js — Fetch real symbol IDs from your IC Markets account
 *
 * Run this ONCE after completing auth to get the correct symbol IDs
 * for your specific IC Markets account. Copy the output into config.js.
 *
 * Usage:
 *   node get-symbols.js
 */

import WebSocket from "ws";
import { config } from "./config.js";

const PT_APP_AUTH_REQ     = 2100;
const PT_ACCOUNT_AUTH_REQ = 2102;
const PT_SYMBOLS_LIST_REQ = 2121;
const PT_ERROR_RES        = 2142;
const PT_HEARTBEAT        = 51;

const host = config.ctraderEnv === "live"
  ? "live.ctraderapi.com"
  : "demo.ctraderapi.com";

let counter = 1;
const pending = new Map();

function send(ws, payloadType, payload) {
  const clientMsgId = `m${counter++}`;
  return new Promise((resolve, reject) => {
    pending.set(clientMsgId, { resolve, reject });
    ws.send(JSON.stringify({ clientMsgId, payloadType, payload }));
    setTimeout(() => {
      if (pending.has(clientMsgId)) {
        pending.delete(clientMsgId);
        reject(new Error(`Timeout: payloadType ${payloadType}`));
      }
    }, 15_000);
  });
}

// Major forex pairs we care about (in cTrader "EURUSD" format)
const MAJOR_PAIRS = new Set([
  "EURUSD", "GBPUSD", "USDJPY", "AUDUSD", "USDCAD",
  "USDCHF", "NZDUSD", "EURJPY", "GBPJPY", "EURGBP",
]);

async function run() {
  if (!config.ctraderClientId || !config.ctraderAccessToken || !config.ctraderAccountId) {
    console.error(
      "\n❌  Missing credentials.\n" +
      "    Make sure CTRADER_CLIENT_ID, CTRADER_CLIENT_SECRET,\n" +
      "    CTRADER_ACCESS_TOKEN and CTRADER_ACCOUNT_ID are all set.\n" +
      "    Run `node auth.js` first if you haven't already.\n"
    );
    process.exit(1);
  }

  console.log(`\nConnecting to cTrader (${config.ctraderEnv})...`);
  const ws = new WebSocket(`wss://${host}:5036`);

  ws.on("message", (raw) => {
    try {
      const { clientMsgId, payloadType, payload } = JSON.parse(raw.toString());
      if (payloadType === PT_ERROR_RES) {
        const p = pending.get(clientMsgId);
        if (p) { pending.delete(clientMsgId); p.reject(new Error(payload?.description)); }
        return;
      }
      if (clientMsgId && pending.has(clientMsgId)) {
        const p = pending.get(clientMsgId);
        pending.delete(clientMsgId);
        p.resolve(payload);
      }
    } catch {}
  });

  ws.on("error", (err) => { console.error("WebSocket error:", err.message); process.exit(1); });

  await new Promise((res) => ws.once("open", res));
  console.log("Connected ✓");

  // Heartbeat every 20 s
  setInterval(() => ws.send(JSON.stringify({
    clientMsgId: `hb${Date.now()}`, payloadType: PT_HEARTBEAT, payload: {}
  })), 20_000);

  await send(ws, PT_APP_AUTH_REQ, {
    clientId:     config.ctraderClientId,
    clientSecret: config.ctraderClientSecret,
  });
  console.log("App authenticated ✓");

  await send(ws, PT_ACCOUNT_AUTH_REQ, {
    ctidTraderAccountId: config.ctraderAccountId,
    accessToken:         config.ctraderAccessToken,
  });
  console.log("Account authenticated ✓\n");

  const res = await send(ws, PT_SYMBOLS_LIST_REQ, {
    ctidTraderAccountId:    config.ctraderAccountId,
    includeArchivedSymbols: false,
  });

  const symbols = res.symbol ?? [];
  const found   = [];

  for (const sym of symbols) {
    // Strip any slashes or spaces: "EUR/USD" or "EUR USD" → "EURUSD"
    const clean = (sym.symbolName ?? "").replace(/[^A-Z]/gi, "").toUpperCase();
    if (MAJOR_PAIRS.has(clean)) {
      // Convert "EURUSD" → "EUR_USD" for our config format
      const key = clean.slice(0, 3) + "_" + clean.slice(3);
      found.push({ key, id: sym.symbolId });
    }
  }

  if (found.length === 0) {
    console.log("⚠️  No major forex pairs found. All available symbols:");
    for (const sym of symbols.slice(0, 30)) {
      console.log(`  ${sym.symbolId}: ${sym.symbolName}`);
    }
  } else {
    console.log("═".repeat(54));
    console.log("  Copy this block into config.js → ctraderSymbolIds:");
    console.log("═".repeat(54));
    console.log("\nctraderSymbolIds: {");
    for (const { key, id } of found) {
      console.log(`  "${key}": ${id},`);
    }
    console.log("},\n");
    console.log("═".repeat(54) + "\n");
  }

  ws.close();
  process.exit(0);
}

run().catch((err) => { console.error("Error:", err.message); process.exit(1); });
