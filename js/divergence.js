/**
 * divergence.js — Pivot (swing) tespiti ve RSI–fiyat uyumsuzlukları.
 *
 * LOOKAHEAD YOK: i indeksindeki bir pivot, sağındaki `right` mum kapanmadan
 * bilinemez. Bu yüzden her pivot `confirmIndex = i + right` ile döner ve
 * dizinin son `right` mumunda pivot aranmaz. Uyumsuzluk da ikinci pivotun
 * onaylandığı mumda (confirmIndex) oluşmuş sayılır.
 */
(function (root) {
  'use strict';

  /**
   * Pivot dip/tepe bulur.
   * Dip: değer soldaki `left` mumun hepsinden KESİN küçük, sağdaki `right`
   * mumun hepsinden küçük-veya-eşit olmalı (eşit diplerde ilki pivot sayılır).
   * Tepe için tersi geçerlidir.
   *
   * @param {number[]} values  dip için low, tepe için high dizisi
   * @param {number} left
   * @param {number} right
   * @param {'low'|'high'} type
   * @returns {{index:number, confirmIndex:number, price:number}[]}
   */
  function findPivots(values, left, right, type) {
    const pivots = [];
    const n = values.length;
    const isLow = type === 'low';
    for (let i = left; i + right < n; i++) {
      const v = values[i];
      let ok = true;
      for (let j = i - left; j < i && ok; j++) ok = isLow ? v < values[j] : v > values[j];
      for (let j = i + 1; j <= i + right && ok; j++) ok = isLow ? v <= values[j] : v >= values[j];
      if (ok) pivots.push({ index: i, confirmIndex: i + right, price: v });
    }
    return pivots;
  }

  /**
   * Bir fiyat pivotuna karşılık gelen RSI tepesi/dibi.
   * RSI kapanışlarla hesaplanır; fiyat pivotu fitilli bir mumsa (yüksek fitil, düşük kapanış)
   * RSI o mumda zaten dönmüş olur ve gerçek RSI tepesi bir iki mum öncedir. Bu yüzden pivotun
   * ±window mum çevresindeki en uç RSI değeri alınır. Sağ sınır onay mumunu (pivot + right)
   * geçmez → lookahead yok.
   * @returns {{value:number|null, index:number}}
   */
  function rsiExtreme(rsi, i, window, right, isHigh) {
    const from = Math.max(0, i - window);
    const to = Math.min(rsi.length - 1, i + Math.min(window, right));
    let value = null;
    let index = -1;
    for (let j = from; j <= to; j++) {
      const v = rsi[j];
      if (v == null) continue;
      if (value == null || (isHigh ? v > value : v < value)) {
        value = v;
        index = j;
      }
    }
    return { value, index };
  }

  /**
   * Ardışık iki pivot arasındaki uyumsuzlukları bulur.
   *
   *  Pozitif (BUY)  normal: fiyat daha düşük dip,  RSI daha yüksek dip, RSI2 < bullRsiMax
   *                 gizli : fiyat daha yüksek dip, RSI daha düşük dip
   *  Negatif (SELL) normal: fiyat daha yüksek tepe, RSI daha düşük tepe, RSI2 > bearRsiMin
   *                 gizli : fiyat daha düşük tepe, RSI daha yüksek tepe
   *
   * İki pivot arası minBars–maxBars mum olmalıdır. Karşılaştırma her zaman bir
   * önceki pivotla yapılır (swing dizisi bozulmaz). Fiyat tarafında pivotun kendisi,
   * RSI tarafında pivotun ±rsiWindow mum çevresindeki RSI tepesi/dibi kullanılır.
   *
   * @param {{high:number[], low:number[], rsi:(number|null)[]}} data
   * @param {object} opts pivotLeft, pivotRight, minBars, maxBars, bullRsiMax, bearRsiMin, useHidden, rsiWindow
   */
  function detect(data, opts) {
    const o = Object.assign(
      { pivotLeft: 5, pivotRight: 5, minBars: 5, maxBars: 60, bullRsiMax: 40, bearRsiMin: 60, useHidden: false, rsiWindow: 2 },
      opts
    );
    const pivotLows = findPivots(data.low, o.pivotLeft, o.pivotRight, 'low');
    const pivotHighs = findPivots(data.high, o.pivotLeft, o.pivotRight, 'high');
    const divergences = [];

    const scan = (pivots, bullish) => {
      for (let k = 1; k < pivots.length; k++) {
        const p1 = pivots[k - 1];
        const p2 = pivots[k];
        const dist = p2.index - p1.index;
        if (dist < o.minBars || dist > o.maxBars) continue;
        if (data.rsi[p1.index] == null || data.rsi[p2.index] == null) continue; // RSI henüz ısınmadı
        const e1 = rsiExtreme(data.rsi, p1.index, o.rsiWindow, o.pivotRight, !bullish);
        const e2 = rsiExtreme(data.rsi, p2.index, o.rsiWindow, o.pivotRight, !bullish);
        const r1 = e1.value;
        const r2 = e2.value;

        let kind = null;
        if (bullish) {
          if (p2.price < p1.price && r2 > r1 && r2 < o.bullRsiMax) kind = 'regular';
          else if (o.useHidden && p2.price > p1.price && r2 < r1) kind = 'hidden';
        } else {
          if (p2.price > p1.price && r2 < r1 && r2 > o.bearRsiMin) kind = 'regular';
          else if (o.useHidden && p2.price < p1.price && r2 > r1) kind = 'hidden';
        }
        if (!kind) continue;

        divergences.push({
          type: bullish ? 'BUY' : 'SELL',
          kind,
          i1: p1.index,
          i2: p2.index,
          price1: p1.price,
          price2: p2.price,
          rsi1: r1,
          rsi2: r2,
          rsiIndex1: e1.index, // RSI tepesinin/dibinin olduğu mum (grafikte çizgi buraya çizilir)
          rsiIndex2: e2.index,
          confirmIndex: p2.confirmIndex,
        });
      }
    };
    scan(pivotLows, true);
    scan(pivotHighs, false);

    // Zaman sırasına koy (aynı mumda onaylananlar için BUY önce)
    divergences.sort((a, b) => a.confirmIndex - b.confirmIndex || (a.type === b.type ? 0 : a.type === 'BUY' ? -1 : 1));
    return { divergences, pivotLows, pivotHighs };
  }

  const Divergence = { findPivots, rsiExtreme, detect };

  if (typeof module === 'object' && module.exports) module.exports = Divergence;
  root.Divergence = Divergence;
})(typeof globalThis !== 'undefined' ? globalThis : this);
