'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Div = require('../js/divergence.js');
const { mulberry32 } = require('./helpers.js');

/**
 * Düz bir seri üzerine V şeklinde dipler (sign = -1) veya tepeler (sign = +1) çizer.
 * points: [[indeks, değer], ...]
 */
function shaped(n, base, points, sign, step = 2) {
  const a = new Array(n).fill(base);
  for (const [idx, v] of points) {
    for (let k = -4; k <= 4; k++) {
      const j = idx + k;
      if (j < 0 || j >= n) continue;
      const val = v - sign * Math.abs(k) * step;
      a[j] = sign < 0 ? Math.min(a[j], val) : Math.max(a[j], val);
    }
  }
  return a;
}

/** İki dip içeren fiyat serisi ve verilen RSI değerleri. */
function bullFixture({ n = 60, i1 = 15, i2 = 30, p1 = 100, p2 = 95, r1 = 30, r2 = 35 } = {}) {
  const low = shaped(n, 120, [[i1, p1], [i2, p2]], -1);
  const high = low.map((v) => v + 5);
  const rsi = new Array(n).fill(50);
  rsi[i1] = r1;
  rsi[i2] = r2;
  return { low, high, rsi };
}

/** İki tepe içeren fiyat serisi ve verilen RSI değerleri. */
function bearFixture({ n = 60, i1 = 15, i2 = 30, p1 = 200, p2 = 205, r1 = 70, r2 = 65 } = {}) {
  const high = shaped(n, 180, [[i1, p1], [i2, p2]], +1);
  const low = high.map((v) => v - 5);
  const rsi = new Array(n).fill(50);
  rsi[i1] = r1;
  rsi[i2] = r2;
  return { low, high, rsi };
}

const OPTS = { pivotLeft: 5, pivotRight: 5, minBars: 5, maxBars: 60, bullRsiMax: 40, bearRsiMin: 60, useHidden: false };

// ---------------------------------------------------------------- pivotlar

test('findPivots dip ve tepeleri bulur, onay indeksi = indeks + sağ', () => {
  const v = [5, 4, 3, 4, 5, 6, 5, 4, 2, 3, 4, 5, 6];
  const lows = Div.findPivots(v, 2, 2, 'low');
  assert.deepEqual(lows.map((p) => p.index), [2, 8]);
  assert.deepEqual(lows.map((p) => p.confirmIndex), [4, 10]);
  assert.deepEqual(lows.map((p) => p.price), [3, 2]);
  const highs = Div.findPivots(v, 2, 2, 'high');
  assert.deepEqual(highs.map((p) => p.index), [5]); // 12. indeksin sağında yeterli mum yok
});

test('Eşit diplerde yalnızca ilki pivot sayılır', () => {
  assert.deepEqual(Div.findPivots([5, 4, 3, 3, 4, 5], 2, 2, 'low').map((p) => p.index), [2]);
  assert.deepEqual(Div.findPivots([1, 2, 3, 3, 2, 1], 2, 2, 'high').map((p) => p.index), [2]);
});

test('Lookahead yok: sağdaki mumlar kapanmadan pivot oluşmaz', () => {
  const v = [9, 8, 7, 6, 5, 4, 5];
  assert.equal(Div.findPivots(v, 2, 2, 'low').length, 0, 'sağda 1 mum varken pivot olmamalı');
  const p = Div.findPivots(v.concat([6]), 2, 2, 'low');
  assert.equal(p.length, 1);
  assert.equal(p[0].index, 5);
  assert.equal(p[0].confirmIndex, 7);
});

test('Pivotlar veri uzadıkça değişmez (önek kararlılığı)', () => {
  const rnd = mulberry32(7);
  const v = [];
  let x = 100;
  for (let i = 0; i < 400; i++) v.push((x += rnd() - 0.5));
  for (const type of ['low', 'high']) {
    const full = Div.findPivots(v, 5, 5, type);
    for (let k = 20; k <= v.length; k += 13) {
      const prefix = Div.findPivots(v.slice(0, k), 5, 5, type);
      assert.deepEqual(prefix, full.filter((p) => p.confirmIndex < k), `${type} k=${k}`);
    }
  }
});

// ---------------------------------------------------------------- uyumsuzluklar

test('Pozitif (bullish) normal uyumsuzluk: fiyat düşük dip, RSI yüksek dip, RSI2 < 40', () => {
  const { divergences } = Div.detect(bullFixture(), OPTS);
  assert.equal(divergences.length, 1);
  const d = divergences[0];
  assert.equal(d.type, 'BUY');
  assert.equal(d.kind, 'regular');
  assert.equal(d.i1, 15);
  assert.equal(d.i2, 30);
  assert.equal(d.confirmIndex, 35);
  assert.equal(d.price2, 95);
  assert.equal(d.rsi2, 35);
});

test('İkinci dipte RSI ≥ 40 ise BUY üretilmez', () => {
  assert.equal(Div.detect(bullFixture({ r2: 45 }), OPTS).divergences.length, 0);
  assert.equal(Div.detect(bullFixture({ r2: 40 }), OPTS).divergences.length, 0);
});

test('RSI da daha düşük dip yaptıysa uyumsuzluk yoktur', () => {
  assert.equal(Div.detect(bullFixture({ r1: 35, r2: 30 }), OPTS).divergences.length, 0);
});

test('Pivotlar arası mesafe 5–60 mum aralığında olmalı', () => {
  assert.equal(Div.detect(bullFixture({ n: 110, i1: 15, i2: 90 }), OPTS).divergences.length, 0, '75 mum > 60');
  assert.equal(Div.detect(bullFixture({ n: 110, i1: 15, i2: 75 }), OPTS).divergences.length, 1, '60 mum sınırda');
  assert.equal(
    Div.detect(bullFixture(), Object.assign({}, OPTS, { minBars: 20 })).divergences.length,
    0,
    '15 mum < minBars 20'
  );
});

test('Gizli pozitif uyumsuzluk yalnızca açıkken üretilir', () => {
  const fx = bullFixture({ p2: 105, r1: 35, r2: 28 }); // fiyat yüksek dip, RSI düşük dip
  assert.equal(Div.detect(fx, OPTS).divergences.length, 0);
  const on = Div.detect(fx, Object.assign({}, OPTS, { useHidden: true })).divergences;
  assert.equal(on.length, 1);
  assert.equal(on[0].type, 'BUY');
  assert.equal(on[0].kind, 'hidden');
});

test('Negatif (bearish) normal uyumsuzluk: fiyat yüksek tepe, RSI düşük tepe, RSI2 > 60', () => {
  const { divergences } = Div.detect(bearFixture(), OPTS);
  assert.equal(divergences.length, 1);
  assert.equal(divergences[0].type, 'SELL');
  assert.equal(divergences[0].kind, 'regular');
  assert.equal(divergences[0].confirmIndex, 35);
  assert.equal(Div.detect(bearFixture({ r2: 55 }), OPTS).divergences.length, 0, 'RSI2 ≤ 60 ise SELL yok');
});

test('Gizli negatif uyumsuzluk: fiyat düşük tepe, RSI yüksek tepe', () => {
  const fx = bearFixture({ p2: 195, r1: 62, r2: 72 });
  assert.equal(Div.detect(fx, OPTS).divergences.length, 0);
  const on = Div.detect(fx, Object.assign({}, OPTS, { useHidden: true })).divergences;
  assert.equal(on.length, 1);
  assert.equal(on[0].type, 'SELL');
  assert.equal(on[0].kind, 'hidden');
});

test('RSI henüz hesaplanmamışsa (null) uyumsuzluk aranmaz', () => {
  const fx = bullFixture();
  fx.rsi[15] = null;
  assert.equal(Div.detect(fx, OPTS).divergences.length, 0);
});

test('Uyumsuzluk, ikinci pivotun sağındaki mumlar kapanmadan oluşmaz', () => {
  const fx = bullFixture();
  const cut = (k) => ({ low: fx.low.slice(0, k), high: fx.high.slice(0, k), rsi: fx.rsi.slice(0, k) });
  assert.equal(Div.detect(cut(35), OPTS).divergences.length, 0, 'onay mumu (35) yokken');
  assert.equal(Div.detect(cut(36), OPTS).divergences.length, 1, 'onay mumu kapandığında');
});
