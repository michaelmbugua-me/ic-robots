/**
 * Historical Data Downloader for IC Markets
 * Fetches EUR_USD candles and saves them to a JSON file.
 */

import fs from "fs";
import { ICMarketsClient } from "./icmarkets.js";
import { config } from "./config.js";

const args = process.argv.slice(2);
const pairArg = args.find(a => a.startsWith('--pair='))?.split('=')[1]
              || (args.includes('--pair') ? args[args.indexOf('--pair') + 1] : null);
const daysArg = args.find(a => a.startsWith('--days='))?.split('=')[1]
              || (args.includes('--days') ? args[args.indexOf('--days') + 1] : null);
const chunkArg = args.find(a => a.startsWith('--chunk-size='))?.split('=')[1]
              || (args.includes('--chunk-size') ? args[args.indexOf('--chunk-size') + 1] : null);
const resume = args.includes('--resume');

const PAIRS = pairArg 
            ? pairArg.split(",").map(s => s.trim()) 
            : (config.tradingPairs || [config.defaultInstrument || "EUR_USD"]);
const GRANULARITY = config.granularity || "M5";

// Calculate bars needed
const PERIOD_MS = {
  M1: 60_000, M5: 300_000, M15: 900_000, M30: 1_800_000,
  H1: 3_600_000, H4: 14_400_000, D1: 86_400_000,
};
const days = parseInt(daysArg) || 30;
const periodMs = PERIOD_MS[GRANULARITY] || 300_000;
const MAX_BARS = Math.ceil((days * 86_400_000) / periodMs);
const CHUNK_SIZE = parseInt(chunkArg) || 2500;
const MAX_RETRIES = 3;

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function withRetries(label, fn) {
  let lastErr;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const waitMs = attempt * 2000;
      console.log(`\n    ⚠️  ${label} failed (${err.message}). Retry ${attempt}/${MAX_RETRIES} in ${waitMs / 1000}s...`);
      await sleep(waitMs);
    }
  }
  throw lastErr;
}

function loadExistingBars(outputFile) {
  if (!resume || !fs.existsSync(outputFile)) return new Map();
  try {
    const existing = JSON.parse(fs.readFileSync(outputFile, "utf8"));
    if (!Array.isArray(existing)) return new Map();
    const map = new Map(existing.filter(b => b?.time).map(b => [b.time, b]));
    console.log(`  ♻️  Resume enabled — loaded ${map.size} existing candles from ${outputFile}`);
    return map;
  } catch (err) {
    console.log(`  ⚠️  Could not load existing ${outputFile}: ${err.message}`);
    return new Map();
  }
}

function saveBars(outputFile, allBarsMap) {
  const allBars = Array.from(allBarsMap.values()).sort((a, b) => new Date(a.time) - new Date(b.time));
  fs.writeFileSync(outputFile, JSON.stringify(allBars, null, 2));
  return allBars;
}

async function main() {
  const icmarkets = new ICMarketsClient();

  try {
    console.log(`\n--- IC Markets Data Downloader ---`);
    console.log(`Pairs       : ${PAIRS.join(", ")}`);
    console.log(`Granularity : ${GRANULARITY}`);
    console.log(`Days        : ${days}`);
    console.log(`Chunk size  : ${CHUNK_SIZE}`);
    console.log(`Resume      : ${resume ? "yes" : "no"}`);
    console.log(`Target      : ${MAX_BARS} bars per pair\n`);

    // Connect and authenticate once
    process.stdout.write("Connecting to IC Markets...");
    await icmarkets.connect();
    process.stdout.write(" ✓\nAuthenticating...");
    await icmarkets.authenticate();
    process.stdout.write(" ✓\n");

    for (const PAIR of PAIRS) {
      const OUTPUT_FILE = `history_${PAIR.replace("/", "_")}.json`;
      console.log(`\nFetching ${MAX_BARS} candles for ${PAIR} (${GRANULARITY})...`);

      let allBarsMap = loadExistingBars(OUTPUT_FILE); // Use Map to merge Bid and Ask by timestamp
      let toTimestamp = Date.now();
      if (resume && allBarsMap.size > 0) {
        const oldest = Array.from(allBarsMap.keys()).sort()[0];
        toTimestamp = new Date(oldest).getTime();
      }
      let fetchedCount = allBarsMap.size;

      while (fetchedCount < MAX_BARS) {
        const remaining = MAX_BARS - fetchedCount;
        const count = Math.min(CHUNK_SIZE, remaining);

        process.stdout.write(`  Fetching ${count} bars before ${new Date(toTimestamp).toISOString()}... `);
        
        // Fetch BID
        const bidBars = await withRetries("BID candles", () => icmarkets.getCandles(PAIR, GRANULARITY, count, null, toTimestamp, 1));
        if (bidBars.length === 0) {
          console.log(`\n  ⚠️  No more bars returned by broker for ${PAIR}. Ending download.`);
          break;
        }

        // Fetch ASK for the same period
        const askBars = await withRetries("ASK candles", () => icmarkets.getCandles(PAIR, GRANULARITY, bidBars.length, new Date(bidBars[0].time).getTime(), new Date(bidBars[bidBars.length - 1].time).getTime(), 2));

        // Merge them
        for (let i = 0; i < bidBars.length; i++) {
          const bid = bidBars[i];
          const ask = askBars.find(a => a.time === bid.time) || bid; // Fallback to bid if ask missing (rare)
          
          allBarsMap.set(bid.time, {
            time: bid.time,
            volume: bid.volume,
            bid: bid.mid, // icmarkets.js returns OHLV in 'mid' property
            ask: ask.mid,
            mid: {
              o: ((parseFloat(bid.mid.o) + parseFloat(ask.mid.o)) / 2).toFixed(5),
              h: ((parseFloat(bid.mid.h) + parseFloat(ask.mid.h)) / 2).toFixed(5),
              l: ((parseFloat(bid.mid.l) + parseFloat(ask.mid.l)) / 2).toFixed(5),
              c: ((parseFloat(bid.mid.c) + parseFloat(ask.mid.c)) / 2).toFixed(5),
            }
          });
        }

        fetchedCount = allBarsMap.size;
        toTimestamp = new Date(bidBars[0].time).getTime();
        const saved = saveBars(OUTPUT_FILE, allBarsMap);

        console.log(`✓ (Saved: ${saved.length})`);
        await sleep(750);
      }

      const allBars = saveBars(OUTPUT_FILE, allBarsMap);
      console.log(`Successfully saved ${allBars.length} candles to ${OUTPUT_FILE}`);
    }

  } catch (err) {
    console.error("\n❌ Error:", err.message);
  } finally {
    process.exit();
  }
}

main();
