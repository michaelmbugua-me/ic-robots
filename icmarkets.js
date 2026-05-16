/**
 * IC Markets — cTrader Open API Client
 *
 * Protocol : WebSocket + JSON (port 5036)
 * Docs     : https://help.ctrader.com/open-api/
 *
 * Authentication flow (happens inside authenticate()):
 *   1. ProtoOAApplicationAuthReq  → authenticate the app
 *   2. ProtoOAAccountAuthReq      → authenticate the trading account
 *
 * Key operations:
 *   getCandles()   → ProtoOAGetTrendbarsReq
 *   getAccount()   → ProtoOATraderReq
 *   createOrder()  → ProtoOANewOrderReq  (waits for ExecutionEvent)
 *   closeTrade()   → ProtoOAClosePositionReq
 */

import WebSocket from "ws";
import fs from "fs";
import protobuf from "protobufjs";
import Long from "long";
import { config } from "./config.js";

function logConnectionAlert(message) {
  const entry = JSON.stringify({ timestamp: new Date().toISOString(), type: "connection_alert", message }) + "\n";
  try { fs.appendFileSync("activity.log", entry); } catch {}
}

// ─── Payload type constants (Protobuf version) ──────────────────────────────
const PT = {
  ERROR_RES:           2142,
  HEARTBEAT:             51,
  APP_AUTH_REQ:        2100,
  APP_AUTH_RES:        2101,
  ACCOUNT_AUTH_REQ:    2102,
  ACCOUNT_AUTH_RES:    2103,
  VERSION_REQ:         2104,
  VERSION_RES:         2105,
  NEW_ORDER_REQ:       2106,
  TRADER_REQ:          2121,
  TRADER_RES:          2122,
  EXECUTION_EVENT:     2126,
  SUBSCRIBE_SPOTS_REQ: 2127,
  SUBSCRIBE_SPOTS_RES: 2128,
  SPOT_EVENT:          2131,
  ORDER_ERROR_EVENT:   2132,
  RECONCILE_REQ:       2124,
  RECONCILE_RES:       2125,
  GET_TRENDBARS_REQ:   2137,
  GET_TRENDBARS_RES:   2138,
  CLOSE_POSITION_REQ:  2111,
  AMEND_POSITION_SLTP_REQ: 2110,
  SYMBOLS_LIST_REQ:    2114,
  SYMBOLS_LIST_RES:    2115,
  SYMBOL_BY_ID_REQ:    2116,
  SYMBOL_BY_ID_RES:    2117,
  GET_ACCOUNTS_BY_ACCESS_TOKEN_REQ: 2149,
  GET_ACCOUNTS_BY_ACCESS_TOKEN_RES: 2150,
};

// Map of payloadType → Proto message name (for decoding)
const PT_NAMES = {
  51:   "ProtoHeartbeatEvent",
  2100: "ProtoOAApplicationAuthReq",
  2101: "ProtoOAApplicationAuthRes",
  2102: "ProtoOAAccountAuthReq",
  2103: "ProtoOAAccountAuthRes",
  2104: "ProtoOAVersionReq",
  2105: "ProtoOAVersionRes",
  2106: "ProtoOANewOrderReq",
  2114: "ProtoOASymbolsListReq",
  2115: "ProtoOASymbolsListRes",
  2116: "ProtoOASymbolByIdReq",
  2117: "ProtoOASymbolByIdRes",
  2121: "ProtoOATraderReq",
  2122: "ProtoOATraderRes",
  2124: "ProtoOAReconcileReq",
  2125: "ProtoOAReconcileRes",
  2126: "ProtoOAExecutionEvent",
  2127: "ProtoOASubscribeSpotsReq",
  2128: "ProtoOASubscribeSpotsRes",
  2131: "ProtoOASpotEvent",
  2132: "ProtoOAOrderErrorEvent",
  2137: "ProtoOAGetTrendbarsReq",
  2138: "ProtoOAGetTrendbarsRes",
  2110: "ProtoOAAmendPositionSLTPReq",
  2111: "ProtoOAClosePositionReq",
  2142: "ProtoOAErrorRes",
  2149: "ProtoOAGetAccountListByAccessTokenReq",
  2150: "ProtoOAGetAccountListByAccessTokenRes",
};

// Granularity string → cTrader period integer
const PERIOD = {
  M1: 1, M2: 2, M3: 3, M4: 4, M5: 5,
  M10: 6, M15: 7, M30: 8,
  H1: 9, H4: 10, H12: 11,
  D1: 12, W1: 13, MN1: 14,
};

// Granularity → milliseconds (used for timestamp range calculation)
const PERIOD_MS = {
  M1: 60_000, M5: 300_000, M15: 900_000, M30: 1_800_000,
  H1: 3_600_000, H4: 14_400_000, D1: 86_400_000,
};

export class ICMarketsClient {
  constructor() {
    this.ws              = null;
    this.connected       = false;
    this.pendingRequests = new Map();   // msgId → { resolve, reject }
    this.eventListeners  = new Map();   // payloadType → [callbacks]
    this.msgCounter      = 1;
    this.heartbeatTimer  = null;
    this.reconnecting    = false;
    this.root            = null;
    this.proto           = null;        // Cache for loaded proto definitions
    this.symbols         = new Map();   // Cache for symbol details
    // Connection health monitoring (Phase 4)
    this.lastMessageTime = Date.now();
    this.healthCheckTimer = null;
    this.onConnectionLost = null;       // Callback for emergency alert
    this.keepaliveTimer  = null;        // GCP idle connection keepalive
  }

  // ─── Connection ────────────────────────────────────────────────────────────

  async _loadProto() {
    if (this.root) return;
    this.root = await protobuf.load([
      "OpenApiCommonMessages.proto",
      "OpenApiCommonModelMessages.proto",
      "OpenApiMessages.proto",
      "OpenApiModelMessages.proto"
    ]);
  }

  async connect() {
    await this._loadProto();
    const host = config.ctraderEnv === "live"
      ? "live.ctraderapi.com"
      : "demo.ctraderapi.com";

    return new Promise((resolve, reject) => {
      let settled = false;
      const connectTimeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { this.ws?.terminate(); } catch {}
        reject(new Error(`Timeout connecting to cTrader WebSocket (${host}:5035)`));
      }, 15_000);

      // Protobuf port is 5035
      this.ws = new WebSocket(`wss://${host}:5035`);

      this.ws.on("open", () => {
        if (settled) return;
        settled = true;
        clearTimeout(connectTimeout);
        this.connected = true;
        this.lastMessageTime = Date.now();
        this._startHeartbeat();
        this._startHealthMonitor();
        this._startKeepalive();
        resolve();
      });

      this.ws.on("message", (raw) => {
        this.lastMessageTime = Date.now();
        this._onMessage(raw);
      });

      this.ws.on("error", (err) => {
        if (!this.connected && !settled) {
          settled = true;
          clearTimeout(connectTimeout);
          reject(err);
        }
        console.error("❌ WebSocket error:", err.message);
      });

      this.ws.on("close", () => {
        clearTimeout(connectTimeout);
        const wasConnected = this.connected;
        this.connected = false;
        clearInterval(this.heartbeatTimer);
        clearInterval(this.healthCheckTimer);
        clearInterval(this.keepaliveTimer);
        // Reject all pending requests — socket is dead
        for (const [id, pending] of this.pendingRequests) {
          pending.reject(new Error("WebSocket closed while waiting for response"));
        }
        this.pendingRequests.clear();
        if (wasConnected && !this.reconnecting) this._scheduleReconnect();
      });
    });
  }

  async _scheduleReconnect() {
    this.reconnecting = true;
    console.log("\n⚠️  Connection lost — reconnecting in 5s...");
    await sleep(5000);
    try {
      await this.connect();
      await this.authenticate();
      console.log("✅ Reconnected.\n");
    } catch (err) {
      console.error("Reconnect failed:", err.message);
    } finally {
      this.reconnecting = false;
    }
  }

  // ─── Authentication ────────────────────────────────────────────────────────

  async authenticate() {
    // Step 1: authenticate the application
    await this._send(PT.APP_AUTH_REQ, {
      clientId:     config.ctraderClientId,
      clientSecret: config.ctraderClientSecret,
    });

    // Step 2: authenticate the trading account
    await this._send(PT.ACCOUNT_AUTH_REQ, {
      ctidTraderAccountId: Long.fromValue(config.ctraderAccountId),
      accessToken:         config.ctraderAccessToken,
    });
  }

  // ─── Market Data ───────────────────────────────────────────────────────────

  /**
   * Fetch historical candles and return them in the standard format
   * used by indicators.js (same shape as OANDA/Alpaca candles)
   */
  async getCandles(instrument, granularity = "M5", count = 100, from = null, to = null, quoteType = 1) {
    const symbolId = this._resolveSymbolId(instrument);
    const period   = PERIOD[granularity];
    if (!period) throw new Error(`Unknown granularity: ${granularity}`);

    const periodMs    = PERIOD_MS[granularity] ?? 300_000;
    const toTimestamp = to || Date.now();
    const fromTimestamp = from || (toTimestamp - periodMs * (count + 10));

    const res = await this._send(PT.GET_TRENDBARS_REQ, {
      ctidTraderAccountId: config.ctraderAccountId,
      symbolId,
      period,
      fromTimestamp,
      toTimestamp,
      count,
      quoteType, // 1 = BID, 2 = ASK
    });

    const bars = res.trendbar ?? [];
    if (bars.length === 0) throw new Error(`No trendbar data for ${instrument}`);

    // cTrader prices are integers representing price × 100000
    const D = 100000;

    return bars.map((bar) => {
      const low   = bar.low   / D;
      const open  = (bar.low + (bar.deltaOpen  ?? 0)) / D;
      const close = (bar.low + (bar.deltaClose ?? 0)) / D;
      const high  = (bar.low + (bar.deltaHigh  ?? 0)) / D;

      return {
        time:     new Date(Number(bar.utcTimestampInMinutes) * 60_000).toISOString(),
        complete: true,
        volume:   bar.volume ?? 0,
        mid: {
          o: open.toFixed(5),
          h: high.toFixed(5),
          l: low.toFixed(5),
          c: close.toFixed(5),
        },
      };
    });
  }

  // ─── Account ───────────────────────────────────────────────────────────────

  async getAccount() {
    const res = await this._send(PT.TRADER_REQ, {
      payloadType: PT.TRADER_REQ,
      ctidTraderAccountId: Long.fromValue(config.ctraderAccountId),
    });

    const t = res.trader;
    // moneyDigits is the exponent (usually 2 for USD, but could be more)
    const d = Math.pow(10, t.moneyDigits || 2);
    
    return {
      balance:  (t.balance  / d).toFixed(2),
      equity:   ((t.balance + (t.unrealizedGrossProfit ?? 0)) / d).toFixed(2),
      currency: "USD",
    };
  }

  async getSymbol(symbolName) {
    if (this.symbols.has(symbolName)) return this.symbols.get(symbolName);

    // 1. Get the light symbol to find the symbolId
    const listRes = await this._send(PT.SYMBOLS_LIST_REQ, {
      payloadType: PT.SYMBOLS_LIST_REQ,
      ctidTraderAccountId: Long.fromValue(config.ctraderAccountId),
      includeArchivedSymbols: false,
    });

    // Try multiple name variations: EUR_USD -> EUR/USD, EURUSD, EUR_USD
    const variations = [
      symbolName.replace("_", "/"),
      symbolName.replace("_", ""),
      symbolName
    ];
    
    let light;
    for (const v of variations) {
      light = listRes.symbol.find(s => s.symbolName === v);
      if (light) break;
    }
    
    if (!light) throw new Error(`Symbol ${symbolName} not found in broker list.`);

    // 2. Get full symbol details
    const res = await this._send(PT.SYMBOL_BY_ID_REQ, {
      payloadType: PT.SYMBOL_BY_ID_REQ,
      ctidTraderAccountId: Long.fromValue(config.ctraderAccountId),
      symbolId: [light.symbolId],
    });

    const s = res.symbol[0];
    const details = {
      id:          Long.fromValue(s.symbolId).toNumber(),
      name:        s.symbolName,
      digits:      s.digits,
      pipPosition: s.pipPosition,
      minVolume:   Long.fromValue(s.minVolume || 0).toNumber() / 100,
      stepVolume:  Long.fromValue(s.stepVolume || 0).toNumber() / 100,
      maxVolume:   Long.fromValue(s.maxVolume || 0).toNumber() / 100,
    };

    this.symbols.set(symbolName, details);
    return details;
  }

  // ─── Orders ────────────────────────────────────────────────────────────────

  /**
   * High-level wrapper for index.js
   */
  async openPosition(pair, action, units, stopLoss, takeProfit, entryPriceHint) {
    // Ensure we have symbol details (for stepVolume/minVolume) before opening
    await this.getSymbol(pair);

    const isBuy = action === "BUY";
    const signedUnits = isBuy ? units : -units;
    
    let entryPrice = entryPriceHint;
    
    // If no hint provided, we need the latest price for relative SL/TP calculation
    if (!entryPrice) {
      const candles = await this.getCandles(pair, "M1", 1);
      entryPrice = candles[0].mid.c;
    }

    const res = await this.createOrder({
      instrument: pair,
      units: signedUnits,
      stopLoss,
      takeProfit,
      entryPrice
    });

    return {
      positionId: res.id,
      price: res.price
    };
  }

  /**
   * Place a market order with bracket stop loss + take profit
   *
   * @param {object} p
   * @param {string} p.instrument  e.g. "EUR_USD"
   * @param {number} p.units       positive = BUY, negative = SELL
   * @param {string} p.stopLoss    absolute price e.g. "1.08390"
   * @param {string} p.takeProfit  absolute price e.g. "1.08516"
   * @param {number} p.entryPrice  reference price for relative SL/TP calculation
   */
  async createOrder({ instrument, units, stopLoss, takeProfit, entryPrice }) {
    const symbolId = this._resolveSymbolId(instrument);
    const isBuy    = units > 0;
    const absUnits = Math.abs(units);

    // cTrader volume: 1 unit = 100 in their internal format (0.01 units)
    let volume     = absUnits * 100;
    
    // Ensure volume is a multiple of stepVolume (Phase 4 fix)
    const symbol = this.symbols.get(instrument);
    if (symbol && symbol.stepVolume) {
      const internalStep = symbol.stepVolume * 100;
      const internalMin  = (symbol.minVolume || 0) * 100;
      
      // Round down to nearest step
      volume = Math.floor(volume / internalStep) * internalStep;
      
      // Ensure it's at least the minimum volume
      if (volume < internalMin) {
        volume = internalMin;
      }
    }
    
    const payload = {
      payloadType: PT.NEW_ORDER_REQ,
      ctidTraderAccountId: Long.fromValue(config.ctraderAccountId),
      symbolId: Long.fromValue(symbolId),
      orderType:    1, // MARKET
      tradeSide:    isBuy ? 1 : 2, // BUY : SELL
      volume: Long.fromValue(volume),
    };

    // Slippage protection (Phase 3): max 2 pips deviation from expected price
    const maxSlippagePips = config.maxSlippagePips || 2;
    const isJPY = instrument.includes("JPY");
    const pipSize = isJPY ? 0.01 : 0.0001;
    const slippagePoints = Math.round(maxSlippagePips * pipSize * 100000);
    if (slippagePoints > 0) {
      payload.slippage = Long.fromValue(slippagePoints);
    }

    // For MARKET orders, cTrader requires relative SL/TP
    // Specified in 1/100000 of unit of a price
    if (stopLoss && entryPrice) {
      const dist = Math.abs(parseFloat(stopLoss) - entryPrice);
      payload.relativeStopLoss = Long.fromValue(Math.round(dist * 100000));
    }
    if (takeProfit && entryPrice) {
      const dist = Math.abs(parseFloat(takeProfit) - entryPrice);
      payload.relativeTakeProfit = Long.fromValue(Math.round(dist * 100000));
    }

    console.log("DEBUG: Order payload:", JSON.stringify(payload, (k, v) => typeof v === 'bigint' ? v.toString() : v));

    // Subscribe to execution events BEFORE sending the order
    // We want the ORDER_FILLED event specifically (executionType = 3)
    const execPromise = this._waitForPayloadType(PT.EXECUTION_EVENT, 20_000, (p) => {
        return p.executionType === 3 || p.executionType === "ORDER_FILLED";
    });
    const errPromise  = this._waitForPayloadType(PT.ORDER_ERROR_EVENT, 20_000);

    await this._send(PT.NEW_ORDER_REQ, payload, { expectEvent: true });

    // Wait for execution OR error — whichever comes first
    const result = await Promise.race([execPromise, errPromise]);

    if (!result || result._eventType === PT.ORDER_ERROR_EVENT) {
      const errorMsg = result ? `Order rejected: ${result.errorCode} — ${result.description ?? ""}` : "Order timeout/unknown error";
      throw new Error(errorMsg);
    }

    const deal     = result.deal     ?? {};
    const position = result.position ?? {};

    // Note: deal.executionPrice is already a double in some versions, 
    // but in others it might be int64 scaled by 10^5.
    // Based on ProtoOADeal definition it is 'optional double executionPrice = 10'.
    // However, if we get a very large number, we might need to divide it.
    let execPrice = deal.executionPrice ?? 0;
    if (execPrice > 1000) {
      // If it's something like 117240, it's scaled int64 (should have been double)
      execPrice = execPrice / 100000;
    }

    return {
      id:         position.positionId ?? deal.dealId ?? "unknown",
      price:      execPrice,
      units:      absUnits,
      instrument,
      time:       new Date().toISOString(),
    };
  }

  /**
   * Close an open position by positionId
   */
  async closeTrade(positionId) {
    // We need to get the current volume of the position first
    // Use a large volume — cTrader will cap it to the actual open volume
    await this._send(PT.CLOSE_POSITION_REQ, {
      ctidTraderAccountId: config.ctraderAccountId,
      positionId:          positionId,
      volume:              999_999_999,   // max out → closes entire position
    });
  }

  /**
   * Update SL/TP of an existing position
   */
  async amendPositionSLTP(positionId, stopLoss, takeProfit) {
    await this._send(PT.AMEND_POSITION_SLTP_REQ, {
      ctidTraderAccountId: config.ctraderAccountId,
      positionId:          positionId,
      stopLoss:            stopLoss ? Number(parseFloat(stopLoss).toFixed(5)) : undefined,
      takeProfit:          takeProfit ? Number(parseFloat(takeProfit).toFixed(5)) : undefined,
    });
  }

  /**
   * Fetch all open positions for the account
   */
  async reconcile() {
    const res = await this._send(PT.RECONCILE_REQ, {
      ctidTraderAccountId: config.ctraderAccountId,
      returnProtectionOrders: true,
    });
    return res.position || [];
  }

  // ─── Symbol ID Resolution ──────────────────────────────────────────────────

  _resolveSymbolId(instrument) {
    // Check cache first
    if (this.symbols.has(instrument)) {
      return this.symbols.get(instrument).id;
    }

    const id = (config.ctraderSymbolIds ?? {})[instrument];
    if (!id) {
      throw new Error(
        `No symbol ID found for "${instrument}". ` +
        `Run "node get-symbols.js" and update config.ctraderSymbolIds.`
      );
    }
    return id;
  }

  /**
   * Register a callback for a specific unsolicited event (e.g. SPOT_EVENT)
   */
  on(payloadType, callback) {
    if (!this.eventListeners.has(payloadType)) {
      this.eventListeners.set(payloadType, []);
    }
    this.eventListeners.get(payloadType).push(callback);
  }

  /**
   * Remove a callback
   */
  off(payloadType, callback) {
    if (this.eventListeners.has(payloadType)) {
      const listeners = this.eventListeners.get(payloadType);
      const index = listeners.indexOf(callback);
      if (index !== -1) listeners.splice(index, 1);
    }
  }

  /**
   * Subscribe to live tick updates (spot events) for a symbol
   */
  async subscribeTicks(instrument) {
    const symbolId = this._resolveSymbolId(instrument);
    await this._send(PT.SUBSCRIBE_SPOTS_REQ, {
      ctidTraderAccountId: config.ctraderAccountId,
      symbolId: [symbolId],
    });
  }

  /**
   * Fetch current spread in pips for a symbol
   */
  async getSpread(instrument) {
    const symbolId = this._resolveSymbolId(instrument);
    
    return new Promise(async (resolve, reject) => {
      const onSpot = (payload) => {
        if (String(payload.symbolId) === String(symbolId) && (payload.bid || payload.ask)) {
          // Note: cTrader spot events might only contain bid OR ask if only one changed.
          // For a simple spread check, we need both. If only one is present, we wait for the next.
          // BUT, we can also use the last known if we had a cache. 
          // For simplicity here, we just wait for one that has both or wait for a few.
          if (payload.bid && payload.ask) {
            this.off(PT.SPOT_EVENT, onSpot);
            const bid = payload.bid / 100000;
            const ask = payload.ask / 100000;
            const isJPY = instrument.includes("JPY");
            const pipSize = isJPY ? 0.01 : 0.0001;
            const spreadPips = (ask - bid) / pipSize;
            resolve(spreadPips);
          }
        }
      };

      this.on(PT.SPOT_EVENT, onSpot);
      
      try {
        await this.subscribeTicks(instrument);
        // Timeout if no quote in 5s
        setTimeout(() => {
          this.off(PT.SPOT_EVENT, onSpot);
          reject(new Error("Timeout waiting for spread quote"));
        }, 5000);
      } catch (err) {
        this.off(PT.SPOT_EVENT, onSpot);
        reject(err);
      }
    });
  }

  // ─── Messaging ─────────────────────────────────────────────────────────────

  /**
   * Send a message and (optionally) wait for the corresponding response.
   */
  _send(payloadType, payload, { expectEvent = false } = {}) {
    // Guard: don't send on a closed/closing socket
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("WebSocket not open — skipping send"));
    }

    const clientMsgId = `m${this.msgCounter++}`;
    
    // 1. Encode the inner payload
    const typeName = PT_NAMES[payloadType];
    if (!typeName) throw new Error(`Unknown payloadType: ${payloadType}`);
    
    const InnerType = this.root.lookupType(typeName);
    const innerMsg = InnerType.create(payload);
    const innerBuffer = InnerType.encode(innerMsg).finish();

    // 2. Wrap in ProtoMessage
    const protoMsg = { payloadType, payload: innerBuffer, clientMsgId };
    const OuterType = this.root.lookupType("ProtoMessage");
    const outerMsg = OuterType.create(protoMsg);
    const outerBuffer = OuterType.encode(outerMsg).finish();

    // 3. Send the outer buffer as a binary frame (NO 4-byte header for WebSocket)
    const frame = outerBuffer;

    return new Promise((resolve, reject) => {
      if (!expectEvent) {
        this.pendingRequests.set(clientMsgId, { resolve, reject });
        setTimeout(() => {
          if (this.pendingRequests.has(clientMsgId)) {
            this.pendingRequests.delete(clientMsgId);
            reject(new Error(`Timeout waiting for response to ${typeName} (${payloadType})`));
          }
        }, 15_000);
      }

      this.ws.send(frame, { binary: true }, (err) => {
        if (err) {
          this.pendingRequests.delete(clientMsgId);
          reject(err);
        } else if (expectEvent) {
          resolve(null);
        }
      });
    });
  }

  /**
   * Wait for a specific unsolicited event payload type (e.g. EXECUTION_EVENT)
   * with an optional filter function.
   */
  _waitForPayloadType(payloadType, timeoutMs = 15_000, filterFn = null) {
    return new Promise((resolve, reject) => {
      const handler = (payload) => {
        if (filterFn && !filterFn(payload)) return;

        clearTimeout(timer);
        this.off(payloadType, handler);
        resolve({ ...payload, _eventType: payloadType });
      };

      const timer = setTimeout(() => {
        this.off(payloadType, handler);
        reject(new Error(`Timeout waiting for event ${payloadType}`));
      }, timeoutMs);

      this.on(payloadType, handler);
    });
  }

  _onMessage(raw) {
    let msg, payload;
    try {
      ({ msg, payload } = this._parseFrame(raw));
    } catch (err) {
      console.error("❌ Protobuf decode error:", err.message);
      return; 
    }

    const { clientMsgId, payloadType } = msg;

    // Error response — reject the pending request
    if (payloadType === PT.ERROR_RES) {
      const pending = this.pendingRequests.get(clientMsgId);
      if (pending) {
        this.pendingRequests.delete(clientMsgId);
        const errorCode = payload?.errorCode || "UNKNOWN";
        const description = payload?.description || "";
        console.error(`❌ cTrader Error [${clientMsgId}]: ${errorCode} - ${description}`);
        pending.reject(
          new Error(`cTrader error ${errorCode}: ${description}`)
        );
      }
      return;
    }

    // Normal response — resolve the pending request
    if (clientMsgId && this.pendingRequests.has(clientMsgId)) {
      const pending = this.pendingRequests.get(clientMsgId);
      this.pendingRequests.delete(clientMsgId);
      pending.resolve(payload);
    }

    // Unsolicited events — trigger registered listeners
    if (this.eventListeners.has(payloadType)) {
      this.eventListeners.get(payloadType).forEach(cb => cb(payload));
    }
  }

  /**
   * Parse a cTrader binary frame (ProtoMessage)
   */
  _parseFrame(raw) {
    // raw is a Buffer (or ArrayBuffer) from ws
    const buffer = Buffer.from(raw);
    
    // NO 4-byte header for WebSocket
    const payloadBuffer = buffer;

    // Decode ProtoMessage
    const ProtoMessage = this.root.lookupType("ProtoMessage");
    const msg = ProtoMessage.decode(payloadBuffer);

    // Decode nested payload
    const typeName = PT_NAMES[msg.payloadType];
    let payload = {};
    if (typeName && msg.payload) {
      const InnerType = this.root.lookupType(typeName);
      payload = InnerType.toObject(InnerType.decode(msg.payload), {
        enums: String, // Convert enums to strings for convenience
        longs: Number, // Convert longs to numbers
        defaults: true,
      });
    }

    return { msg, payload };
  }

  // ─── Heartbeat ─────────────────────────────────────────────────────────────

  _startHeartbeat() {
    this.heartbeatTimer = setInterval(() => {
      if (this.connected) {
        this._send(PT.HEARTBEAT, {}).catch(() => {});
      }
    }, 20_000);
  }

  /**
   * WebSocket-level ping to prevent GCP/cloud firewall idle timeout.
   * GCP drops idle TCP connections after ~10 minutes; this keeps them alive.
   */
  _startKeepalive() {
    const KEEPALIVE_MS = 4 * 60 * 1000; // every 4 minutes
    this.keepaliveTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.ping?.();
      }
    }, KEEPALIVE_MS);
  }

  // ─── Connection Health Monitor (Phase 4) ─────────────────────────────────

  _startHealthMonitor() {
    const timeoutMs = (config.connectionTimeoutSeconds || 10) * 1000;
    this.healthCheckTimer = setInterval(() => {
      const silenceMs = Date.now() - this.lastMessageTime;
      if (silenceMs > timeoutMs && this.connected) {
        const msg = `🚨 EMERGENCY: No data from cTrader for ${(silenceMs / 1000).toFixed(0)}s (limit: ${config.connectionTimeoutSeconds}s)`;
        console.error(msg);
        logConnectionAlert(msg);
        if (this.onConnectionLost) {
          this.onConnectionLost(msg);
        }
      }
    }, 5_000); // Check every 5s
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
