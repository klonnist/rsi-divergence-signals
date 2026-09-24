'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Strategy = require('../js/signals.js');
const Ind = require('../js/indicators.js');
const { randomCandles, bar } = require('./helpers.js');

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg || ''} beklenen ${b}, gelen ${a}`);

const CANDLES = randomCandles(3000, 11);

test('Rastgele seride sinyal üretilir ve seviyeler kurala uyar', () => {
  const res = Strategy.run(CANDLES, {});
  const sigs = res.signals.filter((s) => !s.pending);
  assert.ok(sigs.length >= 10, `yeterli sinyal yok: ${sigs.length}`);
  const atr = Ind.atr(
    CANDLES.map((c) => c.high),
    CANDLES.map((c) => c.low),
    CANDLES.map((c) => c.close),
    14
  );
  for (const s of sigs) {
    assert.equal(s.confirmIndex, s.i2 + 5, 'onay = ikinci pivot + sağ uzunluk');
    assert.equal(s.entryIndex, s.confirmIndex + 1, 'giriş onaydan sonraki mum');
    assert.equal(s.entry, CANDLES[s.entryIndex].open, 'giriş = sonraki mumun açılışı');
    near(s.atr, atr[s.confirmIndex], 1e-12, 'ATR onay mumundan');
    const buy = s.type === 'BUY';
    if (buy) {
      near(s.sl, CANDLES[s.i2].low - 0.5 * s.atr, 1e-9, 'BUY SL');
      assert.ok(s.price2 < s.price1 && s.rsi2 > s.rsi1 && s.rsi2 < 40, 'BUY koşulları');
    } else {
      near(s.sl, CANDLES[s.i2].high + 0.5 * s.atr, 1e-9, 'SELL SL');
      assert.ok(s.price2 > s.price1 && s.rsi2 < s.rsi1 && s.rsi2 > 60, 'SELL koşulları');
    }
    if (s.valid) {
      const risk = buy ? s.entry - s.sl : s.sl - s.entry;
      near(s.risk, risk, 1e-9);
      near(s.tp1, s.entry + (buy ? 1 : -1) * 1.5 * risk, 1e-9, 'TP1 = 1.5R');
      near(s.tp2, s.entry + (buy ? 1 : -1) * 3 * risk, 1e-9, 'TP2 = 3R');
    }
    assert.ok(s.score >= 0 && s.score <= 100, 'skor 0–100');
    assert.ok(s.i2 - s.i1 >= 5 && s.i2 - s.i1 <= 60, 'pivot mesafesi');
  }
  assert.ok(sigs.some((s) => s.type === 'BUY') && sigs.some((s) => s.type === 'SELL'), 'iki yön de görülmeli');
});

test('LOOKAHEAD YOK: kısaltılmış veride üretilen sinyaller tam veridekilerle aynı', () => {
  const key = (s) => [s.type, s.kind, s.i1, s.i2, s.confirmIndex, s.sl.toFixed(10), s.score].join('|');
  for (const params of [{}, { useHidden: true, useEmaFilter: true }]) {
    const full = Strategy.run(CANDLES, params).signals;
    for (let k = 250; k <= CANDLES.length; k += 97) {
      const part = Strategy.run(CANDLES.slice(0, k), params).signals;
      const expected = full.filter((s) => s.confirmIndex < k);
      assert.deepEqual(part.map(key), expected.map(key), `k=${k}`);
      for (const s of part) {
        if (s.entryIndex < k) assert.equal(s.entry, CANDLES[s.entryIndex].open);
        else assert.ok(s.pending && s.entry === null, 'giriş mumu yoksa sinyal beklemede olmalı');
      }
    }
  }
});

test('EMA filtresi: BUY yalnızca kapanış > EMA, SELL yalnızca kapanış < EMA', () => {
  const res = Strategy.run(CANDLES, { useEmaFilter: true, useHidden: true });
  assert.ok(res.signals.length > 0);
  for (const s of res.signals) {
    const c = CANDLES[s.confirmIndex].close;
    if (s.type === 'BUY') assert.ok(c > res.ema[s.confirmIndex]);
    else assert.ok(c < res.ema[s.confirmIndex]);
  }
  const all = Strategy.run(CANDLES, { useHidden: true }).signals.length;
  assert.ok(res.signals.length < all, 'filtre sinyal sayısını azaltmalı');
});

test('Gizli uyumsuzluklar açılınca sinyal sayısı artar', () => {
  const off = Strategy.run(CANDLES, {}).signals;
  const on = Strategy.run(CANDLES, { useHidden: true }).signals;
  assert.ok(off.every((s) => s.kind === 'regular'));
  assert.ok(on.some((s) => s.kind === 'hidden'));
  assert.ok(on.length > off.length);
});

// ---------------------------------------------------------------- çıkış kuralları

const buyPos = () => Strategy.newPosition(true, 100, 95, 107.5, 115);
const sellPos = () => Strategy.newPosition(false, 100, 105, 92.5, 85);

test('Aynı mumda hem SL hem TP görülürse SL kabul edilir', () => {
  const p = buyPos();
  const f = Strategy.stepExit(p, bar(0, 100, 120, 90, 110), 'partial');
  assert.deepEqual(f, [{ price: 95, fraction: 1, reason: 'SL' }]);
  assert.equal(p.remaining, 0);
  const s = sellPos();
  assert.equal(Strategy.stepExit(s, bar(0, 100, 106, 80, 90), 'tp2')[0].reason, 'SL');
});

test('Kısmi mod: TP1’de yarısı kapanır, stop girişe çekilir, sonra başa baş', () => {
  const p = buyPos();
  let f = Strategy.stepExit(p, bar(0, 100, 108, 99, 106), 'partial');
  assert.deepEqual(f, [{ price: 107.5, fraction: 0.5, reason: 'TP1' }]);
  assert.equal(p.stop, 100);
  assert.equal(p.remaining, 0.5);
  f = Strategy.stepExit(p, bar(1, 106, 107, 99.5, 101), 'partial');
  assert.deepEqual(f, [{ price: 100, fraction: 0.5, reason: 'BE' }]);
});

test('Kısmi mod: aynı mumda TP1 ve TP2', () => {
  const p = buyPos();
  const f = Strategy.stepExit(p, bar(0, 100, 116, 99, 115), 'partial');
  assert.deepEqual(f.map((x) => x.reason), ['TP1', 'TP2']);
  assert.deepEqual(f.map((x) => x.price), [107.5, 115]);
});

test('Kısmi mod: TP1 mumunda kapanış girişin altındaysa başa baş aynı mumda', () => {
  const p = buyPos();
  const f = Strategy.stepExit(p, bar(0, 100, 108, 98, 99), 'partial');
  assert.deepEqual(f.map((x) => x.reason), ['TP1', 'BE']);
});

test('Gap: mum stop seviyesinin altında açılırsa açılıştan çıkılır', () => {
  const p = buyPos();
  const f = Strategy.stepExit(p, bar(0, 93, 94, 92, 93), 'partial');
  assert.equal(f[0].price, 93);
  const s = sellPos();
  assert.equal(Strategy.stepExit(s, bar(0, 107, 108, 106, 107), 'partial')[0].price, 107);
});

test('tp1 / tp2 modları pozisyonun tamamını kapatır', () => {
  const a = buyPos();
  assert.deepEqual(Strategy.stepExit(a, bar(0, 100, 108, 99, 106), 'tp1'), [{ price: 107.5, fraction: 1, reason: 'TP1' }]);
  const b = buyPos();
  assert.deepEqual(Strategy.stepExit(b, bar(0, 100, 108, 99, 106), 'tp2'), []);
  assert.deepEqual(Strategy.stepExit(b, bar(1, 106, 116, 105, 114), 'tp2'), [{ price: 115, fraction: 1, reason: 'TP2' }]);
  const s = sellPos();
  assert.deepEqual(Strategy.stepExit(s, bar(0, 100, 101, 92, 93), 'tp1'), [{ price: 92.5, fraction: 1, reason: 'TP1' }]);
});

test('evaluate: sinyal durumu ve gerçekleşen R', () => {
  const sig = Strategy.setEntry({ type: 'BUY', sl: 95 }, 100, {});
  assert.equal(Strategy.evaluate(sig, [], 'partial').status, 'PENDING');
  assert.equal(Strategy.evaluate(sig, [bar(0, 100, 101, 99, 100)], 'partial').status, 'OPEN');
  const tp1 = Strategy.evaluate(sig, [bar(0, 100, 108, 99, 106)], 'partial');
  assert.equal(tp1.status, 'TP1_OPEN');
  near(tp1.r, 0.75, 1e-12, 'yarım pozisyon × 1.5R');
  const win = Strategy.evaluate(sig, [bar(0, 100, 108, 99, 106), bar(1, 106, 116, 105, 114)], 'partial');
  assert.equal(win.status, 'TP2');
  near(win.r, 2.25, 1e-12, '0.5×1.5R + 0.5×3R');
  const loss = Strategy.evaluate(sig, [bar(0, 100, 101, 94, 96)], 'partial');
  assert.equal(loss.status, 'SL');
  near(loss.r, -1, 1e-12);
});
