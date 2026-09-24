'use strict';
// OKX istemcisi — ağ yerine sahte (mock) fetch ile
const test = require('node:test');
const assert = require('node:assert/strict');
const CONFIG = require('../js/config.js');
const OKX = require('../js/okx.js');

CONFIG.RATE_LIMIT_MS = { candles: 0, history: 0, other: 0 }; // testte bekleme yok
OKX.setSource('direct');

const TF = { id: '15m', label: '15m', okxBar: '15m', ms: 900000 };
const LISTING = Date.UTC(2024, 0, 1); // bu tarihten önce veri yok
const LATEST = Date.UTC(2024, 5, 1); // /market/candles için "şu anki" (kapanmamış) mum
const okxRow = (t, confirm = '1') => [String(t), '100', '101', '99', '100.5', '10', '1000', '1000', confirm];
const abortError = () => Object.assign(new Error('aborted'), { name: 'AbortError' });

/** OKX gibi davranan sahte fetch: after'dan eski mumlar, yeniden eskiye, limit kadar. */
function mockFetch(opts = {}) {
  const calls = [];
  global.fetch = async (url) => {
    const u = new URL(url);
    calls.push(u.pathname);
    if (opts.onCall) {
      const r = opts.onCall(calls.length, u);
      if (r) return r;
    }
    const limit = Number(u.searchParams.get('limit') || 100);
    const after = u.searchParams.get('after');
    const data = [];
    if (u.pathname.endsWith('/history-candles')) {
      let t = Math.floor((Number(after) - 1) / TF.ms) * TF.ms;
      while (data.length < limit && t >= LISTING) {
        data.push(okxRow(t));
        t -= TF.ms;
      }
    } else if (u.pathname.endsWith('/market/candles')) {
      let t = after ? Number(after) - TF.ms : LATEST;
      while (data.length < limit && t >= LISTING) {
        data.push(okxRow(t, t === LATEST ? '0' : '1'));
        t -= TF.ms;
      }
    }
    return { status: 200, ok: true, json: async () => ({ code: '0', msg: '', data }) };
  };
  return calls;
}

const START = Date.UTC(2024, 1, 1);
const END = Date.UTC(2024, 1, 11) - 1; // 10 gün = 960 adet 15m mum

test('getHistory aralığı sayfalayarak eksiksiz, sıralı ve tekil döndürür', async () => {
  const calls = mockFetch();
  const list = await OKX.getHistory('AAA-USDT', TF, START, END);
  assert.equal(list.length, 960);
  assert.equal(list[0].time, START);
  assert.equal(list[list.length - 1].time, END + 1 - TF.ms);
  for (let i = 1; i < list.length; i++) assert.equal(list[i].time - list[i - 1].time, TF.ms);
  assert.ok(calls.length >= 10 && calls.length <= 11, `istek sayısı ${calls.length}`);
});

test('Aynı aralık tekrar istenince ağa gidilmez; bitiş uzayınca yalnızca yeni kısım çekilir', async () => {
  let calls = mockFetch();
  await OKX.getHistory('BBB-USDT', TF, START, END);
  calls = mockFetch();
  const again = await OKX.getHistory('BBB-USDT', TF, START, END);
  assert.equal(calls.length, 0);
  assert.equal(again.length, 960);
  calls = mockFetch();
  const longer = await OKX.getHistory('BBB-USDT', TF, START, END + 86400000); // +1 gün = 96 mum
  assert.equal(longer.length, 960 + 96);
  assert.ok(calls.length <= 2, `yalnızca kuyruk çekilmeli, istek: ${calls.length}`);
});

test('İptal edilen indirmenin kısmı önbellekte kalır, tekrar çalıştırınca kaldığı yerden devam eder', async () => {
  const ctrl = new AbortController();
  mockFetch({
    onCall(n) {
      if (n === 4) {
        ctrl.abort();
        throw abortError();
      }
    },
  });
  await assert.rejects(OKX.getHistory('CCC-USDT', TF, START, END, { signal: ctrl.signal }), { name: 'AbortError' });
  const calls = mockFetch();
  const list = await OKX.getHistory('CCC-USDT', TF, START, END);
  assert.equal(list.length, 960);
  assert.ok(calls.length <= 8, `yalnızca eksik ~7 sayfa çekilmeli, istek: ${calls.length}`);
});

test('Listeleme tarihinden önceki aralık boş döner, sonrası eksiksiz gelir', async () => {
  mockFetch();
  const s = LISTING - 5 * 86400000;
  const list = await OKX.getHistory('DDD-USDT', TF, s, LISTING + 86400000 - 1);
  assert.equal(list.length, 96);
  assert.equal(list[0].time, LISTING);
});

test('getRecentCandles sayfalar, eskiden yeniye sıralar ve kapanmamış mumu ayırır', async () => {
  const calls = mockFetch();
  const { candles, live } = await OKX.getRecentCandles('EEE-USDT', TF, 600);
  assert.equal(calls.length, 2, '300 + 300');
  assert.equal(candles.length, 599);
  assert.ok(candles.every((c) => c.confirmed));
  assert.equal(live.time, LATEST);
  assert.equal(live.confirmed, false);
  assert.equal(candles[candles.length - 1].time, LATEST - TF.ms);
  for (let i = 1; i < candles.length; i++) assert.ok(candles[i].time > candles[i - 1].time);
});

test('HTTP 429 sonrası yeniden denenir ve durum olayı yayınlanır', async () => {
  const events = [];
  const off = OKX.onStatus((e) => events.push(e.type));
  mockFetch({
    onCall(n) {
      if (n === 1) return { status: 429, ok: false, json: async () => ({}) };
    },
  });
  const { candles } = await OKX.getRecentCandles('FFF-USDT', TF, 10);
  off();
  assert.equal(candles.length, 9);
  assert.deepEqual(events, ['retry', 'recovered']);
});

test('Olmayan enstrüman (51001) yeniden denenmeden anlaşılır hatayla döner', async () => {
  const calls = mockFetch({
    onCall() {
      return { status: 200, ok: true, json: async () => ({ code: '51001', msg: "Instrument ID doesn't exist.", data: [] }) };
    },
  });
  await assert.rejects(OKX.getRecentCandles('XXX-USDT', TF, 10), (err) => err.code === '51001' && /51001/.test(err.message));
  assert.equal(calls.length, 1);
});

test('parseCandle OKX ve yedek veri biçimlerini okur', () => {
  assert.equal(OKX.parseCandle(okxRow(1, '0')).confirmed, false);
  assert.equal(OKX.parseCandle(okxRow(1, '1')).confirmed, true);
  assert.equal(OKX.parseCandle([1, 2, 3, 1, 2, 5, 0]).confirmed, false); // data/latest
  assert.equal(OKX.parseCandle([1, 2, 3, 1, 2, 5]).confirmed, true); // data/history
  assert.deepEqual(
    OKX.mergeCandles([{ time: 1, close: 1 }, { time: 2, close: 2 }], [{ time: 2, close: 9 }, { time: 3, close: 3 }], 2),
    [{ time: 2, close: 9 }, { time: 3, close: 3 }]
  );
});
