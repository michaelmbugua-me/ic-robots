import fs from 'fs';
import path from 'path';
import WebSocket from 'ws';
import { config } from './config.js';

const CACHE_FILE = path.join(process.cwd(), 'news_cache.json');
const CACHE_TTL_MS = 1000 * 60 * 60 * 12; // 12 hour cache for news

export async function getRecentNews() {
  try {
    // 1. Check cache
    if (fs.existsSync(CACHE_FILE)) {
      const stats = fs.statSync(CACHE_FILE);
      if (Date.now() - stats.mtimeMs < CACHE_TTL_MS) {
        return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
      }
    }

    const apiKey = config.strategy.newsApiKey;
    if (!apiKey) return [];

    let data = await fetchFinnhubNews();

    if (data && data.length > 0) {
      fs.writeFileSync(CACHE_FILE, JSON.stringify(data, null, 2));
      console.log(`✅ Economic calendar updated via Finnhub (${data.length} events).`);
    }
    return data;
  } catch (error) {
    console.error('❌ Error updating news from Finnhub:', error.message);
    return fs.existsSync(CACHE_FILE) ? JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')) : [];
  }
}

/**
 * Fetches the latest Market News from Finnhub (Forex category).
 */
export async function getLatestMarketNews(limit = 10) {
  try {
    const apiKey = config.strategy.newsApiKey;
    if (!apiKey) return [];

    const url = `https://finnhub.io/api/v1/news?category=forex&token=${apiKey}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
    
    if (!response.ok) return [];

    const news = await response.json();
    return news.slice(0, limit).map(n => ({
      headline: n.headline,
      summary: n.summary,
      time: new Date(n.datetime * 1000).toISOString()
    }));
  } catch (err) {
    console.error('❌ Finnhub Market News error:', err.message);
    return [];
  }
}

/**
 * Formats news headlines for the AI prompt.
 * Uses WebSocket buffer if available, or falls back to REST.
 */
export async function getMarketNewsContext(limit = 5) {
  let news = [];
  
  if (global.finnhubWsClient && global.finnhubWsClient.getLatestNews().length > 0) {
    news = global.finnhubWsClient.getLatestNews(limit);
  } else {
    news = await getLatestMarketNews(limit);
  }

  if (!news || news.length === 0) return "MARKET NEWS: No recent headlines available.";

  let context = "LATEST MARKET NEWS (FOREX):\n";
  news.forEach((n, i) => {
    context += `${i + 1}. ${n.headline} (${new Date(n.time).toISOString().split('T')[1].slice(0, 5)} UTC)\n`;
  });
  return context;
}


async function fetchFinnhubNews() {
  try {
    const apiKey = config.strategy.newsApiKey;
    const url = `https://finnhub.io/api/v1/calendar/economic?token=${apiKey}`;
    
    const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) {
      if (response.status === 403) {
        console.warn(`⚠️ Finnhub Economic Calendar is a premium feature. Free users might only see Market Headlines via REST/WS.`);
      } else {
        console.error(`❌ Finnhub API Error: ${response.status}`);
      }
      return [];
    }

    const raw = await response.json();
    const economicEvents = raw.economicCalendar || [];

    // Map Finnhub to Forex Factory format for consistency
    return economicEvents.map(e => ({
      title: e.event,
      country: normalizeCountry(e.country),
      date: e.time, // Finnhub uses UTC string
      impact: mapFinnhubImpact(e.impact),
      forecast: e.estimate,
      previous: e.prev
    }));
  } catch (err) {
    console.error('❌ Finnhub fetch error:', err.message);
    return [];
  }
}

function normalizeCountry(code) {
  const mapping = { 'US': 'USD', 'EU': 'EUR', 'GB': 'GBP', 'JP': 'JPY', 'CH': 'CHF', 'CA': 'CAD', 'AU': 'AUD', 'NZ': 'NZD' };
  return mapping[code] || code;
}

function mapFinnhubImpact(impact) {
  // Finnhub impact: 1 (low), 2 (med), 3 (high) OR strings
  if (impact === 3 || impact === 'high') return 'High';
  if (impact === 2 || impact === 'med') return 'Medium';
  return 'Low';
}

/**
 * Finnhub WebSocket Client for real-time news
 */
export class FinnhubWSClient {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.ws = null;
    this.newsBuffer = [];
    this.maxBufferSize = 20;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 5;
    this.isClosed = false;
  }

  connect() {
    if (!this.apiKey) {
      console.warn("⚠️ Finnhub API Key missing. WebSocket news disabled.");
      return;
    }

    const url = `wss://ws.finnhub.io?token=${this.apiKey}`;
    this.ws = new WebSocket(url);

    this.ws.on('open', () => {
      console.log("✅ Connected to Finnhub WebSocket News feed.");
      this.reconnectAttempts = 0;
      // Note: For some tiers, no explicit subscribe is needed for news.
      // If symbols are needed, we can subscribe to them here.
    });

    this.ws.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString());
        if (message.type === 'news') {
          this._handleNews(message.data);
        }
      } catch (err) {
        // Silently ignore parse errors
      }
    });

    this.ws.on('error', (err) => {
      console.error("❌ Finnhub WebSocket Error:", err.message);
    });

    this.ws.on('close', () => {
      console.log("ℹ️ Finnhub WebSocket closed.");
      this._attemptReconnect();
    });
  }

  _handleNews(newsItems) {
    if (!Array.isArray(newsItems)) return;

    newsItems.forEach(item => {
      const newsEntry = {
        headline: item.headline,
        summary: item.summary,
        time: new Date(item.datetime * 1000).toISOString(),
        category: item.category
      };

      // Add to front of buffer
      this.newsBuffer.unshift(newsEntry);
      
      // Limit buffer size
      if (this.newsBuffer.length > this.maxBufferSize) {
        this.newsBuffer.pop();
      }
    });
  }

  _attemptReconnect() {
    if (this.isClosed) return;
    if (this.reconnectAttempts < this.maxReconnectAttempts) {
      this.reconnectAttempts++;
      const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
      console.log(`🔄 Attempting to reconnect to Finnhub WS in ${delay/1000}s...`);
      setTimeout(() => this.connect(), delay);
    } else {
      console.error("❌ Max Finnhub WS reconnect attempts reached.");
    }
  }

  getLatestNews(limit = 5) {
    return this.newsBuffer.slice(0, limit);
  }

  close() {
    this.isClosed = true;
    if (this.ws) {
      this.ws.close();
    }
  }
}

/**
 * Checks if we are currently in a high-impact news window for a given pair.
 * @param {string} pair e.g. "EUR_USD"
 * @param {number} beforeMin minutes before news
 * @param {number} afterMin minutes after news
 */
export async function isNearHighImpactNews(pair, beforeMin = 30, afterMin = 30) {
  const allNews = await getRecentNews();
  const currencies = pair.split('_'); // ["EUR", "USD"]
  const now = new Date();

  return allNews.some(event => {
    // We only care about High impact events for our currencies
    if (event.impact !== 'High') return false;
    if (!currencies.includes(event.country)) return false;

    const eventDate = new Date(event.date);
    const diffMs = eventDate.getTime() - now.getTime();
    const diffMin = diffMs / (1000 * 60);

    // If news is within [beforeMin] in the future OR within [afterMin] in the past
    return diffMin > -afterMin && diffMin < beforeMin;
  });
}
