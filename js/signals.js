/**
 * signals.js — ORTAK STRATEJİ.
 *
 * Sinyal paneli ve backtest motoru sinyalleri YALNIZCA `run` ile üretir, çıkış
 * kurallarını (SL / TP1 / TP2 / başa baş) YALNIZCA `stepExit` ile işletir.
 * Böylece panelde gördüğünüz sinyal ile backtest'te test edilen sinyal
 * birebir aynı koddan gelir.
 *
 * Zamanlama (lookahead olmadan):
 *   i2            → ikinci pivot mumu
 *   i2 + sağ (N)  → pivotun onaylandığı mum (confirmIndex); sinyal bu mum kapanınca oluşur
 *   confirm + 1   → giriş mumu; giriş bu mumun AÇILIŞ fiyatından yapılır
 */
(function (root) {
  'use strict';

  const load = (name, path) => root[name] || (typeof require === 'function' ? require(path) : undefined);
  const Indicators = load('Indicators', './indicators.js');
  const Divergence = load('Divergence', './divergence.js');

  const DEFAULTS = Object.freeze({
    rsiPeriod: 14,
    pivotLeft: 5,
    pivotRight: 5,
    minBars: 5,
    maxBars: 60,
    bullRsiMax: 40,
    bearRsiMin: 60,
    useHidden: false,
    useEmaFilter: false,
    emaPeriod: 200,
    atrPeriod: 14,
    atrMult: 0.5,
    tp1R: 1.5,
    tp2R: 3,
  });

  /**
   * Güç skoru (0–100):
   *   RSI farkı   → 40 puan (10 RSI puanı ve üstü = tam puan)
   *   Fiyat farkı → 30 puan (ATR cinsinden; 2 ATR ve üstü = tam puan)
   *   Trend uyumu → 30 puan (sinyal yönü EMA trendiyle aynıysa; EMA yoksa 15)
   */
  function scoreOf(d, atr, trendUp) {
    const rsiDiff = Math.abs(d.rsi2 - d.rsi1);
    const priceDiffAtr = Math.abs(d.price2 - d.price1) / atr;
    const aligned = trendUp == null ? null : (d.type === 'BUY') === trendUp;
    const rsiPts = Math.min(rsiDiff / 10, 1) * 40;
    const pricePts = Math.min(priceDiffAtr / 2, 1) * 30;
    const trendPts = aligned == null ? 15 : aligned ? 30 : 0;
    return { total: Math.round(rsiPts + pricePts + trendPts), rsiPts, pricePts, trendPts, rsiDiff, priceDiffAtr, aligned };
  }

  /** Giriş fiyatı belli olduğunda risk ve TP seviyelerini hesaplar (sinyali yerinde günceller). */
  function setEntry(sig, entry, params) {
    const p = Object.assign({}, DEFAULTS, params);
    const isBuy = sig.type === 'BUY';
    const risk = isBuy ? entry - sig.sl : sig.sl - entry;
    sig.entry = entry;
    sig.risk = risk;
    sig.rr1 = p.tp1R;
    sig.rr2 = p.tp2R;
    sig.valid = risk > 0;
    if (!sig.valid) {
      sig.tp1 = sig.tp2 = null;
      return sig;
    }
    const dir = isBuy ? 1 : -1;
    sig.tp1 = entry + dir * p.tp1R * risk;
    sig.tp2 = entry + dir * p.tp2R * risk;
    return sig;
  }

  /**
   * Stratejiyi çalıştırır.
   * @param {{time:number, open:number, high:number, low:number, close:number}[]} candles
   *        YALNIZCA kapanmış mumlar, eskiden yeniye.
   * @param {object} params DEFAULTS ile aynı alanlar
   */
  function run(candles, params) {
    const p = Object.assign({}, DEFAULTS, params);
    const n = candles.length;
    const open = new Array(n);
    const high = new Array(n);
    const low = new Array(n);
    const close = new Array(n);
    for (let i = 0; i < n; i++) {
      const c = candles[i];
      open[i] = c.open;
      high[i] = c.high;
      low[i] = c.low;
      close[i] = c.close;
    }

    const rsi = Indicators.rsi(close, p.rsiPeriod);
    const atr = Indicators.atr(high, low, close, p.atrPeriod);
    const ema = Indicators.ema(close, p.emaPeriod);
    const det = Divergence.detect({ high, low, rsi }, p);

    const signals = [];
    for (const d of det.divergences) {
      const ci = d.confirmIndex; // sinyal bu mumun kapanışında biliniyor
      const ei = ci + 1; // giriş: bir sonraki mumun açılışı
      const a = atr[ci];
      if (a == null || !(a > 0)) continue;

      const isBuy = d.type === 'BUY';
      const e = ema[ci];
      const trendUp = e == null ? null : close[ci] > e;
      if (p.useEmaFilter && (trendUp == null || isBuy !== trendUp)) continue;

      // SL: son swing (ikinci pivot) ∓ atrMult × ATR — ATR onay mumundaki değer
      const sl = isBuy ? d.price2 - p.atrMult * a : d.price2 + p.atrMult * a;
      const sc = scoreOf(d, a, trendUp);

      const sig = {
        id: d.type + ':' + d.kind + ':' + candles[d.i2].time,
        type: d.type,
        kind: d.kind,
        i1: d.i1,
        i2: d.i2,
        time1: candles[d.i1].time,
        time2: candles[d.i2].time,
        price1: d.price1,
        price2: d.price2,
        rsi1: d.rsi1,
        rsi2: d.rsi2,
        confirmIndex: ci,
        confirmTime: candles[ci].time,
        entryIndex: ei,
        entryTime: ei < n ? candles[ei].time : null,
        pending: ei >= n, // giriş mumu henüz kapanmış veride yok (canlı mum)
        atr: a,
        ema: e,
        trendUp,
        sl,
        score: sc.total,
        scoreParts: sc,
        entry: null,
        risk: null,
        tp1: null,
        tp2: null,
        rr1: p.tp1R,
        rr2: p.tp2R,
        valid: false,
      };
      if (!sig.pending) setEntry(sig, open[ei], p);
      signals.push(sig);
    }

    return {
      params: p,
      rsi,
      atr,
      ema,
      pivotLows: det.pivotLows,
      pivotHighs: det.pivotHighs,
      divergences: det.divergences,
      signals,
    };
  }

  // ----------------------------------------------------------------------
  // ÇIKIŞ KURALLARI (panel durumu ve backtest aynı fonksiyonu kullanır)
  // ----------------------------------------------------------------------

  /** Çıkış takibi için pozisyon durumu. `remaining`: kalan pay (1 → 0.5 → 0). */
  function newPosition(isBuy, entry, sl, tp1, tp2) {
    return { isBuy, entry, sl, stop: sl, tp1, tp2, tp1Hit: false, remaining: 1 };
  }

  /**
   * Pozisyonu tek bir mum boyunca ilerletir; gerçekleşen çıkışları döndürür.
   * Muhafazakâr kurallar:
   *  - Aynı mumda hem stop hem hedef görülürse STOP kabul edilir.
   *  - Mum stop seviyesinin ötesinde açılırsa (gap) çıkış açılış fiyatından olur.
   *  - exitMode 'partial': TP1'de yarısı kapanır, stop girişe (başa baş) çekilir,
   *    kalan TP2'yi bekler. TP1 mumunda kapanış girişin aleyhine ise başa baş
   *    stop o mumda kesin tetiklenmiştir.
   *  - exitMode 'tp1' / 'tp2': pozisyonun tamamı o hedefte kapanır.
   *
   * @returns {{price:number, fraction:number, reason:'SL'|'BE'|'TP1'|'TP2'}[]}
   */
  function stepExit(pos, bar, exitMode) {
    const fills = [];
    if (!(pos.remaining > 0)) return fills;
    const buy = pos.isBuy;

    const stopHit = buy ? bar.low <= pos.stop : bar.high >= pos.stop;
    if (stopHit) {
      const price = buy ? Math.min(pos.stop, bar.open) : Math.max(pos.stop, bar.open);
      fills.push({ price, fraction: pos.remaining, reason: pos.tp1Hit ? 'BE' : 'SL' });
      pos.remaining = 0;
      return fills;
    }

    const reached = (level) => (buy ? bar.high >= level : bar.low <= level);
    const fillAt = (level) => (buy ? Math.max(level, bar.open) : Math.min(level, bar.open));

    if (exitMode === 'tp1' || exitMode === 'tp2') {
      const level = exitMode === 'tp1' ? pos.tp1 : pos.tp2;
      if (reached(level)) {
        fills.push({ price: fillAt(level), fraction: pos.remaining, reason: exitMode === 'tp1' ? 'TP1' : 'TP2' });
        pos.remaining = 0;
      }
      return fills;
    }

    // 'partial'
    if (!pos.tp1Hit) {
      if (!reached(pos.tp1)) return fills;
      const half = pos.remaining / 2;
      fills.push({ price: fillAt(pos.tp1), fraction: half, reason: 'TP1' });
      pos.remaining -= half;
      pos.tp1Hit = true;
      pos.stop = pos.entry; // SL'i girişe çek
      if (reached(pos.tp2)) {
        fills.push({ price: fillAt(pos.tp2), fraction: pos.remaining, reason: 'TP2' });
        pos.remaining = 0;
      } else if (buy ? bar.close <= pos.entry : bar.close >= pos.entry) {
        fills.push({ price: pos.entry, fraction: pos.remaining, reason: 'BE' });
        pos.remaining = 0;
      }
      return fills;
    }
    if (reached(pos.tp2)) {
      fills.push({ price: fillAt(pos.tp2), fraction: pos.remaining, reason: 'TP2' });
      pos.remaining = 0;
    }
    return fills;
  }

  /**
   * Bir sinyalin giriş sonrası durumunu hesaplar (sinyal paneli için).
   * @param sig    geçerli girişi olan sinyal
   * @param bars   giriş mumundan itibaren mumlar (canlı mum eklenebilir)
   * @returns {{status:string, fills:object[], open:boolean, r:number}}
   *   status: 'PENDING' | 'OPEN' | 'TP1_OPEN' | 'TP1' | 'TP2' | 'SL' | 'BE' | 'INVALID'
   *   r: gerçekleşen R (kapanan paylar için)
   */
  function evaluate(sig, bars, exitMode) {
    if (!sig.valid) return { status: 'INVALID', fills: [], open: false, r: 0 };
    const pos = newPosition(sig.type === 'BUY', sig.entry, sig.sl, sig.tp1, sig.tp2);
    const fills = [];
    for (let k = 0; k < bars.length && pos.remaining > 0; k++) {
      for (const f of stepExit(pos, bars[k], exitMode)) fills.push(Object.assign({ time: bars[k].time, bar: k }, f));
    }
    const dir = pos.isBuy ? 1 : -1;
    const r = fills.reduce((s, f) => s + (f.fraction * dir * (f.price - sig.entry)) / sig.risk, 0);
    let status;
    if (!bars.length) status = 'PENDING';
    else if (pos.remaining > 0) status = pos.tp1Hit ? 'TP1_OPEN' : 'OPEN';
    else status = fills[fills.length - 1].reason;
    return { status, fills, open: pos.remaining > 0, r, pos };
  }

  const Strategy = { DEFAULTS, run, setEntry, scoreOf, newPosition, stepExit, evaluate };

  if (typeof module === 'object' && module.exports) module.exports = Strategy;
  root.Strategy = Strategy;
})(typeof globalThis !== 'undefined' ? globalThis : this);
