'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Backtest = require('../js/backtest.js');
const Strategy = require('../js/signals.js');
const { randomCandles, bar } = require('./helpers.js');

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg || ''} beklenen ${b}, gelen ${a}`);

/** 100'de yatay seyreden mumlar; `moves` ile belirli mumlar değiştirilir. */
function flat(n, moves = {}) {
  return Array.from({ length: n }, (_, i) => {
    const m = moves[i];
    return m ? bar(i, m[0], m[1], m[2], m[3]) : bar(i, 100, 100.5, 99.5, 100);
  });
}

/** Elle sinyal: giriş mumu `ei`, giriş = o mumun açılışı. */
function sig(candles, ei, type, sl, extra = {}) {
  const s = Object.assign(
    { id: type + ei, type, kind: 'regular', sl, score: 50, entryIndex: ei, entryTime: candles[ei].time, confirmTime: candles[ei - 1].time, pending: false },
    extra
  );
  return Strategy.setEntry(s, candles[ei].open, {});
}

const NO_COST = { initialCapital: 10000, riskPct: 1, commissionPct: 0, slippagePct: 0, maxLeverage: 100, exitMode: 'partial' };

test('TP1 + TP2: PnL, R ve bakiye doğru', () => {
  const c = flat(10, { 3: [100, 108, 99, 106], 4: [106, 116, 105, 115] });
  const r = Backtest.simulate({ series: { X: c }, signals: { X: [sig(c, 2, 'BUY', 95)] }, settings: NO_COST });
  assert.equal(r.trades.length, 1);
  const t = r.trades[0];
  near(t.qty, 20, 1e-9, 'adet = 100$ risk / 5$');
  near(t.pnl, 225, 1e-9, '10×7.5 + 10×15');
  near(t.r, 2.25, 1e-12);
  assert.equal(t.result, 'TP1+TP2');
  near(r.metrics.finalEquity, 10225, 1e-9);
  near(r.metrics.totalReturnPct, 2.25, 1e-9);
});

test('Komisyon her dolumda işlem tutarından düşülür', () => {
  const c = flat(10, { 3: [100, 108, 99, 106], 4: [106, 116, 105, 115] });
  const r = Backtest.simulate({
    series: { X: c },
    signals: { X: [sig(c, 2, 'BUY', 95)] },
    settings: Object.assign({}, NO_COST, { commissionPct: 0.1 }),
  });
  const fees = 20 * 100 * 0.001 + 10 * 107.5 * 0.001 + 10 * 115 * 0.001;
  near(r.trades[0].fees, fees, 1e-9);
  near(r.trades[0].pnl, 225 - fees, 1e-9);
});

test('Aynı mumda TP ve SL → SL; slippage giriş ve stop dolumlarına uygulanır', () => {
  const c = flat(10, { 3: [100, 120, 90, 110] });
  const r = Backtest.simulate({
    series: { X: c },
    signals: { X: [sig(c, 2, 'BUY', 95)] },
    settings: Object.assign({}, NO_COST, { slippagePct: 0.1 }),
  });
  const t = r.trades[0];
  assert.equal(t.result, 'SL');
  near(t.entryPrice, 100.1, 1e-9, 'giriş aleyhe kayar');
  near(t.exitPrice, 95 * 0.999, 1e-9, 'stop aleyhe kayar');
  near(t.r, (95 * 0.999 - 100.1) / (100.1 - 95), 1e-9);
});

test('SELL pozisyonu kısmi modda TP1 sonrası başa baş kapanır', () => {
  const c = flat(10, { 3: [100, 101, 92, 94], 4: [94, 101, 93, 100.5] });
  const r = Backtest.simulate({ series: { X: c }, signals: { X: [sig(c, 2, 'SELL', 105)] }, settings: NO_COST });
  const t = r.trades[0];
  assert.equal(t.side, 'SELL');
  assert.equal(t.result, 'TP1+BE');
  near(t.pnl, 10 * 7.5, 1e-9); // yarısı 1.5R, yarısı 0
});

test('Coin başına tek pozisyon: açık pozisyon varken gelen sinyal atlanır', () => {
  const c = flat(20, { 12: [100, 116, 99, 115] });
  const r = Backtest.simulate({
    series: { X: c },
    signals: { X: [sig(c, 2, 'BUY', 95), sig(c, 5, 'BUY', 95)] },
    settings: Object.assign({}, NO_COST, { exitMode: 'tp2' }),
  });
  assert.equal(r.trades.length, 1);
  assert.equal(r.metrics.skippedCount, 1);
  assert.equal(r.skipped[0].reason, 'Açık pozisyon vardı');
});

test('Test sonunda açık pozisyon son kapanıştan kapatılır', () => {
  const c = flat(6, { 5: [100, 103, 99, 102] });
  const r = Backtest.simulate({ series: { X: c }, signals: { X: [sig(c, 2, 'BUY', 95)] }, settings: NO_COST });
  assert.equal(r.trades.length, 1);
  assert.equal(r.trades[0].result, 'END');
  near(r.trades[0].exitPrice, 102, 1e-9);
  near(r.metrics.finalEquity, 10000 + 20 * 2, 1e-9);
});

test('Kaldıraç sınırı pozisyon büyüklüğünü kısar', () => {
  const c = flat(10);
  // SL %0.5 uzakta → risk %1 için 2× büyüklük gerekir; sınır 1×
  const r = Backtest.simulate({
    series: { X: c },
    signals: { X: [sig(c, 2, 'BUY', 99.5)] },
    settings: Object.assign({}, NO_COST, { maxLeverage: 1 }),
  });
  near(r.trades[0].notional, 10000, 1e-6);
});

test('Yön filtresi: yalnızca long seçilince SELL sinyalleri işlenmez', () => {
  const c = flat(10);
  const r = Backtest.simulate({
    series: { X: c },
    signals: { X: [sig(c, 2, 'SELL', 105)] },
    settings: Object.assign({}, NO_COST, { direction: 'long' }),
  });
  assert.equal(r.trades.length, 0);
  assert.equal(r.metrics.signalCount, 0);
});

test('Tarih aralığı dışındaki girişler işlenmez', () => {
  const c = flat(10);
  const r = Backtest.simulate({
    series: { X: c },
    signals: { X: [sig(c, 2, 'BUY', 95)] },
    startTime: c[3].time,
    settings: NO_COST,
  });
  assert.equal(r.trades.length, 0);
});

test('Metrikler: kazanma oranı, profit factor, en uzun kayıp serisi, max drawdown', () => {
  const pnls = [100, -50, -30, 20, -10, -10, -10];
  const trades = pnls.map((p, i) => ({ pnl: p, r: p / 100, fees: 0, bars: 1, entryTime: i, exitTime: i }));
  const equity = [10000, 11000, 9900, 10500].map((v, i) => ({ time: i * 86400000, value: v }));
  const m = Backtest.metrics(trades, equity, 10000);
  near(m.winRate, (2 / 7) * 100, 1e-9);
  near(m.profitFactor, 120 / 110, 1e-9);
  assert.equal(m.maxLosingStreak, 3);
  near(m.maxDrawdownPct, 10, 1e-9);
  near(m.avgR, pnls.reduce((a, b) => a + b, 0) / 100 / 7, 1e-12);
  assert.ok(Number.isFinite(m.sharpe));
});

test('Uçtan uca: strateji + portföy, çoklu coin, tutarlı muhasebe', () => {
  const series = { A: randomCandles(2500, 3), B: randomCandles(2500, 5) };
  const r = Backtest.run({
    series,
    strategy: { useHidden: true },
    settings: { initialCapital: 10000, riskPct: 1, commissionPct: 0.1, slippagePct: 0.05, maxLeverage: 3, exitMode: 'partial' },
  });
  assert.ok(r.trades.length > 5, `işlem sayısı ${r.trades.length}`);
  const sum = r.trades.reduce((s, t) => s + t.pnl, 0);
  near(r.metrics.finalEquity, 10000 + sum, 1e-6, 'bakiye = başlangıç + işlem PnL toplamı');
  // Aynı coinde işlemler çakışmamalı
  for (const inst of ['A', 'B']) {
    const list = r.trades.filter((t) => t.inst === inst);
    for (let k = 1; k < list.length; k++) assert.ok(list[k].entryIndex > list[k - 1].exitIndex || list[k].entryTime > list[k - 1].exitTime);
  }
  assert.equal(r.equity.length, 2500);
});
