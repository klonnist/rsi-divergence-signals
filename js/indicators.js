/**
 * indicators.js — Teknik göstergeler (saf fonksiyonlar, DOM'a dokunmaz).
 *
 * Tüm fonksiyonlar girdiyle AYNI uzunlukta dizi döndürür; henüz
 * hesaplanamayan (ısınma) indekslerde değer `null` olur. Her değer yalnızca
 * o mum ve öncesindeki verilerle hesaplanır, yani gelecekten bilgi sızmaz.
 */
(function (root) {
  'use strict';

  /** Basit hareketli ortalama. */
  function sma(values, period) {
    const out = new Array(values.length).fill(null);
    if (!(period > 0)) return out;
    let sum = 0;
    for (let i = 0; i < values.length; i++) {
      sum += values[i];
      if (i >= period) sum -= values[i - period];
      if (i >= period - 1) out[i] = sum / period;
    }
    return out;
  }

  /** Üstel hareketli ortalama; ilk değer, ilk `period` elemanın SMA'sı ile tohumlanır. */
  function ema(values, period) {
    const out = new Array(values.length).fill(null);
    if (!(period > 0) || values.length < period) return out;
    const k = 2 / (period + 1);
    let prev = 0;
    for (let i = 0; i < period; i++) prev += values[i];
    prev /= period;
    out[period - 1] = prev;
    for (let i = period; i < values.length; i++) {
      prev = values[i] * k + prev * (1 - k);
      out[i] = prev;
    }
    return out;
  }

  /**
   * Wilder yumuşatması (RMA): ilk değer SMA, sonrası
   * ort = (önceki × (n − 1) + değer) / n. RSI ve ATR bunu kullanır.
   */
  function rma(values, period) {
    const out = new Array(values.length).fill(null);
    if (!(period > 0) || values.length < period) return out;
    let prev = 0;
    for (let i = 0; i < period; i++) prev += values[i];
    prev /= period;
    out[period - 1] = prev;
    for (let i = period; i < values.length; i++) {
      prev = (prev * (period - 1) + values[i]) / period;
      out[i] = prev;
    }
    return out;
  }

  function rsiFromAverages(avgGain, avgLoss) {
    if (avgLoss === 0) return avgGain === 0 ? 50 : 100; // hiç hareket yoksa nötr (50)
    return 100 - 100 / (1 + avgGain / avgLoss);
  }

  /**
   * RSI — Wilder yöntemi.
   * İlk ortalama kazanç/kayıp, ilk `period` fiyat değişiminin basit ortalamasıdır;
   * sonrası Wilder yumuşatması ile güncellenir. İlk geçerli değer `period`
   * indeksindedir (TradingView ta.rsi ile aynı).
   */
  function rsi(closes, period = 14) {
    const n = closes.length;
    const out = new Array(n).fill(null);
    if (!(period > 0) || n <= period) return out;

    let gain = 0;
    let loss = 0;
    for (let i = 1; i <= period; i++) {
      const ch = closes[i] - closes[i - 1];
      if (ch > 0) gain += ch;
      else loss -= ch;
    }
    let avgGain = gain / period;
    let avgLoss = loss / period;
    out[period] = rsiFromAverages(avgGain, avgLoss);

    for (let i = period + 1; i < n; i++) {
      const ch = closes[i] - closes[i - 1];
      avgGain = (avgGain * (period - 1) + (ch > 0 ? ch : 0)) / period;
      avgLoss = (avgLoss * (period - 1) + (ch < 0 ? -ch : 0)) / period;
      out[i] = rsiFromAverages(avgGain, avgLoss);
    }
    return out;
  }

  /** Gerçek aralık: max(H − L, |H − önceki C|, |L − önceki C|). İlk mumda H − L. */
  function trueRange(high, low, close) {
    const n = high.length;
    const out = new Array(n);
    for (let i = 0; i < n; i++) {
      const hl = high[i] - low[i];
      if (i === 0) {
        out[i] = hl;
        continue;
      }
      const pc = close[i - 1];
      out[i] = Math.max(hl, Math.abs(high[i] - pc), Math.abs(low[i] - pc));
    }
    return out;
  }

  /** ATR — gerçek aralığın Wilder yumuşatması. İlk geçerli değer `period − 1` indeksinde. */
  function atr(high, low, close, period = 14) {
    return rma(trueRange(high, low, close), period);
  }

  const Indicators = { sma, ema, rma, rsi, trueRange, atr };

  if (typeof module === 'object' && module.exports) module.exports = Indicators;
  root.Indicators = Indicators;
})(typeof globalThis !== 'undefined' ? globalThis : this);
