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

const PAIR = pairArg || config.defaultInstrument || "EUR_USD";
const GRANULARITY = config.granularity || "M5";
const OUTPUT_FILE = "history.json";

// Calculate bars needed
const PERIOD_MS = {
  M1: 60_000, M5: 300_000, M15: 900_000, M30: 1_800_000,
  H1: 3_600_000, H4: 14_400_000, D1: 86_400_000,
};
const days = parseInt(daysArg) || 30;
const periodMs = PERIOD_MS[GRANULARITY] || 300_000;
const MAX_BARS = Math.ceil((days * 86_400_000) / periodMs);

async function main() {
  const icmarkets = new ICMarketsClient();

  try {
    console.log(`\n--- IC Markets Data Downloader ---`);
    console.log(`Pair        : ${PAIR}`);
    console.log(`Granularity : ${GRANULARITY}`);
    console.log(`Days        : ${days}`);
    console.log(`Target      : ${MAX_BARS} bars\n`);

    // Connect and authenticate
    process.stdout.write("Connecting to IC Markets...");
    await icmarkets.connect();
    process.stdout.write(" ✓\nAuthenticating...");
    await icmarkets.authenticate();
    process.stdout.write(" ✓\n");

    console.log(`Fetching ${MAX_BARS} candles for ${PAIR} (${GRANULARITY})...`);

    // We fetch in chunks of 5000
    const chunkSize = 5000;
    let allBarsMap = new Map(); // Use Map to merge Bid and Ask by timestamp
    let toTimestamp = Date.now();
    let fetchedCount = 0;

    while (fetchedCount < MAX_BARS) {
      const remaining = MAX_BARS - fetchedCount;
      const count = Math.min(chunkSize, remaining);

      process.stdout.write(`  Fetching ${count} bars before ${new Date(toTimestamp).toISOString()}... `);
      
      // Fetch BID
      const bidBars = await icmarkets.getCandles(PAIR, GRANULARITY, count, null, toTimestamp, 1);
      if (bidBars.length === 0) {
        console.log(`\n  ⚠️  No more bars returned by broker. Ending download.`);
        break;
      }

      // Fetch ASK for the same period
      const askBars = await icmarkets.getCandles(PAIR, GRANULARITY, bidBars.length, new Date(bidBars[0].time).getTime(), new Date(bidBars[bidBars.length - 1].time).getTime(), 2);

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

      fetchedCount += bidBars.length;
      toTimestamp = new Date(bidBars[0].time).getTime();
      
      console.log(`✓ (Total: ${fetchedCount})`);
      await new Promise(r => setTimeout(r, 500));
    }

    // Convert Map to sorted array
    const allBars = Array.from(allBarsMap.values()).sort((a, b) => new Date(a.time) - new Date(b.time));

    // Save to file
    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(allBars, null, 2));
    console.log(`\nSuccessfully saved ${allBars.length} candles to ${OUTPUT_FILE}`);

  } catch (err) {
    console.error("\n❌ Error:", err.message);
  } finally {
    process.exit();
  }
}

main();
