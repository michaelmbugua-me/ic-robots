/**
 * Alpaca API Client
 * Handles both Stocks and Crypto via simple REST
 *
 * Docs: https://docs.alpaca.markets
 * Auth: API Key + Secret in headers (no OAuth needed)
 */

import WebSocket from "ws";
import { config } from "./config.js";

// ─── Asset type detection ─────────────────────────────────────────────────────

const CRYPTO_SYMBOLS = new Set([
  "BTC/USD", "ETH/USD", "SOL/USD", "AVAX/USD",
  "DOGE/USD", "MATIC/USD", "LTC/USD", "BCH/USD",
]);

export function isCrypto(symbol) {
  return CRYPTO_SYMBOLS.has(symbol) || symbol.includes("/");
}

// ─── Timeframe mapping ────────────────────────────────────────────────────────
// Our config strings → Alpaca timeframe strings
const TIMEFRAME = {
  M1:  "1Min",
  M5:  "5Min",
  M15: "15Min",
  M30: "30Min",
  H1:  "1Hour",
  H4:  "4Hour",
  D1:  "1Day",
};

export class AlpacaClient {
  constructor() {
    this.paper = config.alpacaEnv === "paper";

    // Trading API base URL
    this.tradeBase = this.paper
      ? "https://paper-api.alpaca.markets/v2"
      : "https://api.alpaca.markets/v2";

    // Market data base URLs
    this.stockDataBase  = "https://data.alpaca.markets/v2/stocks";
    this.cryptoDataBase = "https://data.alpaca.markets/v1beta3/crypto/us";

    this.headers = {
      "APCA-API-KEY-ID":     config.alpacaApiKey,
      "APCA-API-SECRET-KEY": config.alpacaSecretKey,
      "Content-Type":        "application/json",
    };

    // Cache
    this._balance      = null;
    this._lastBalFetch = 0;

    // Stream instances
    this.dataStream    = null;
    this.tradingStream = null;

    // Reconnect logic
    this._dataReconnectDelay = 5000;
    this._dataReconnectTimer = null;
    this._tradingReconnectTimer = null;
  }

  // ─── WebSocket Streams ─────────────────────────────────────────────────────

  /**
   * Connect to market data stream for a specific symbol
   */
  connectDataStream(symbol, onBar) {
    if (this._dataReconnectTimer) {
      clearTimeout(this._dataReconnectTimer);
      this._dataReconnectTimer = null;
    }

    if (this.dataStream) {
      this.dataStream.removeAllListeners();
      try { this.dataStream.terminate(); } catch (e) {}
      this.dataStream = null;
    }

    const crypto = isCrypto(symbol);
    const url = crypto ? config.websocket.cryptoData : config.websocket.stockData;

    this.dataStream = new WebSocket(url);

    this.dataStream.on("open", () => {
      // Wait for the "connected" message from Alpaca before sending auth
      console.log(`  🔌 Data Stream: Connected to ${url}. Waiting for welcome...`);
    });

    this.dataStream.on("message", (data) => {
      try {
        const msgs = JSON.parse(data.toString());
        for (const msg of msgs) {
          // Welcome message -> Authenticate
          if (msg.msg === "connected") {
            this.dataStream.send(JSON.stringify({
              action: "auth",
              key:    config.alpacaApiKey,
              secret: config.alpacaSecretKey,
            }));
          }

          if (msg.msg === "authenticated") {
            // Reset delay on successful auth
            this._dataReconnectDelay = 5000;

            // 2. Subscribe to bars
            this.dataStream.send(JSON.stringify({
              action:    "subscribe",
              bars:      [symbol],
            }));
            console.log(`  🔌 Data Stream: Authenticated. Subscribing to ${symbol}...`);
          }

          if (msg.T === "subscription") {
            console.log(`  🔌 Data Stream: Successfully subscribed to ${msg.bars?.join(", ") || "nothing"}`);
          }

          if (msg.T === "b") { // Bar message
            const bar = crypto ? this._normaliseCryptoBar(msg) : this._normaliseStockBar(msg);
            onBar(bar);
          }

          if (msg.T === "error") {
            console.error(`  ❌ Data Stream Error: ${msg.msg} (Code: ${msg.code})`);
            
            if (msg.code === 406 || msg.code === 404) {
              // Double backoff on limit/timeout errors
              this._dataReconnectDelay = Math.min(this._dataReconnectDelay * 2, 60000);
              console.log(`     Backing off... next attempt in ${this._dataReconnectDelay / 1000}s`);
              if (msg.code === 406) {
                console.error("     Tip: It looks like another bot is already connected using this API key.");
                console.error("          Alpaca Free/Paper allows only 1 concurrent data connection.");
              }
              this.dataStream.terminate(); // Triggers "close"
            }
            
            if (msg.code === 401) {
              console.error("     Tip: Check your APCA_API_KEY_ID and APCA_API_SECRET_KEY in .env");
            }
          }
        }
      } catch (err) {
        console.error("  ❌ Data Stream Parse Error:", err.message);
      }
    });

    this.dataStream.on("error", (err) => console.error("  ❌ Data Stream WebSocket Error:", err.message));
    this.dataStream.on("close", () => {
      if (this._dataReconnectTimer) return;
      console.log(`  🔌 Data Stream closed. Reconnecting in ${this._dataReconnectDelay / 1000}s...`);
      this._dataReconnectTimer = setTimeout(() => this.connectDataStream(symbol, onBar), this._dataReconnectDelay);
    });
  }

  /**
   * Connect to trading stream for order updates
   */
  connectTradingStream(onUpdate) {
    if (this._tradingReconnectTimer) {
      clearTimeout(this._tradingReconnectTimer);
      this._tradingReconnectTimer = null;
    }

    if (this.tradingStream) {
      this.tradingStream.removeAllListeners();
      try { this.tradingStream.terminate(); } catch (e) {}
      this.tradingStream = null;
    }

    this.tradingStream = new WebSocket(config.websocket.trading);

    this.tradingStream.on("open", () => {
      // 1. Authenticate
      this.tradingStream.send(JSON.stringify({
        action: "authenticate",
        data: {
          key_id:     config.alpacaApiKey,
          secret_key: config.alpacaSecretKey,
        },
      }));
    });

    this.tradingStream.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());

        if (msg.stream === "authorization" && msg.data.status === "authorized") {
          // 2. Subscribe to trade updates
          this.tradingStream.send(JSON.stringify({
            action: "listen",
            data: {
              streams: ["trade_updates"],
            },
          }));
          console.log("  🔌 Trading Stream: Authenticated & Listening");
        }

        if (msg.stream === "trade_updates") {
          onUpdate(msg.data);
        }
      } catch (err) {
        console.error("  ❌ Trading Stream Parse Error:", err.message);
      }
    });

    this.tradingStream.on("error", (err) => console.error("  ❌ Trading Stream WebSocket Error:", err.message));
    this.tradingStream.on("close", () => {
      if (this._tradingReconnectTimer) return;
      console.log("  🔌 Trading Stream closed. Reconnecting in 5s...");
      this._tradingReconnectTimer = setTimeout(() => this.connectTradingStream(onUpdate), 5000);
    });
  }

  // ─── Core fetch ──────────────────────────────────────────────────────────

  async _request(url, method = "GET", body = null) {
    const opts = { method, headers: this.headers };
    if (body) opts.body = JSON.stringify(body);

    const res = await fetch(url, opts);

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Alpaca ${method} ${url} → ${res.status}: ${err}`);
    }

    // 204 No Content
    if (res.status === 204) return null;
    return res.json();
  }

  // ─── Market Data ─────────────────────────────────────────────────────────

  /**
   * Get historical bars (candles)
   * Returns normalised candle array compatible with indicators.js
   *
   * @param {string} symbol     e.g. "AAPL", "BTC/USD"
   * @param {string} granularity e.g. "M5", "M15"
   * @param {number} count      number of bars to fetch
   */
  async getCandles(symbol, granularity = "M5", count = 100) {
    const tf = TIMEFRAME[granularity] ?? "5Min";
    const crypto = isCrypto(symbol);

    // Calculate start time from count + timeframe
    const tfMs = this._timeframeToMs(granularity);
    const start = new Date(Date.now() - tfMs * (count + 10)).toISOString();

    let url, data;

    if (crypto) {
      // Crypto: /v1beta3/crypto/us/bars?symbols=BTC/USD&timeframe=5Min
      const encoded = encodeURIComponent(symbol);
      url = `${this.cryptoDataBase}/bars?symbols=${encoded}&timeframe=${tf}&start=${start}&limit=${count}&sort=asc`;
      data = await this._request(url);
      const bars = data?.bars?.[symbol] ?? [];
      return bars.map(this._normaliseCryptoBar);
    } else {
      // Stocks: /v2/stocks/{symbol}/bars
      url = `${this.stockDataBase}/${symbol}/bars?timeframe=${tf}&start=${start}&limit=${count}&sort=asc&feed=iex`;
      data = await this._request(url);
      return (data?.bars ?? []).map(this._normaliseStockBar);
    }
  }

  /**
   * Get latest quote (price) for a symbol
   * @param {string} symbol
   * @param {string} side - "buy" or "sell" to get relevant price (ask/bid)
   */
  async getLatestPrice(symbol, side = "buy") {
    const crypto = isCrypto(symbol);
    let url, data;

    if (crypto) {
      const encoded = encodeURIComponent(symbol);
      url = `${this.cryptoDataBase}/latest/quotes?symbols=${encoded}`;
      data = await this._request(url);
      const quote = data?.quotes?.[symbol];
      if (!quote) return 0;
      return side === "buy" ? parseFloat(quote.ap || 0) : parseFloat(quote.bp || 0);
    } else {
      url = `${this.stockDataBase}/${symbol}/quotes/latest?feed=iex`;
      data = await this._request(url);
      const quote = data?.quote;
      if (!quote) return 0;
      return side === "buy" ? parseFloat(quote.ap || 0) : parseFloat(quote.bp || 0);
    }
  }

  // ─── Account ─────────────────────────────────────────────────────────────

  /**
   * Get account info with optional caching (default 60s)
   */
  async getAccount(force = false) {
    const now = Date.now();
    if (!force && this._balance && (now - this._lastBalFetch < 60_000)) {
      return { balance: this._balance, currency: "USD" };
    }

    const data = await this._request(`${this.tradeBase}/account`);
    this._balance = parseFloat(data.cash);
    this._lastBalFetch = now;

    return {
      balance:  this._balance,
      equity:   parseFloat(data.equity),
      currency: "USD",
      buyingPower: parseFloat(data.buying_power),
    };
  }

  async getOpenPositions() {
    return this._request(`${this.tradeBase}/positions`);
  }

  // ─── Orders ──────────────────────────────────────────────────────────────

  /**
   * Place an order with bracket (stop loss + take profit)
   *
   * @param {object} params
   * @param {string} params.symbol      e.g. "AAPL" or "BTC/USD"
   * @param {number} params.units       positive = buy, negative = sell/short
   * @param {string} params.stopLoss    price string
   * @param {string} params.takeProfit  price string
   * @param {string} params.type        "market" (default) or "limit"
   * @param {number} params.price       limit price (required if type="limit")
   */
  async createOrder({ symbol, units, stopLoss, takeProfit, type = "market", price = null }) {
    const side = units > 0 ? "buy" : "sell";
    const qty  = Math.abs(units);
    const crypto = isCrypto(symbol);

    const body = {
      symbol,
      side,
      type,
      time_in_force: crypto ? "gtc" : "day",   // crypto = GTC, stocks = day
    };

    if (crypto) {
      // Bracket orders (OTOCO) are not supported for Crypto on Alpaca yet.
      // We will use a "simple" order and manage the exit in index.js.
      body.order_class = "simple";
    } else {
      body.order_class = "bracket";
      body.stop_loss   = { stop_price: stopLoss };
      body.take_profit = { limit_price: takeProfit };
    }

    if (type === "limit" && price) {
      body.limit_price = crypto ? price.toFixed(6) : price.toFixed(2);
    }

    // Crypto uses "qty", fractional stocks use "qty" too
    if (crypto) {
      body.qty = qty.toFixed(6);    // crypto supports fractional qty
    } else {
      body.qty = String(Math.floor(qty));   // stocks = whole shares
    }

    const order = await this._request(`${this.tradeBase}/orders`, "POST", body);

    return {
      id:         order.id,
      price:      parseFloat(order.filled_avg_price ?? 0),
      units:      qty,
      symbol,
      time:       order.created_at,
      status:     order.status,
    };
  }

  /**
   * Cancel/close a specific order or position
   */
  async closeTrade(orderId) {
    // Try closing as a position first
    try {
      const encodedId = encodeURIComponent(orderId);
      return await this._request(
        `${this.tradeBase}/positions/${encodedId}`,
        "DELETE"
      );
    } catch {
      // Fall back to cancelling an open order
      return this._request(`${this.tradeBase}/orders/${orderId}`, "DELETE");
    }
  }

  /**
   * Close all open positions (useful for end-of-day cleanup)
   */
  async closeAllPositions() {
    return this._request(`${this.tradeBase}/positions`, "DELETE");
  }

  /**
   * Cancel all open orders
   */
  async cancelAllOrders() {
    return this._request(`${this.tradeBase}/orders`, "DELETE");
  }

  // ─── Market Hours Check ───────────────────────────────────────────────────

  /**
   * Check if US stock market is currently open
   * US Market: 9:30am - 4:00pm ET, Mon-Fri
   */
  isMarketOpenLocal() {
    const now = new Date();
    // Use New York time
    const et = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
    const day = et.getDay(); // 0=Sun, 6=Sat
    const h   = et.getHours();
    const m   = et.getMinutes();
    const t   = h * 60 + m;

    // Mon-Fri, 9:30am (570) to 4:00pm (960)
    return day >= 1 && day <= 5 && t >= 570 && t < 960;
  }

  /**
   * Remote check (API call)
   */
  async isMarketOpen(symbol) {
    if (isCrypto(symbol)) return true;

    const data = await this._request(`${this.tradeBase}/clock`);
    return data?.is_open ?? false;
  }

  // ─── Bar Normalisers ──────────────────────────────────────────────────────
  // Convert Alpaca bar format → our standard candle format (same as OANDA)

  _normaliseStockBar(bar) {
    return {
      time:     bar.t,
      complete: true,
      volume:   bar.v,
      vwap:     bar.vw, // Volume weighted average price for this bar
      mid: {
        o: String(bar.o),
        h: String(bar.h),
        l: String(bar.l),
        c: String(bar.c),
      },
    };
  }

  _normaliseCryptoBar(bar) {
    return {
      time:     bar.t,
      complete: true,
      volume:   bar.v,
      vwap:     bar.vw, // Volume weighted average price for this bar
      mid: {
        o: String(bar.o),
        h: String(bar.h),
        l: String(bar.l),
        c: String(bar.c),
      },
    };
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  _timeframeToMs(granularity) {
    const map = {
      M1:  60_000,
      M5:  300_000,
      M15: 900_000,
      M30: 1_800_000,
      H1:  3_600_000,
      H4:  14_400_000,
      D1:  86_400_000,
    };
    return map[granularity] ?? 300_000;
  }
}
