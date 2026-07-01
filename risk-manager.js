/**
 * RiskManager — Sits between SignalGenerator and TradeExecutor
 *
 * Manages the configured KES-denominated risk plan:
 *   - Daily stop-loss and profit-target gates
 *   - Max open-trade cap
 *   - Dynamic lot sizing from account capital, risk %, SL pips, and pip value
 *   - Max leverage / max position-size caps
 *
 * The TradeExecutor must ALWAYS call riskManager.canTrade() before sending
 * ProtoOANewOrderReq. If it returns false, do NOT trade.
 */

import fs from "fs";
import { config } from "./config.js";
import { calculateRiskVolume } from "./position-sizing.js";

const RISK_STATE_FILE = "risk-state.json";

export class RiskManager {
  constructor(runtimeConfig = config, options = {}) {
    this.config = runtimeConfig ?? config;
    this.stateFile = options.stateFile ?? RISK_STATE_FILE;
    this.nowProvider = options.nowProvider ?? (() => new Date());

    // KES-denominated risk parameters (from config, with defaults)
    this.accountCapitalKES    = this.config.risk.accountCapitalKES;
    this.balanceUSD           = options.initialBalanceUSD ?? (this.accountCapitalKES / (this.config.risk.usdKesRate ?? 129));
    this.riskPerTradePercent  = this.config.risk.riskPerTradePercent ?? 1;
    this.enforceDailyStopLoss = this.config.risk.enforceDailyStopLoss ?? true;
    this.dailyStopLossKES     = this.config.risk.dailyStopLossKES;
    this.dailyProfitTargetKES = this.config.risk.dailyProfitTargetKES;
    this.maxLeverage          = this.config.risk.maxLeverage;
    this.maxOpenTrades        = this.config.maxTotalTrades || this.config.risk.maxOpenTrades || 1;

    // Daily tracking (reset each UTC day)
    this.tradingEnabled       = true;
    this.dailyRealizedPnLKES  = 0;
    this.dailyRealizedProfit  = 0;   // Positive PnL accumulator
    this.dailyRealizedLoss    = 0;   // Negative PnL accumulator (stored as positive)
    this.currentDayUTC        = this._todayKeyUTC();
    this.openTradeCount       = 0;
    this.tradeLog             = [];   // Intra-day trade results

    this._loadState();
  }

  // ─── Core Gate: Can We Trade? ────────────────────────────────────────────────

  /**
   * The single permission gate. Returns { allowed: boolean, reason: string }.
   * TradeExecutor must call this before every ProtoOANewOrderReq.
   */
  canTrade() {
    this._checkDayReset();

    if (!this.tradingEnabled) {
      return { allowed: false, reason: "Trading disabled for today (daily limit reached)" };
    }

    // Optional hard cap: daily realized loss >= configured daily limit.
    if (this.enforceDailyStopLoss && this.dailyRealizedLoss >= this.dailyStopLossKES) {
      this.tradingEnabled = false;
      this._saveState();
      return { allowed: false, reason: `Daily stop-loss hit: ${this.dailyRealizedLoss.toFixed(2)} KES lost (limit: ${this.dailyStopLossKES} KES)` };
    }

    // Profit target: daily realized profit >= configured target → protect gains
    if (this.dailyRealizedProfit >= this.dailyProfitTargetKES) {
      this.tradingEnabled = false;
      this._saveState();
      return { allowed: false, reason: `Daily profit target reached: ${this.dailyRealizedProfit.toFixed(2)} KES (target: ${this.dailyProfitTargetKES} KES)` };
    }

    // Max exposure: only 1 trade at a time
    if (this.openTradeCount >= this.maxOpenTrades) {
      return { allowed: false, reason: `Max open trades reached: ${this.openTradeCount}/${this.maxOpenTrades}` };
    }

    return { allowed: true, reason: "OK" };
  }

  // ─── Lot Size Calculator ─────────────────────────────────────────────────────

  /**
   * Calculate position volume dynamically in units.
   *
   * Volume = dailyStopLossKES / (SL_Pips × Pip_Value_in_KES)
   *
   * @param {string} pair        - e.g. "EUR_USD"
   * @param {number} slPips      - stop loss distance in pips
   * @param {number} currentRate - current price of the pair
   * @param {number} usdKesRate  - USD/KES exchange rate (default from config)
   * @returns {number} units (clamped by max leverage)
   */
  calculateVolume(pair, slPips, currentRate, usdKesRate = this.config.risk.usdKesRate, convictionMultiplier = 1.0) {
    const capital = this.balanceUSD * usdKesRate;
    const base = calculateRiskVolume({
      pair,
      slPips,
      currentRate,
      accountCapitalKES: capital,
      riskPerTradePercent: this.riskPerTradePercent,
      usdKesRate,
      maxLeverage: this.maxLeverage,
      maxPositionSizeUnits: this.config.maxPositionSizeUnits,
      logger: console,
    });
    return Math.floor(base * convictionMultiplier);
  }


  // ─── Trade Lifecycle Tracking ────────────────────────────────────────────────

  /**
   * Call when a trade is opened
   */
  onTradeOpened(tradeId, pair, direction, entryPrice, slPrice, tpPrice, units) {
    this.openTradeCount++;
    this.tradeLog.push({
      id: tradeId, pair, direction, entryPrice, slPrice, tpPrice, units,
      openedAt: new Date().toISOString(), status: "open"
    });
    this._saveState();
    console.log(`  📊 RiskManager: Trade opened. Open: ${this.openTradeCount}/${this.maxOpenTrades} | Daily PnL: ${this.dailyRealizedPnLKES.toFixed(2)} KES`);
  }

  /**
   * Call when a trade is partially closed (e.g. partial take profit).
   * Updates PnL tracking but keeps openTradeCount unchanged.
   */
  onTradePartiallyClosed(tradeId, pnlKES, closedUnits) {
    this.dailyRealizedPnLKES += pnlKES;
    this.balanceUSD += pnlKES / (this.config.risk.usdKesRate ?? 129);

    if (pnlKES >= 0) {
      this.dailyRealizedProfit += pnlKES;
    } else {
      this.dailyRealizedLoss += Math.abs(pnlKES);
    }

    const trade = this.tradeLog.find(t => t.id === tradeId);
    if (trade) {
      trade.partialPnLKES = (trade.partialPnLKES || 0) + pnlKES;
      trade.units = Math.max(0, trade.units - (closedUnits || 0));
    }

    if (this.enforceDailyStopLoss && this.dailyRealizedLoss >= this.dailyStopLossKES) {
      this.tradingEnabled = false;
      console.log(`  🛑 RiskManager: DAILY STOP-LOSS HIT (partial close). Trading disabled until next UTC day.`);
    }
    if (this.dailyRealizedProfit >= this.dailyProfitTargetKES) {
      this.tradingEnabled = false;
      console.log(`  🎯 RiskManager: DAILY PROFIT TARGET REACHED (partial close). Trading disabled to protect gains.`);
    }

    this._saveState();
  }

  /**
   * Call when a trade is closed. pnlKES is the realized P&L in KES.
   */
  onTradeClosed(tradeId, pnlKES) {
    this.openTradeCount = Math.max(0, this.openTradeCount - 1);
    this.dailyRealizedPnLKES += pnlKES;
    this.balanceUSD += pnlKES / (this.config.risk.usdKesRate ?? 129);

    if (pnlKES >= 0) {
      this.dailyRealizedProfit += pnlKES;
    } else {
      this.dailyRealizedLoss += Math.abs(pnlKES);
    }

    // Update trade log
    const trade = this.tradeLog.find(t => t.id === tradeId);
    if (trade) {
      trade.status = "closed";
      trade.pnlKES = pnlKES;
      trade.closedAt = new Date().toISOString();
    }

    const emoji = pnlKES >= 0 ? "💰" : "💸";
    console.log(`  ${emoji} RiskManager: Trade closed. PnL: ${pnlKES >= 0 ? "+" : ""}${pnlKES.toFixed(2)} KES | Day total: ${this.dailyRealizedPnLKES.toFixed(2)} KES`);
    console.log(`     Profit: +${this.dailyRealizedProfit.toFixed(2)} KES | Loss: -${this.dailyRealizedLoss.toFixed(2)} KES | Open: ${this.openTradeCount}`);

    // Check if we should stop for the day
    if (this.enforceDailyStopLoss && this.dailyRealizedLoss >= this.dailyStopLossKES) {
      this.tradingEnabled = false;
      console.log(`  🛑 RiskManager: DAILY STOP-LOSS HIT. Trading disabled until next UTC day.`);
    }
    if (this.dailyRealizedProfit >= this.dailyProfitTargetKES) {
      this.tradingEnabled = false;
      console.log(`  🎯 RiskManager: DAILY PROFIT TARGET REACHED. Trading disabled to protect gains.`);
    }

    this._saveState();
  }

  /**
   * Sync open trade count from broker reconciliation
   */
  syncOpenTradeCount(count) {
    this.openTradeCount = count;
    this._saveState();
  }

  // ─── Day Reset ───────────────────────────────────────────────────────────────

  _checkDayReset() {
    const today = this._todayKeyUTC();
    if (today !== this.currentDayUTC) {
      console.log(`  🌅 RiskManager: New UTC day — resetting daily counters.`);
      this.currentDayUTC       = today;
      this.tradingEnabled      = true;
      this.dailyRealizedPnLKES = 0;
      this.dailyRealizedProfit = 0;
      this.dailyRealizedLoss   = 0;
      this.tradeLog            = [];
      this._saveState();
    }
  }

  // ─── Persistence ─────────────────────────────────────────────────────────────

  _saveState() {
    try {
      fs.writeFileSync(this.stateFile, JSON.stringify({
        currentDayUTC:       this.currentDayUTC,
        tradingEnabled:      this.tradingEnabled,
        dailyRealizedPnLKES: this.dailyRealizedPnLKES,
        dailyRealizedProfit: this.dailyRealizedProfit,
        dailyRealizedLoss:   this.dailyRealizedLoss,
        openTradeCount:      this.openTradeCount,
        tradeLog:            this.tradeLog,
        lastUpdated:         new Date().toISOString(),
      }, null, 2));
    } catch (err) {
      console.error("  ⚠️  RiskManager: Failed to save risk-state.json:", err.message);
    }
  }

  _loadState() {
    if (!fs.existsSync(this.stateFile)) return;
    try {
      const data = JSON.parse(fs.readFileSync(this.stateFile, "utf8"));
      const storedDayUTC = this._normalizeStoredDayUTC(data.currentDayUTC);
      if (storedDayUTC === this._todayKeyUTC()) {
        this.currentDayUTC       = data.currentDayUTC;
        this.tradingEnabled      = data.tradingEnabled;
        this.dailyRealizedPnLKES = data.dailyRealizedPnLKES || 0;
        this.dailyRealizedProfit = data.dailyRealizedProfit || 0;
        this.dailyRealizedLoss   = data.dailyRealizedLoss || 0;
        this.openTradeCount      = data.openTradeCount || 0;
        this.tradeLog            = data.tradeLog || [];
        console.log(`  📂 RiskManager: Loaded state — PnL: ${this.dailyRealizedPnLKES.toFixed(2)} KES, Trading: ${this.tradingEnabled ? "ON" : "OFF"}`);
      } else {
        console.log(`  🌅 RiskManager: State is from previous day — starting fresh.`);
      }
    } catch (err) {
      console.error("  ⚠️  RiskManager: Failed to load risk-state.json:", err.message);
    }
  }

  _todayKeyUTC() {
    return this._formatDayUTC(this.nowProvider());
  }

  _formatDayUTC(dateLike) {
    const date = dateLike instanceof Date ? dateLike : new Date(dateLike);
    return date.toISOString().slice(0, 10);
  }

  _normalizeStoredDayUTC(value) {
    return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
  }
}

