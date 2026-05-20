import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { config } from "../config.js";
import { RiskManager } from "../risk-manager.js";

function makeTempStateFile(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kutoka-risk-test-"));
  return path.join(dir, name);
}

function testConfig(overrides = {}) {
  return {
    ...config,
    ...overrides,
    risk: {
      ...config.risk,
      ...(overrides.risk ?? {}),
    },
  };
}

const may20 = () => new Date("2026-05-20T12:00:00.000Z");

{
  const stateFile = makeTempStateFile("risk-state.json");
  fs.writeFileSync(stateFile, JSON.stringify({
    currentDayUTC: "2026-05-20",
    tradingEnabled: false,
    dailyRealizedPnLKES: -150,
    dailyRealizedProfit: 0,
    dailyRealizedLoss: 150,
    openTradeCount: 1,
    tradeLog: [{ id: "T1" }],
  }));

  const manager = new RiskManager(testConfig(), { stateFile, nowProvider: may20 });
  assert.equal(manager.currentDayUTC, "2026-05-20");
  assert.equal(manager.tradingEnabled, false);
  assert.equal(manager.dailyRealizedLoss, 150);
  assert.equal(manager.openTradeCount, 1);
}

{
  const stateFile = makeTempStateFile("risk-state.json");
  fs.writeFileSync(stateFile, JSON.stringify({
    currentDayUTC: "2026-04-20",
    tradingEnabled: false,
    dailyRealizedPnLKES: -999,
    dailyRealizedProfit: 0,
    dailyRealizedLoss: 999,
    openTradeCount: 1,
    tradeLog: [{ id: "OLD" }],
  }));

  const manager = new RiskManager(testConfig(), { stateFile, nowProvider: may20 });
  assert.equal(manager.currentDayUTC, "2026-05-20");
  assert.equal(manager.tradingEnabled, true);
  assert.equal(manager.dailyRealizedLoss, 0);
  assert.equal(manager.openTradeCount, 0);
}

{
  const stateFile = makeTempStateFile("risk-state.json");
  fs.writeFileSync(stateFile, JSON.stringify({
    currentDayUTC: 20,
    tradingEnabled: false,
    dailyRealizedPnLKES: -999,
    dailyRealizedProfit: 0,
    dailyRealizedLoss: 999,
    openTradeCount: 1,
    tradeLog: [{ id: "LEGACY" }],
  }));

  const manager = new RiskManager(testConfig(), { stateFile, nowProvider: may20 });
  assert.equal(manager.currentDayUTC, "2026-05-20");
  assert.equal(manager.tradingEnabled, true);
  assert.equal(manager.dailyRealizedLoss, 0);
  assert.equal(manager.openTradeCount, 0);
}

{
  const stateFile = makeTempStateFile("risk-state.json");
  const manager = new RiskManager(testConfig({
    risk: {
      dailyStopLossKES: 100,
      dailyProfitTargetKES: 10_000,
    },
  }), { stateFile, nowProvider: may20 });

  manager.onTradeClosed("T-loss", -150);
  const saved = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert.equal(saved.currentDayUTC, "2026-05-20");
  assert.equal(saved.tradingEnabled, false);
  assert.equal(saved.dailyRealizedLoss, 150);
}

console.log("risk-manager tests passed");

