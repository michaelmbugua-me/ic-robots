/**
 * RiskManager — Sits between SignalGenerator and TradeExecutor
 *
 * Manages a 50,000 KES capital account:
 *   - Daily stop-loss hard cap: 1,000 KES (2%)
 *   - Daily profit target: 1,000 KES (auto-close & stop)
 *   - Max 1 active trade at any time
 *   - Dynamic lot sizing: Volume = 1000 KES / (SL_Pips × Pip_Value_KES)
 *   - Max leverage: 1:100
 *
 * The TradeExecutor must ALWAYS call riskManager.canTrade() before sending
 * ProtoOANewOrderReq. If it returns false, do NOT trade.
 */

import fs from "fs";
import { config } from "./config.js";

const RISK_STATE_FILE = "risk-state.json";

export class RiskManager {
  constructor() {
    // KES-denominated risk parameters (from config, with defaults)
    this.accountCapitalKES    = config.risk.accountCapitalKES;
    this.dailyStopLossKES     = config.risk.dailyStopLossKES;
    this.dailyProfitTargetKES = config.risk.dailyProfitTargetKES;
    this.maxLeverage          = config.risk.maxLeverage;
    this.maxOpenTrades        = config.risk.maxOpenTrades;
    this.minRiskReward        = config.risk.minRiskReward;

    // Daily tracking (reset each UTC day)
    this.tradingEnabled       = true;
    this.dailyRealizedPnLKES  = 0;
    this.dailyRealizedProfit  = 0;   // Positive PnL accumulator
    this.dailyRealizedLoss    = 0;   // Negative PnL accumulator (stored as positive)
    this.currentDayUTC        = new Date().getUTCDate();
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

    // Hard cap: daily realized loss >= 1,000 KES
    if (this.dailyRealizedLoss >= this.dailyStopLossKES) {
      this.tradingEnabled = false;
      this._saveState();
      return { allowed: false, reason: `Daily stop-loss hit: ${this.dailyRealizedLoss.toFixed(2)} KES lost (limit: ${this.dailyStopLossKES} KES)` };
    }

    // Profit target: daily realized profit >= 1,000 KES → protect gains
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
  calculateVolume(pair, slPips, currentRate, usdKesRate = config.risk.usdKesRate) {
    const isJPY = pair.includes("JPY");
    const pipSize = isJPY ? 0.01 : 0.0001;

    // Pip value in USD per standard lot (100,000 units)
    let pipValueUSD;
    if (pair.endsWith("_USD") || pair.endsWith("/USD")) {
      // Quote currency is USD: pip value = pipSize × 100,000 = $10 for standard lot
      pipValueUSD = pipSize * 100_000;
    } else if (pair.startsWith("USD_") || pair.startsWith("USD/")) {
      // Base currency is USD: pip value = (pipSize / rate) × 100,000
      pipValueUSD = (pipSize / currentRate) * 100_000;
    } else {
      // Cross pair: approximate
      pipValueUSD = (pipSize / currentRate) * 100_000;
    }

    // Convert pip value to KES
    const pipValueKES = pipValueUSD * usdKesRate;
    // Per-unit pip value (not per lot)
    const pipValuePerUnitKES = pipValueKES / 100_000;

    if (slPips <= 0 || pipValuePerUnitKES <= 0) {
      console.error(`  ❌ RiskManager: Invalid SL pips (${slPips}) or pip value (${pipValuePerUnitKES})`);
      return 0;
    }

    // Volume = riskAmountKES / (SL_Pips × pipValuePerUnit_KES)
    let units = Math.floor(this.dailyStopLossKES / (slPips * pipValuePerUnitKES));

    // Leverage constraint: position notional must not exceed accountCapital × maxLeverage
    // Notional in KES = units × currentRate × usdKesRate (for USD-denominated pairs)
    const notionalKES = units * currentRate * usdKesRate;
    const maxNotionalKES = this.accountCapitalKES * this.maxLeverage;

    if (notionalKES > maxNotionalKES) {
      units = Math.floor(maxNotionalKES / (currentRate * usdKesRate));
      console.log(`  ⚠️  RiskManager: Leverage cap applied (1:${this.maxLeverage}). Units capped to ${units}`);
    }

    // Never allow more than config.maxPositionSizeUnits
    if (units > config.maxPositionSizeUnits) {
      units = config.maxPositionSizeUnits;
    }

    return units;
  }

  // ─── Risk:Reward Validation ──────────────────────────────────────────────────

  /**
   * Validate that the signal meets minimum R:R ratio of 1:1.5
   */
  validateRiskReward(signal) {
    if (!signal.entry || !signal.stopLoss || !signal.takeProfit) return false;
    const risk   = Math.abs(signal.entry - signal.stopLoss);
    const reward = Math.abs(signal.takeProfit - signal.entry);
    if (risk <= 0) return false;
    const rr = reward / risk;
    return rr >= this.minRiskReward;
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
   * Call when a trade is closed. pnlKES is the realized P&L in KES.
   */
  onTradeClosed(tradeId, pnlKES) {
    this.openTradeCount = Math.max(0, this.openTradeCount - 1);
    this.dailyRealizedPnLKES += pnlKES;

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

    this._saveState();

    const emoji = pnlKES >= 0 ? "💰" : "💸";
    console.log(`  ${emoji} RiskManager: Trade closed. PnL: ${pnlKES >= 0 ? "+" : ""}${pnlKES.toFixed(2)} KES | Day total: ${this.dailyRealizedPnLKES.toFixed(2)} KES`);
    console.log(`     Profit: +${this.dailyRealizedProfit.toFixed(2)} KES | Loss: -${this.dailyRealizedLoss.toFixed(2)} KES | Open: ${this.openTradeCount}`);

    // Check if we should stop for the day
    if (this.dailyRealizedLoss >= this.dailyStopLossKES) {
      this.tradingEnabled = false;
      console.log(`  🛑 RiskManager: DAILY STOP-LOSS HIT. Trading disabled until next UTC day.`);
    }
    if (this.dailyRealizedProfit >= this.dailyProfitTargetKES) {
      this.tradingEnabled = false;
      console.log(`  🎯 RiskManager: DAILY PROFIT TARGET REACHED. Trading disabled to protect gains.`);
    }
  }

  /**
   * Sync open trade count from broker reconciliation
   */
  syncOpenTradeCount(count) {
    this.openTradeCount = count;
    this._saveState();
  }

  // ─── Status ──────────────────────────────────────────────────────────────────

  getStatus() {
    this._checkDayReset();
    return {
      tradingEnabled:       this.tradingEnabled,
      dailyRealizedPnLKES:  this.dailyRealizedPnLKES,
      dailyRealizedProfit:  this.dailyRealizedProfit,
      dailyRealizedLoss:    this.dailyRealizedLoss,
      openTradeCount:       this.openTradeCount,
      remainingLossBudget:  this.dailyStopLossKES - this.dailyRealizedLoss,
      remainingProfitTarget: this.dailyProfitTargetKES - this.dailyRealizedProfit,
    };
  }

  // ─── Day Reset ───────────────────────────────────────────────────────────────

  _checkDayReset() {
    const today = new Date().getUTCDate();
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
      fs.writeFileSync(RISK_STATE_FILE, JSON.stringify({
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
    if (!fs.existsSync(RISK_STATE_FILE)) return;
    try {
      const data = JSON.parse(fs.readFileSync(RISK_STATE_FILE, "utf8"));
      if (data.currentDayUTC === new Date().getUTCDate()) {
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
}

