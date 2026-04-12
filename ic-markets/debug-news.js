import { getRecentNews, isNearHighImpactNews, getMarketNewsContext, FinnhubWSClient } from './news.js';
import { config } from './config.js';
import dns from 'dns';
import fs from 'fs';

async function testDns(host) {
  return new Promise((resolve) => {
    dns.lookup(host, (err, address, family) => {
      if (err) {
        console.log(`❌ DNS lookup failed for ${host}: ${err.message}`);
        resolve(null);
      } else {
        console.log(`✅ DNS lookup successful for ${host}: ${address} (IPv${family})`);
        resolve(address);
      }
    });
  });
}

async function main() {
  console.log("--- News Connectivity & Logic Test ---\n");

  const apiKey = config.strategy.newsApiKey;

  console.log(`API Key set: ${apiKey ? 'Yes' : 'No'}`);

  // 1. Test DNS for Finnhub
  await testDns('finnhub.io');

  // 3. Test news logic
  console.log("\n--- Testing News Logic ---");
  try {
    const news = await getRecentNews();
    if (news && news.length > 0) {
      console.log(`✅ Success! Received ${news.length} events.`);
      console.log("Sample event:", JSON.stringify(news[0], null, 2));
      
      const isNear = await isNearHighImpactNews("EUR_USD");
      console.log(`\nNear high-impact news for EUR_USD? ${isNear ? '⚠️ YES (Trading Blocked)' : '✅ No (Safe to Trade)'}`);
    } else {
      console.log("❌ Failed to receive any news events.");
    }

    if (apiKey) {
      console.log("\n--- Testing Finnhub Market Headlines (REST) ---");
      const headlines = await getMarketNewsContext(5);
      console.log(headlines);

      console.log("\n--- Testing Finnhub WebSocket News ---");
      const wsClient = new FinnhubWSClient(apiKey);
      global.finnhubWsClient = wsClient; // So getMarketNewsContext can see it
      wsClient.connect();

      console.log("Waiting 5 seconds for any real-time news...");
      await new Promise(r => setTimeout(r, 5000));

      const wsNews = wsClient.getLatestNews(3);
      if (wsNews.length > 0) {
        console.log("✅ Success! Received real-time news via WebSocket:");
        console.log(JSON.stringify(wsNews, null, 2));
      } else {
        console.log("ℹ️ No real-time news received in 5 seconds (normal if no news just broke).");
      }
      wsClient.close();
    }
  } catch (err) {
    console.log(`❌ Error during test: ${err.message}`);
  }

  console.log("\n--- Instructions for User ---");
  console.log("1. Get a free API key at https://finnhub.io");
  console.log("2. Add it to your .env file as NEWS_API_KEY.");
  console.log("3. The bot now automatically connects to Finnhub via WebSockets and REST.");
}

main();
