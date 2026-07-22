/**
 * Update History Files — fetches newer candles from IC Markets
 * Walks backward from `--to` (default: now) until reaching the
 * latest existing candle, filling the gap.
 */

import fs from "fs";
import { ICMarketsClient } from "./icmarkets.js";
import { config } from "./config.js";

const args = process.argv.slice(2);
const pairArg = args.find(a => a.startsWith("--pair="))?.split("=")[1]
  || (args.includes("--pair") ? args[args.indexOf("--pair") + 1] : null);
const toArg = args.find(a => a.startsWith("--to="))?.split("=")[1]
  || (args.includes("--to") ? args[args.indexOf("--to") + 1] : null);

const PAIRS = pairArg
  ? pairArg.split(",").map(s => s.trim())
  : (config.tradingPairs || [config.defaultInstrument || "EUR_USD"]);

const GRANULARITY = config.granularity || "M5";
const CHUNK_SIZE = 2500;
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
      console.log(`  ⚠️  ${label} failed (${err.message}). Retry ${attempt}/${MAX_RETRIES} in ${waitMs / 1000}s...`);
      await sleep(waitMs);
    }
  }
  throw lastErr;
}

function loadHistory(filePath) {
  if (!fs.existsSync(filePath)) return new Map();
  try {
    const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!Array.isArray(data)) return new Map();
    return new Map(data.filter(b => b?.time).map(b => [b.time, b]));
  } catch (err) {
    console.log(`  ⚠️  Could not parse ${filePath}: ${err.message}`);
    return new Map();
  }
}

function saveHistory(filePath, barsMap) {
  const sorted = Array.from(barsMap.values())
    .sort((a, b) => new Date(a.time) - new Date(b.time));
  fs.writeFileSync(filePath, JSON.stringify(sorted, null, 2));
  return sorted;
}

async function main() {
  const icmarkets = new ICMarketsClient();
  const toDate = toArg ? new Date(toArg) : new Date();

  try {
    console.log(`\n--- IC Markets History Updater ---`);
    console.log(`Pairs     : ${PAIRS.join(", ")}`);
    console.log(`Granularity: ${GRANULARITY}`);
    console.log(`Update to : ${toDate.toISOString()}\n`);

    process.stdout.write("Connecting to IC Markets...");
    await icmarkets.connect();
    process.stdout.write(" ✓\nAuthenticating...");
    await icmarkets.authenticate();
    process.stdout.write(" ✓\n");

    for (const PAIR of PAIRS) {
      const OUTPUT_FILE = `history_${PAIR.replace("/", "_")}.json`;
      console.log(`\nUpdating ${PAIR}...`);

      const barsMap = loadHistory(OUTPUT_FILE);
      const existingSize = barsMap.size;
      if (existingSize === 0) {
        console.log(`  No existing data. Use download-history.js instead.`);
        continue;
      }

      // Find the latest existing candle
      const latestExisting = Array.from(barsMap.values())
        .sort((a, b) => new Date(b.time) - new Date(a.time))[0];
      const latestMs = new Date(latestExisting.time).getTime();
      console.log(`  Latest existing: ${latestExisting.time} (${existingSize} bars)`);

      // Walk backward from toDate, fetching chunks until we reach the existing data
      let toTimestamp = toDate.getTime();
      let totalNew = 0;
      let reachedExisting = false;

      while (toTimestamp > latestMs && !reachedExisting) {
        const count = CHUNK_SIZE;
        process.stdout.write(`  Fetching ${count} bars before ${new Date(toTimestamp).toISOString()}... `);

        // Fetch BID candles
        let bidBars;
        try {
          bidBars = await withRetries("BID candles", () =>
            icmarkets.getCandles(PAIR, GRANULARITY, count, null, toTimestamp, 1)
          );
        } catch (err) {
          if (err.message.includes("No trendbar data")) {
            console.log(`\n  ⚠️  No more data for ${PAIR}. Done.`);
            break;
          }
          throw err;
        }

        if (!bidBars || bidBars.length === 0) {
          console.log(`\n  ⚠️  No bars returned for ${PAIR}. Done.`);
          break;
        }

        // Fetch ASK candles for the same range
        const firstMs = new Date(bidBars[0].time).getTime();
        const lastMs = new Date(bidBars[bidBars.length - 1].time).getTime();
        let askBars;
        try {
          askBars = await withRetries("ASK candles", () =>
            icmarkets.getCandles(PAIR, GRANULARITY, bidBars.length, firstMs, lastMs, 2)
          );
        } catch (err) {
          console.log(`\n  ⚠️  ASK fetch failed, using BID only: ${err.message}`);
          askBars = bidBars;
        }

        // Merge BID + ASK into the map
        let newCount = 0;
        for (let i = 0; i < bidBars.length; i++) {
          const bid = bidBars[i];
          const ask = (askBars && askBars.length > i)
            ? askBars.find(a => a.time === bid.time) || bid
            : bid;

          if (!barsMap.has(bid.time)) newCount++;

          barsMap.set(bid.time, {
            time: bid.time,
            volume: bid.volume,
            bid: bid.mid,
            ask: ask.mid,
            mid: {
              o: ((parseFloat(bid.mid.o) + parseFloat(ask.mid.o)) / 2).toFixed(5),
              h: ((parseFloat(bid.mid.h) + parseFloat(ask.mid.h)) / 2).toFixed(5),
              l: ((parseFloat(bid.mid.l) + parseFloat(ask.mid.l)) / 2).toFixed(5),
              c: ((parseFloat(bid.mid.c) + parseFloat(ask.mid.c)) / 2).toFixed(5),
            },
          });
        }

        totalNew += newCount;

        // Move toTimestamp backward past the oldest bar we just fetched
        toTimestamp = firstMs - 1;

        // Save intermediate results after each chunk (like download-history.js)
        saveHistory(OUTPUT_FILE, barsMap);

        console.log(`✓ (+${newCount} new, total: ${barsMap.size})`);

        // Check if we've reached or passed the existing data
        const oldestFetched = new Date(bidBars[0].time).getTime();
        if (oldestFetched <= latestMs) {
          reachedExisting = true;
          console.log(`  ✅ Reached existing data at ${latestExisting.time}`);
        }

        // If we got very few bars, we're probably near the end
        if (bidBars.length < 100) break;

        await sleep(750);
      }

      if (totalNew > 0) {
        const saved = saveHistory(OUTPUT_FILE, barsMap);
        console.log(`  ✅ Saved ${saved.length} total candles to ${OUTPUT_FILE} (+${totalNew} new)`);
      } else {
        console.log(`  ✅ ${OUTPUT_FILE} is already up to date.`);
      }
    }

    console.log("\n--- Update complete ---\n");
  } catch (err) {
    console.error("\n❌ Error:", err.message);
  } finally {
    process.exit();
  }
}

main();
