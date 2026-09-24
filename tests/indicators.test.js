'use strict';
// Çalıştırma: npm test  (veya: node --test)
const test = require('node:test');
const assert = require('node:assert/strict');
const Ind = require('../js/indicators.js');

const near = (actual, expected, tol, msg) =>
  assert.ok(Math.abs(actual - expected) <= tol, `${msg || ''} beklenen ${expected}, gelen ${actual} (±${tol})`);

// StockCharts ChartSchool "RSI" örnek tablosu (14 periyot, Wilder)
const CLOSES = [
  44.3389, 44.0902, 44.1497, 43.6124, 44.3278, 44.8264, 45.0955, 45.4245, 45.8433, 46.0826, 45.8931, 46.0328, 45.614,
  46.282, 46.282, 46.0028, 46.0328, 46.4116, 46.2222, 45.6439, 46.2122, 46.2521, 45.7137, 46.4515, 45.7835, 45.3548,
  44.0288, 44.1783, 44.2181, 44.5672, 43.4205, 42.6628, 43.1314,
];
const RSI_EXPECTED = [
  70.53, 66.32, 66.55, 69.41, 66.36, 57.97, 62.93, 63.26, 56.06, 62.38, 54.71, 50.42, 39.99, 41.46, 41.87, 45.46, 37.3,
  33.08, 37.77,
];

test('RSI (Wilder) referans tablo değerleriyle eşleşir', () => {
  const r = Ind.rsi(CLOSES, 14);
  assert.equal(r.length, CLOSES.length);
  for (let i = 0; i < 14; i++) assert.equal(r[i], null, `ısınma indeksi ${i} null olmalı`);
  RSI_EXPECTED.forEach((v, k) => near(r[14 + k], v, 0.01, `RSI[${14 + k}]`));
});

test('RSI uç durumlar: sürekli yükseliş 100, sürekli düşüş 0, yatay 50', () => {
  const up = Array.from({ length: 30 }, (_, i) => 100 + i);
  const down = Array.from({ length: 30 }, (_, i) => 100 - i);
  const flat = Array.from({ length: 30 }, () => 100);
  assert.equal(Ind.rsi(up, 14)[29], 100);
  assert.equal(Ind.rsi(down, 14)[29], 0);
  assert.equal(Ind.rsi(flat, 14)[29], 50);
});

test('RSI yetersiz veride tamamen null döner', () => {
  assert.deepEqual(Ind.rsi([1, 2, 3], 14), [null, null, null]);
  assert.deepEqual(Ind.rsi([], 14), []);
});

test('RSI geleceğe bakmaz: son değer eklemek önceki değerleri değiştirmez', () => {
  const a = Ind.rsi(CLOSES.slice(0, 25), 14);
  const b = Ind.rsi(CLOSES, 14);
  for (let i = 0; i < 25; i++) assert.equal(a[i], b[i]);
});

test('SMA', () => {
  assert.deepEqual(Ind.sma([1, 2, 3, 4, 5], 3), [null, null, 2, 3, 4]);
});

test('EMA ilk değeri SMA ile tohumlar', () => {
  assert.deepEqual(Ind.ema([1, 2, 3, 4, 5], 3), [null, null, 2, 3, 4]);
  const e = Ind.ema([2, 4, 6, 8, 10, 12], 2);
  [null, 3, 5, 7, 9, 11].forEach((v, i) => (v === null ? assert.equal(e[i], null) : near(e[i], v, 1e-9, `EMA[${i}]`)));
  assert.deepEqual(Ind.ema([1, 2], 3), [null, null]);
});

test('True range önceki kapanışı hesaba katar (gap)', () => {
  const tr = Ind.trueRange([10, 15], [8, 14], [9, 14.5]);
  assert.equal(tr[0], 2); // ilk mum: H − L
  assert.equal(tr[1], 6); // max(15−14, |15−9|, |14−9|) = 6
});

test('ATR Wilder yumuşatması', () => {
  // TR = [2, 3, 2, 3] → ATR(3): (2+3+2)/3, sonra (önceki×2 + 3)/3
  const a = Ind.atr([10, 12, 11, 13], [8, 9, 9, 10], [9, 11, 10, 12], 3);
  assert.equal(a[0], null);
  assert.equal(a[1], null);
  near(a[2], 7 / 3, 1e-12, 'ATR[2]');
  near(a[3], 23 / 9, 1e-12, 'ATR[3]');
});

test('Sabit aralıklı mumlarda ATR aralığa eşittir', () => {
  const n = 40;
  const a = Ind.atr(Array(n).fill(11), Array(n).fill(9), Array(n).fill(10), 14);
  for (let i = 13; i < n; i++) near(a[i], 2, 1e-12, `ATR[${i}]`);
});
