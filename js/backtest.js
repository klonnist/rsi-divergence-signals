/**
 * backtest.js — Portföy backtest motoru (saf fonksiyonlar, DOM'a dokunmaz).
 *
 * Sinyaller signals.js → Strategy.run ile, çıkışlar Strategy.stepExit ile
 * üretilir; sinyal paneliyle aynı strateji kodu kullanılır.
 *
 * Kurallar:
 *  - Coin başına aynı anda tek pozisyon. Mumun açılışında pozisyon açıksa o
 *    mumdaki yeni sinyal atlanır.
 *  - Giriş, onaydan sonraki mumun açılışında (aleyhe slippage ile).
 *  - Aynı mumda hem TP hem SL görülürse SL kabul edilir.
 *  - Pozisyon büyüklüğü: (bakiye × risk%) / |giriş − SL|. Açık pozisyonların
 *    toplam büyüklüğü bakiye × maxLeverage'ı aşamaz.
 *  - Komisyon her dolumda işlem tutarı üzerinden alınır. Slippage piyasa ve
 *    stop emirlerine (giriş, SL, başa baş, test sonu) uygulanır; TP'ler limit
 *    emir kabul edilir.
 *  - Test sonunda açık kalan pozisyonlar son kapanıştan kapatılır.
 */
(function (root) {
  'use strict';

  const Strategy = root.Strategy || (typeof require === 'function' ? require('./signals.js') : undefined);

  const DEFAULTS = Object.freeze({
    initialCapital: 10000,
    riskPct: 1,
    commissionPct: 0.1,
    slippagePct: 0.05,
    maxLeverage: 3,
    exitMode: 'partial',
    direction: 'both',
  });

  const DAY_MS = 86400000;

  /**
   * Strateji + simülasyon.
   * @param {object} input
   *   series    {instId: candles[]}  kapanmış mumlar (ısınma mumları dahil), eskiden yeniye
   *   startTime, endTime  ms — yalnızca girişi bu aralıkta olan sinyaller işlenir
   *   strategy  Strategy.run parametreleri
   *   settings  DEFAULTS ile aynı alanlar
   */
  function run(input) {
    const signals = {};
    const strategyResults = {};
    for (const inst of Object.keys(input.series)) {
      const res = Strategy.run(input.series[inst], input.strategy);
      strategyResults[inst] = res;
      signals[inst] = res.signals;
    }
    const result = simulate(Object.assign({}, input, { signals }));
    result.strategyResults = strategyResults;
    return result;
  }

  /** Verilen sinyallerle portföy simülasyonu. */
  function simulate({ series, signals, startTime = -Infinity, endTime = Infinity, settings }) {
    const s = Object.assign({}, DEFAULTS, settings);
    const comm = s.commissionPct / 100;
    const slip = s.slippagePct / 100;
    const insts = Object.keys(series);

    // Coin başına: zaman → indeks eşlemesi ve giriş mumuna göre sinyaller
    const book = {};
    let signalCount = 0;
    for (const inst of insts) {
      const candles = series[inst];
      const idx = new Map();
      candles.forEach((c, i) => idx.set(c.time, i));
      const byEntry = new Map();
      for (const sig of signals[inst] || []) {
        if (!sig.valid || sig.pending) continue;
        if (sig.entryTime < startTime || sig.entryTime > endTime) continue;
        if (s.direction === 'long' && sig.type !== 'BUY') continue;
        if (s.direction === 'short' && sig.type !== 'SELL') continue;
        signalCount++;
        const prev = byEntry.get(sig.entryIndex);
        if (!prev || sig.score > prev.score) byEntry.set(sig.entryIndex, sig);
      }
      book[inst] = { candles, idx, byEntry };
    }

    // Tüm coinlerin ortak zaman çizelgesi
    const timeSet = new Set();
    for (const inst of insts) {
      for (const c of series[inst]) if (c.time >= startTime && c.time <= endTime) timeSet.add(c.time);
    }
    const times = Array.from(timeSet).sort((a, b) => a - b);

    let balance = s.initialCapital; // gerçekleşmiş bakiye
    const open = new Map(); // inst → pozisyon
    const trades = [];
    const skipped = [];
    const equity = [];

    function applyFill(pos, f, time, index) {
      const qty = pos.qty * f.fraction;
      let price = f.price;
      if (f.reason === 'SL' || f.reason === 'BE' || f.reason === 'END') {
        price = pos.isBuy ? price * (1 - slip) : price * (1 + slip);
      }
      const gross = (pos.isBuy ? price - pos.entry : pos.entry - price) * qty;
      const fee = price * qty * comm;
      balance += gross - fee;
      pos.fees += fee;
      pos.pnl += gross - fee;
      pos.fills.push({ time, index, price, qty, fraction: f.fraction, reason: f.reason });
    }

    function finalize(pos) {
      open.delete(pos.inst);
      let qtyOut = 0;
      let value = 0;
      for (const f of pos.fills) {
        qtyOut += f.qty;
        value += f.qty * f.price;
      }
      const last = pos.fills[pos.fills.length - 1];
      trades.push({
        inst: pos.inst,
        side: pos.isBuy ? 'BUY' : 'SELL',
        kind: pos.sig.kind,
        score: pos.sig.score,
        signalId: pos.sig.id,
        signalTime: pos.sig.confirmTime,
        entryTime: pos.entryTime,
        entryIndex: pos.entryIndex,
        entryPrice: pos.entry,
        sl: pos.sl,
        tp1: pos.tp1,
        tp2: pos.tp2,
        qty: pos.qty,
        notional: pos.qty * pos.entry,
        exitTime: last.time,
        exitIndex: last.index,
        exitPrice: value / qtyOut,
        result: pos.fills.map((f) => f.reason).join('+'),
        pnl: pos.pnl,
        pnlPct: (pos.pnl / pos.equityAtEntry) * 100,
        r: pos.riskAmount > 0 ? pos.pnl / pos.riskAmount : 0,
        fees: pos.fees,
        bars: last.index - pos.entryIndex + 1,
        fills: pos.fills,
      });
    }

    function step(pos, bar, i) {
      for (const f of Strategy.stepExit(pos, bar, s.exitMode)) applyFill(pos, f, bar.time, i);
      pos.mark = bar.close;
      if (!(pos.remaining > 0)) finalize(pos);
    }

    function enter(inst, sig, bar, i) {
      const isBuy = sig.type === 'BUY';
      const entry = isBuy ? bar.open * (1 + slip) : bar.open * (1 - slip);
      const riskPerUnit = isBuy ? entry - sig.sl : sig.sl - entry;
      if (!(riskPerUnit > 0)) {
        skipped.push({ inst, time: bar.time, reason: 'Giriş SL’in ötesinde açıldı' });
        return null;
      }
      let qty = (balance * s.riskPct) / 100 / riskPerUnit;
      // Kaldıraç sınırı: açık pozisyonlarla birlikte toplam büyüklük
      let used = 0;
      for (const p of open.values()) used += p.qty * p.remaining * p.entry;
      const room = balance * s.maxLeverage - used;
      let capped = false;
      if (qty * entry > room) {
        qty = room / entry;
        capped = true;
      }
      if (!(qty > 0) || !(balance > 0)) {
        skipped.push({ inst, time: bar.time, reason: 'Yetersiz marj' });
        return null;
      }
      const fee = qty * entry * comm;
      const pos = Strategy.newPosition(isBuy, entry, sig.sl, sig.tp1, sig.tp2);
      Object.assign(pos, {
        inst,
        sig,
        qty,
        capped,
        entryIndex: i,
        entryTime: bar.time,
        equityAtEntry: balance,
        riskAmount: qty * riskPerUnit,
        fees: fee,
        pnl: -fee,
        fills: [],
        mark: bar.open,
      });
      balance -= fee;
      return pos;
    }

    // Ana döngü: her zaman adımında her coin için önce çıkışlar, sonra yeni giriş
    for (const t of times) {
      for (const inst of insts) {
        const B = book[inst];
        const i = B.idx.get(t);
        if (i === undefined) continue;
        const bar = B.candles[i];
        const pos = open.get(inst);
        const sig = B.byEntry.get(i);
        if (pos) {
          step(pos, bar, i);
          if (sig) skipped.push({ inst, time: t, reason: 'Açık pozisyon vardı' });
        } else if (sig) {
          const np = enter(inst, sig, bar, i);
          if (np) {
            open.set(inst, np);
            step(np, bar, i); // giriş mumunun kendi hareketi de kontrol edilir
          }
        }
      }
      // Mum kapanışında piyasa değeriyle sermaye
      let unrealized = 0;
      for (const p of open.values()) {
        const q = p.qty * p.remaining;
        unrealized += (p.isBuy ? p.mark - p.entry : p.entry - p.mark) * q;
      }
      equity.push({ time: t, value: balance + unrealized });
    }

    // Test sonunda açık pozisyonları kapat
    for (const pos of Array.from(open.values())) {
      const B = book[pos.inst];
      const lastIdx = pos.fills.length ? pos.fills[pos.fills.length - 1].index : pos.entryIndex;
      let li = lastIdx;
      while (li + 1 < B.candles.length && B.candles[li + 1].time <= endTime) li++;
      applyFill(pos, { price: pos.mark, fraction: pos.remaining, reason: 'END' }, B.candles[li].time, li);
      pos.remaining = 0;
      finalize(pos);
    }
    if (equity.length) equity[equity.length - 1].value = balance;

    trades.sort((a, b) => a.entryTime - b.entryTime || a.inst.localeCompare(b.inst));
    trades.forEach((t, k) => (t.no = k + 1));

    const m = metrics(trades, equity, s.initialCapital);
    m.signalCount = signalCount;
    m.skippedCount = skipped.length;

    return {
      settings: s,
      trades,
      equity,
      drawdown: drawdownSeries(equity, s.initialCapital),
      metrics: m,
      perInst: perInstStats(insts, trades, book, startTime, endTime),
      skipped,
    };
  }

  function drawdownSeries(equity, initialCapital) {
    let peak = initialCapital;
    return equity.map((p) => {
      if (p.value > peak) peak = p.value;
      return { time: p.time, value: peak > 0 ? ((p.value - peak) / peak) * 100 : 0 };
    });
  }

  /** Performans metrikleri. */
  function metrics(trades, equity, initialCapital) {
    const n = trades.length;
    let grossWin = 0;
    let grossLoss = 0;
    let wins = 0;
    let sumR = 0;
    let fees = 0;
    let bars = 0;
    let streak = 0;
    let maxStreak = 0;
    const ordered = trades.slice().sort((a, b) => a.exitTime - b.exitTime || a.entryTime - b.entryTime);
    for (const t of ordered) {
      if (t.pnl > 0) {
        wins++;
        grossWin += t.pnl;
        streak = 0;
      } else {
        grossLoss -= t.pnl;
        streak++;
        if (streak > maxStreak) maxStreak = streak;
      }
      sumR += t.r;
      fees += t.fees;
      bars += t.bars;
    }

    const finalEquity = equity.length ? equity[equity.length - 1].value : initialCapital;

    // Maksimum düşüş (mum kapanışlarındaki piyasa değerli sermaye üzerinden)
    let peak = initialCapital;
    let maxDD = 0;
    for (const p of equity) {
      if (p.value > peak) peak = p.value;
      const dd = peak > 0 ? (peak - p.value) / peak : 0;
      if (dd > maxDD) maxDD = dd;
    }

    // Sharpe: günlük getiriler (UTC gün sonu sermaye), risksiz faiz 0, yıllık √365 (kripto 7/24)
    const rets = [];
    let prevClose = initialCapital;
    let curDay = null;
    let curVal = initialCapital;
    for (const p of equity) {
      const day = Math.floor(p.time / DAY_MS);
      if (curDay !== null && day !== curDay) {
        rets.push(curVal / prevClose - 1);
        prevClose = curVal;
      }
      curDay = day;
      curVal = p.value;
    }
    if (curDay !== null) rets.push(curVal / prevClose - 1);
    let sharpe = null;
    if (rets.length > 1) {
      const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
      const variance = rets.reduce((a, b) => a + (b - mean) * (b - mean), 0) / (rets.length - 1);
      const sd = Math.sqrt(variance);
      sharpe = sd > 0 ? (mean / sd) * Math.sqrt(365) : null;
    }

    return {
      totalReturnPct: (finalEquity / initialCapital - 1) * 100,
      trades: n,
      wins,
      losses: n - wins,
      winRate: n ? (wins / n) * 100 : null,
      profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : null,
      avgR: n ? sumR / n : null,
      maxDrawdownPct: maxDD * 100,
      sharpe,
      maxLosingStreak: maxStreak,
      finalEquity,
      netProfit: finalEquity - initialCapital,
      grossWin,
      grossLoss,
      totalFees: fees,
      avgBars: n ? bars / n : null,
    };
  }

  function perInstStats(insts, trades, book, startTime, endTime) {
    return insts.map((inst) => {
      const list = trades.filter((t) => t.inst === inst);
      let win = 0;
      let lose = 0;
      let wins = 0;
      let sumR = 0;
      for (const t of list) {
        if (t.pnl > 0) {
          wins++;
          win += t.pnl;
        } else lose -= t.pnl;
        sumR += t.r;
      }
      const inRange = book[inst].candles.filter((c) => c.time >= startTime && c.time <= endTime);
      const buyHold = inRange.length > 1 ? (inRange[inRange.length - 1].close / inRange[0].open - 1) * 100 : null;
      return {
        inst,
        trades: list.length,
        winRate: list.length ? (wins / list.length) * 100 : null,
        pnl: win - lose,
        profitFactor: lose > 0 ? win / lose : win > 0 ? Infinity : null,
        avgR: list.length ? sumR / list.length : null,
        buyHoldPct: buyHold,
      };
    });
  }

  const Backtest = { DEFAULTS, run, simulate, metrics };

  if (typeof module === 'object' && module.exports) module.exports = Backtest;
  root.Backtest = Backtest;
})(typeof globalThis !== 'undefined' ? globalThis : this);
