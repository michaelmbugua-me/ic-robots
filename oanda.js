/**
 * OANDA REST API v20 Client
 * Handles candle data, account info, and order execution
 */

export class OandaClient {
  constructor(apiKey, accountId, env = "practice") {
    this.apiKey = apiKey;
    this.accountId = accountId;
    this.baseUrl =
      env === "live"
        ? "https://api-fxtrade.oanda.com/v3"
        : "https://api-fxpractice.oanda.com/v3";
  }

  // ─── Core Fetch ────────────────────────────────────────────────────────────

  async request(path, method = "GET", body = null) {
    const options = {
      method,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
    };
    if (body) options.body = JSON.stringify(body);

    const res = await fetch(`${this.baseUrl}${path}`, options);

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`OANDA ${method} ${path} → ${res.status}: ${err}`);
    }

    return res.json();
  }

  // ─── Market Data ───────────────────────────────────────────────────────────

  /**
   * Get historical candles
   * @param {string} instrument  e.g. "EUR_USD"
   * @param {string} granularity e.g. "M1", "M5", "M15"
   * @param {number} count       number of candles (max 500)
   */
  async getCandles(instrument, granularity = "M5", count = 100) {
    const data = await this.request(
      `/instruments/${instrument}/candles?count=${count}&granularity=${granularity}&price=M`
    );
    return data.candles.filter((c) => c.complete);
  }

  /**
   * Get current bid/ask price
   */
  async getPrice(instrument) {
    const data = await this.request(
      `/accounts/${this.accountId}/pricing?instruments=${instrument}`
    );
    const price = data.prices[0];
    return {
      bid: parseFloat(price.bids[0].price),
      ask: parseFloat(price.asks[0].price),
      mid: (parseFloat(price.bids[0].price) + parseFloat(price.asks[0].price)) / 2,
    };
  }

  // ─── Account ───────────────────────────────────────────────────────────────

  async getAccount() {
    const data = await this.request(`/accounts/${this.accountId}/summary`);
    return data.account;
  }

  async getOpenTrades() {
    const data = await this.request(`/accounts/${this.accountId}/openTrades`);
    return data.trades;
  }

  // ─── Orders & Trades ───────────────────────────────────────────────────────

  /**
   * Create a market order
   * @param {object} params
   * @param {string} params.instrument  e.g. "EUR_USD"
   * @param {number} params.units       positive = BUY, negative = SELL
   * @param {string} params.stopLoss    price string
   * @param {string} params.takeProfit  price string
   */
  async createOrder({ instrument, units, stopLoss, takeProfit }) {
    const body = {
      order: {
        type: "MARKET",
        instrument,
        units: String(units),
        stopLossOnFill: {
          price: stopLoss,
          timeInForce: "GTC",
        },
        takeProfitOnFill: {
          price: takeProfit,
          timeInForce: "GTC",
        },
        timeInForce: "FOK",
        positionFill: "DEFAULT",
      },
    };

    const data = await this.request(
      `/accounts/${this.accountId}/orders`,
      "POST",
      body
    );

    const fill = data.orderFillTransaction;
    if (!fill) throw new Error("Order not filled: " + JSON.stringify(data));

    return {
      id: fill.tradeOpened?.tradeID,
      price: parseFloat(fill.price),
      units: parseInt(fill.units),
      instrument: fill.instrument,
      time: fill.time,
    };
  }

  /**
   * Close an open trade by ID
   */
  async closeTrade(tradeId) {
    return this.request(
      `/accounts/${this.accountId}/trades/${tradeId}/close`,
      "PUT"
    );
  }

  /**
   * Close all open trades for an instrument
   */
  async closeAllPositions(instrument) {
    const body = {
      longUnits: "ALL",
      shortUnits: "ALL",
    };
    return this.request(
      `/accounts/${this.accountId}/positions/${instrument}/close`,
      "PUT",
      body
    );
  }
}
