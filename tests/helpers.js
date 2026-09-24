'use strict';
// Testler için yardımcılar (test dosyası değildir).

/** Tekrarlanabilir sözde rastgele sayı üreteci. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Rastgele yürüyüşle mum dizisi (15 dakikalık). */
function randomCandles(n, seed = 42, start = 1700000000000) {
  const rnd = mulberry32(seed);
  const out = [];
  let price = 100;
  let drift = 0;
  for (let i = 0; i < n; i++) {
    if (i % 150 === 0) drift = (rnd() - 0.5) * 0.4; // ara sıra trend değişimi
    const open = price;
    const close = Math.max(1, open * (1 + ((rnd() - 0.5) * 2.4 + drift) / 100));
    const high = Math.max(open, close) * (1 + rnd() * 0.006);
    const low = Math.min(open, close) * (1 - rnd() * 0.006);
    out.push({ time: start + i * 900000, open, high, low, close, volume: 1 });
    price = close;
  }
  return out;
}

/** Basit mum oluşturucu: {t, o, h, l, c} kısaltmaları. */
function bar(i, o, h, l, c, start = 1700000000000) {
  return { time: start + i * 900000, open: o, high: h, low: l, close: c, volume: 1 };
}

module.exports = { mulberry32, randomCandles, bar };
