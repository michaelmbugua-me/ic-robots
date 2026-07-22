/**
 * Historical Tick Downloader — builds a local daily tick cache for precise intrabar replay.
 */
import fs from "fs";
import path from "path";
import zlib from "zlib";
import { ICMarketsClient } from "./icmarkets.js";
import { TickDatabase } from "./tick-db.js";

const DAY_MS = 86_400_000;
const DEFAULT_OUT_DIR = "data/ticks";

const args = process.argv.slice(2);

function argValue(name, fallback = null) {
  const eq = args.find(a => a.startsWith(`${name}=`));
  if (eq) return eq.slice(name.length + 1);
  const idx = args.indexOf(name);
  return idx >= 0 ? args[idx + 1] : fallback;
}

function hasFlag(name) {
  return args.includes(name);
}

const pairsArg = argValue("--pairs", null);
const pairArg = argValue("--pair", null);
const pairs = (pairsArg || pairArg || "XAU_USD")
  .split(",")
  .map(p => p.trim())
  .filter(Boolean);
const fromArg = argValue("--from");
const toArg = argValue("--to");
const outDir = argValue("--out-dir", DEFAULT_OUT_DIR);
const force = hasFlag("--force");
const useSqlite = !hasFlag("--no-sqlite");

async function withRetry(client, fn, maxRetries = 5) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      if (!client.connected) {
        console.log("  📡 Client disconnected, attempting to reconnect...");
        await client.connect();
        await client.authenticate();
      }
      return await fn();
    } catch (err) {
      console.warn(`  ⚠️  Operation failed (attempt ${i + 1}/${maxRetries}): ${err.message}`);
      if (i === maxRetries - 1) throw err;
      
      const backoff = Math.min(30000, 5000 * Math.pow(2, i));
      console.log(`  🕒 Retrying in ${backoff / 1000}s...`);
      await new Promise(r => setTimeout(r, backoff));
      
      // If it was a connection error, force a reconnect on next attempt
      if (err.message.includes("WebSocket") || err.message.includes("closed") || err.message.includes("Timeout")) {
        try { client.ws?.terminate(); } catch {}
        client.connected = false;
      }
    }
  }
}

if (!fromArg || !toArg) {
  console.error("Usage: node download-ticks.js --pairs XAU_USD,EUR_USD --from 2026-07-17 --to 2026-07-18");
  process.exit(1);
}

const fromMs = new Date(fromArg).getTime();
const toMs = new Date(toArg).getTime();
if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs >= toMs) {
  console.error("Invalid --from/--to range.");
  process.exit(1);
}

function pairKey(pair) {
  return pair.replace("/", "_");
}

function dayKey(timestamp) {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function utcDayStart(timestamp) {
  const d = new Date(timestamp);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function tickFilePath(pair, day) {
  return path.join(outDir, pairKey(pair), `${day}.json.gz`);
}

function readJsonGzip(file) {
  if (!fs.existsSync(file)) return null;
  return JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString("utf8"));
}

function writeJsonGzip(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, zlib.gzipSync(JSON.stringify(data)));
}

function normalizeTick(t) {
  return {
    time: t.time,
    timestamp: Number(t.timestamp ?? new Date(t.time).getTime()),
    bid: Number(t.bid),
    ask: Number(t.ask),
  };
}

function mergeUniqueTicks(existingTicks, newTicks) {
  const byKey = new Map();
  for (const raw of [...(existingTicks ?? []), ...(newTicks ?? [])]) {
    const tick = normalizeTick(raw);
    if (!Number.isFinite(tick.timestamp) || !Number.isFinite(tick.bid) || !Number.isFinite(tick.ask)) continue;
    byKey.set(`${tick.timestamp}:${tick.bid}:${tick.ask}`, {
      time: new Date(tick.timestamp).toISOString(),
      timestamp: tick.timestamp,
      bid: tick.bid,
      ask: tick.ask,
    });
  }
  return [...byKey.values()].sort((a, b) => a.timestamp - b.timestamp || a.bid - b.bid || a.ask - b.ask);
}

function mergeCoverage(existingCoverage, nextCoverage) {
  const ranges = [...(existingCoverage ?? []), nextCoverage]
    .filter(r => Number.isFinite(r.from) && Number.isFinite(r.to) && r.from < r.to)
    .sort((a, b) => a.from - b.from);
  const merged = [];
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (last && range.from <= last.to + 1) {
      last.to = Math.max(last.to, range.to);
    } else {
      merged.push({ from: range.from, to: range.to });
    }
  }
  return merged;
}

function mergeBidAskTicks(bidTicks, askTicks) {
  const events = [
    ...bidTicks.map(t => ({ ...t, side: "bid" })),
    ...askTicks.map(t => ({ ...t, side: "ask" })),
  ].sort((a, b) => a.timestamp - b.timestamp || (a.side === "bid" ? -1 : 1));

  const merged = [];
  let bid = null;
  let ask = null;
  for (const event of events) {
    if (event.side === "bid") bid = event.price;
    else ask = event.price;
    if (Number.isFinite(bid) && Number.isFinite(ask)) {
      merged.push({
        time: event.time,
        timestamp: event.timestamp,
        bid,
        ask,
      });
    }
  }
  return mergeUniqueTicks([], merged);
}

async function fetchQuoteTicks(client, pair, from, to, quoteType) {
  const all = [];
  let cursorTo = to;
  let page = 0;

  while (cursorTo > from) {
    page += 1;
    const res = await withRetry(client, () => client.getTicks(pair, from, cursorTo, quoteType));
    all.push(...res.ticks);
    if (!res.hasMore) break;
    if (res.ticks.length === 0) {
      throw new Error(`Pagination stalled for ${pair} quoteType=${quoteType} ${new Date(from).toISOString()} -> ${new Date(cursorTo).toISOString()}`);
    }
    const earliest = Math.min(...res.ticks.map(t => t.timestamp));
    const nextCursor = earliest - 1;
    if (!Number.isFinite(nextCursor) || nextCursor >= cursorTo) {
      throw new Error(`Invalid pagination cursor for ${pair} quoteType=${quoteType} page=${page}`);
    }
    cursorTo = nextCursor;
  }

  const deduped = new Map();
  for (const tick of all) deduped.set(`${tick.timestamp}:${tick.price}`, tick);
  return [...deduped.values()].sort((a, b) => a.timestamp - b.timestamp);
}

async function downloadPairDay(client, pair, dayStart, dayEnd, db = null) {
  const day = dayKey(dayStart);
  const file = tickFilePath(pair, day);
  const existing = force ? null : readJsonGzip(file);

  console.log(`Fetching ${pair} ${day}: ${new Date(dayStart).toISOString()} -> ${new Date(dayEnd).toISOString()}`);
  const bid = await fetchQuoteTicks(client, pair, dayStart, dayEnd, 1);
  const ask = await fetchQuoteTicks(client, pair, dayStart, dayEnd, 2);
  const downloadedTicks = mergeBidAskTicks(bid, ask);
  const ticks = mergeUniqueTicks(existing?.ticks ?? [], downloadedTicks);
  const coverage = mergeCoverage(existing?.coverage, { from: dayStart, to: dayEnd });

  writeJsonGzip(file, {
    pair,
    day,
    coverage,
    updatedAt: new Date().toISOString(),
    bidTicksDownloaded: bid.length,
    askTicksDownloaded: ask.length,
    ticks,
  });

  if (db) {
    db.insertTicks(pair, ticks);
    db.saveCoverage(pair, day, dayStart, dayEnd);
    console.log(`Saved ${ticks.length} ticks to SQLite for ${pair} ${day}`);
  }

  console.log(`Saved ${ticks.length} merged ticks to ${file}`);
}

async function main() {
  const client = new ICMarketsClient();
  const db = useSqlite ? new TickDatabase() : null;

  for (const pair of pairs) {
    for (let cursor = utcDayStart(fromMs); cursor < toMs; cursor += DAY_MS) {
      const chunkFrom = Math.max(cursor, fromMs);
      const chunkTo = Math.min(cursor + DAY_MS, toMs);
      if (chunkFrom >= chunkTo) continue;
      await withRetry(client, () => downloadPairDay(client, pair, chunkFrom, chunkTo, db));
    }
  }

  if (db) db.close();
  process.exit(0);
}

main().catch(err => {
  console.error("❌ Tick download failed:", err.message);
  process.exit(1);
});
