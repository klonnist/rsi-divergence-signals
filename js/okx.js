/**
 * okx.js — OKX Public API istemcisi (API anahtarı gerekmez).
 *
 *  - Hız sınırı: uç nokta grubu başına istekler arasında en az RATE_LIMIT_MS bekler.
 *  - Hata olursa üstel bekleme ile yeniden dener (ağ, zaman aşımı, 429, 5xx, OKX 5xxxx).
 *  - OKX mumları YENİDEN ESKİYE döndürür; burada hep ESKİDEN YENİYE sıralanır.
 *  - Kapanmamış mum (confirm = 0) sinyal hesabına katılmaz, ayrıca `live` olarak döner.
 *  - Veri kaynağı: 'direct' (OKX), 'static' (data/*.json) veya 'auto'.
 *
 * Tarayıcıda window.OKX, Node'da require('./js/okx.js') olarak kullanılır
 * (GitHub Actions veri betiği de bu dosyayı kullanır).
 */
(function (root) {
  'use strict';

  const CONFIG = root.CONFIG || (typeof require === 'function' ? require('./config.js') : {});

  // ------------------------------------------------------------------ hatalar
  class OkxError extends Error {
    constructor(message, info) {
      super(message);
      info = info || {};
      this.name = 'OkxError';
      this.code = info.code || null; // OKX hata kodu (ör. '51001')
      this.status = info.status || null; // HTTP durum kodu
      this.retryable = !!info.retryable;
      this.network = !!info.network; // ağ / CORS kaynaklı
    }
  }

  // Yeniden denenebilir OKX kodları: servis meşgul, zaman aşımı, istek limiti vb.
  const RETRYABLE_CODES = new Set(['50001', '50004', '50011', '50013', '50026', '50061']);

  function abortError() {
    const e = new Error('İşlem iptal edildi');
    e.name = 'AbortError';
    return e;
  }

  function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
      if (signal && signal.aborted) return reject(abortError());
      const onAbort = () => {
        clearTimeout(timer);
        reject(abortError());
      };
      const timer = setTimeout(() => {
        if (signal) signal.removeEventListener('abort', onAbort);
        resolve();
      }, Math.max(0, ms));
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  // ------------------------------------------------------------------ durum olayları
  // Arayüz, yeniden deneme / kaynak değişimi mesajlarını buradan dinler.
  const listeners = new Set();
  function onStatus(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }
  function emit(ev) {
    listeners.forEach((fn) => {
      try {
        fn(ev);
      } catch (_) {
        /* dinleyici hatası akışı bozmasın */
      }
    });
  }

  // ------------------------------------------------------------------ hız sınırlayıcı
  // Her "şerit" için bir sonraki boş zaman dilimi tutulur; istekler bu
  // dilimlere sırayla yerleşir. Böylece çok sayıda paralel istek bile OKX
  // limitini aşmadan eşit aralıklarla gönderilir.
  const nextSlot = {};
  function reserveSlot(lane) {
    const gap = (CONFIG.RATE_LIMIT_MS && CONFIG.RATE_LIMIT_MS[lane]) || 110;
    const now = Date.now();
    const at = Math.max(now, nextSlot[lane] || 0);
    nextSlot[lane] = at + gap;
    return at - now;
  }

  // ------------------------------------------------------------------ HTTP
  async function fetchJson(url, signal) {
    const ctrl = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ctrl.abort();
    }, CONFIG.REQUEST_TIMEOUT_MS || 15000);
    const onAbort = () => ctrl.abort();
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    try {
      let res;
      try {
        res = await fetch(url, { signal: ctrl.signal });
      } catch (_) {
        if (signal && signal.aborted) throw abortError();
        if (timedOut) throw new OkxError('İstek zaman aşımına uğradı', { retryable: true, network: true });
        throw new OkxError('Sunucuya ulaşılamadı (internet bağlantısı veya CORS engeli)', { retryable: true, network: true });
      }
      if (res.status === 429) throw new OkxError('İstek limiti aşıldı (HTTP 429)', { status: 429, retryable: true });
      if (res.status >= 500) throw new OkxError('Sunucu hatası (HTTP ' + res.status + ')', { status: res.status, retryable: true });
      if (res.status === 403) throw new OkxError('Erişim reddedildi (HTTP 403) — bölgesel kısıtlama olabilir', { status: 403 });
      if (res.status === 404) throw new OkxError('Bulunamadı (HTTP 404)', { status: 404 });
      if (!res.ok) throw new OkxError('Beklenmeyen yanıt (HTTP ' + res.status + ')', { status: res.status });
      try {
        return await res.json();
      } catch (_) {
        if (signal && signal.aborted) throw abortError();
        throw new OkxError('Yanıt okunamadı (geçersiz JSON)', { retryable: true });
      }
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  }

  async function withRetry(label, fn, signal) {
    const max = CONFIG.MAX_RETRIES != null ? CONFIG.MAX_RETRIES : 4;
    for (let attempt = 0; ; attempt++) {
      try {
        const out = await fn();
        if (attempt > 0) emit({ type: 'recovered', label });
        return out;
      } catch (err) {
        if (err.name === 'AbortError' || !err.retryable || attempt >= max) throw err;
        const wait = Math.min(1000 * Math.pow(2, attempt), 10000) + Math.floor(Math.random() * 300);
        emit({ type: 'retry', label, attempt: attempt + 1, max, wait, error: err });
        await sleep(wait, signal);
      }
    }
  }

  /** OKX'e GET isteği; `data` alanını döndürür. */
  function okxGet(path, params, opts) {
    opts = opts || {};
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params || {})) if (v != null) qs.set(k, String(v));
    const url = (CONFIG.OKX_BASE_URL || 'https://www.okx.com') + path + (qs.toString() ? '?' + qs : '');
    return withRetry(
      path,
      async () => {
        await sleep(reserveSlot(opts.lane || 'other'), opts.signal);
        const json = await fetchJson(url, opts.signal);
        if (json && json.code === '0') return json.data || [];
        const code = json && json.code;
        throw new OkxError('OKX hatası ' + code + ': ' + ((json && json.msg) || 'bilinmeyen hata'), {
          code,
          retryable: RETRYABLE_CODES.has(code),
        });
      },
      opts.signal
    );
  }

  /** Yedek yöntem: GitHub Actions'ın ürettiği data/*.json dosyasını okur. */
  function staticGet(file, signal) {
    const base = CONFIG.STATIC_DATA_PATH || 'data';
    const url = base + '/' + file + '?v=' + Math.floor(Date.now() / 60000); // dakikalık önbellek kırıcı
    return withRetry(file, () => fetchJson(url, signal), signal).catch((err) => {
      if (err.status === 404) {
        throw new OkxError(
          'Yedek veri dosyası bulunamadı (' + file + '). fetch-data workflow’u en az bir kez çalışmış olmalı.',
          { status: 404 }
        );
      }
      throw err;
    });
  }

  // ------------------------------------------------------------------ veri kaynağı
  let source = null; // 'direct' | 'static'
  let fallbackReason = null;

  function configuredSource() {
    let s = CONFIG.DATA_SOURCE || 'direct';
    try {
      const q = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('source') : null;
      if (q === 'direct' || q === 'static' || q === 'auto') s = q;
    } catch (_) {
      /* Node ortamı */
    }
    return s;
  }

  /** Veri kaynağını belirler. 'auto' modunda tek bir deneme isteği atılır. */
  async function init() {
    const configured = configuredSource();
    fallbackReason = null;
    if (configured === 'auto') {
      try {
        const json = await fetchJson((CONFIG.OKX_BASE_URL || 'https://www.okx.com') + '/api/v5/public/time');
        source = json && json.code === '0' ? 'direct' : 'static';
        if (source === 'static') fallbackReason = 'OKX beklenmeyen yanıt verdi';
      } catch (err) {
        source = 'static';
        fallbackReason = err.message;
      }
    } else {
      source = configured === 'static' ? 'static' : 'direct';
    }
    emit({ type: 'source', source, configured, fallbackReason });
    return { source, configured, fallbackReason };
  }

  function getSource() {
    return source || (configuredSource() === 'static' ? 'static' : 'direct');
  }
  function setSource(s) {
    source = s === 'static' ? 'static' : 'direct';
  }

  // ------------------------------------------------------------------ mum yardımcıları
  const instId = (coin) => String(coin).toUpperCase() + '-' + (CONFIG.QUOTE || 'USDT');

  /**
   * OKX: [ts, o, h, l, c, vol, volCcy, volCcyQuote, confirm]
   * data/latest: [ts, o, h, l, c, vol, confirm(0/1)] — data/history: [ts, o, h, l, c, vol]
   */
  function parseCandle(a) {
    let confirmed = true;
    if (a.length >= 9) confirmed = String(a[8]) === '1';
    else if (a.length === 7) confirmed = String(a[6]) === '1';
    return { time: +a[0], open: +a[1], high: +a[2], low: +a[3], close: +a[4], volume: +a[5], confirmed };
  }

  /** Zaman damgasına göre tekilleştirir ve eskiden yeniye sıralar (aynı zamanda sonuncu kazanır). */
  function normalize(list) {
    const map = new Map();
    for (const c of list) map.set(c.time, c);
    return Array.from(map.values()).sort((a, b) => a.time - b.time);
  }

  /** Kapanmış mumları ve (varsa) kapanmamış canlı mumu ayırır. */
  function splitLive(list) {
    const candles = [];
    let live = null;
    for (const c of list) {
      if (c.confirmed) candles.push(c);
      else live = c;
    }
    return { candles, live };
  }

  /** Eski ve yeni kapanmış mumları birleştirir, en fazla `maxLen` tanesini tutar. */
  function mergeCandles(existing, incoming, maxLen) {
    const merged = normalize(existing.concat(incoming));
    return maxLen && merged.length > maxLen ? merged.slice(merged.length - maxLen) : merged;
  }

  // ------------------------------------------------------------------ enstrümanlar
  let instrumentsPromise = null;

  /** OKX spot enstrüman listesi → Map(instId → bilgi). */
  function getInstruments(opts) {
    opts = opts || {};
    if (!instrumentsPromise) {
      instrumentsPromise = (async () => {
        const list =
          getSource() === 'static'
            ? (await staticGet('instruments.json', opts.signal)).instruments || []
            : await okxGet('/api/v5/public/instruments', { instType: 'SPOT' }, { signal: opts.signal });
        const map = new Map();
        for (const it of list) {
          map.set(it.instId, {
            instId: it.instId,
            state: it.state,
            tickSz: it.tickSz,
            lotSz: it.lotSz,
            minSz: it.minSz,
            baseCcy: it.baseCcy,
            quoteCcy: it.quoteCcy,
          });
        }
        return map;
      })();
      instrumentsPromise.catch(() => {
        instrumentsPromise = null; // hata olursa sonraki çağrıda yeniden dene
      });
    }
    return instrumentsPromise;
  }

  /**
   * Config'deki her çiftin OKX'te listelendiğini ve işlem gördüğünü kontrol eder.
   * @returns {{listed:string[], missing:string[], inactive:{instId:string,state:string}[], instruments:Map}}
   */
  async function checkListings(coins, opts) {
    const map = await getInstruments(opts);
    const listed = [];
    const missing = [];
    const inactive = [];
    for (const coin of coins || CONFIG.COINS || []) {
      const id = instId(coin);
      const it = map.get(id);
      if (!it) missing.push(id);
      else if (it.state !== 'live') inactive.push({ instId: id, state: it.state });
      else listed.push(id);
    }
    return { listed, missing, inactive, instruments: map };
  }

  // ------------------------------------------------------------------ fiyatlar
  /** Tüm spot çiftlerin güncel fiyatı → Map(instId → {last, open24h, ts}). */
  async function getTickers(opts) {
    opts = opts || {};
    const map = new Map();
    if (getSource() === 'static') {
      const d = await staticGet('tickers.json', opts.signal);
      for (const [id, t] of Object.entries(d.tickers || {})) {
        if (t) map.set(id, { last: +t.last, open24h: +t.open24h, ts: +t.ts || d.updatedAt });
      }
      return map;
    }
    const data = await okxGet('/api/v5/market/tickers', { instType: 'SPOT' }, { signal: opts.signal });
    for (const t of data) map.set(t.instId, { last: +t.last, open24h: +t.open24h, ts: +t.ts });
    return map;
  }

  // ------------------------------------------------------------------ son mumlar (sinyal paneli)
  const staticLatest = new Map(); // tf.id → {at, promise}

  async function recentFromStatic(inst, tf, count) {
    let c = staticLatest.get(tf.id);
    if (!c || Date.now() - c.at > 30000) {
      c = { at: Date.now(), promise: staticGet('latest/' + tf.id + '.json') };
      staticLatest.set(tf.id, c);
      c.promise.catch(() => staticLatest.delete(tf.id));
    }
    const d = await c.promise;
    const rows = (d.series && d.series[inst]) || [];
    if (!rows.length) throw new OkxError('Yedek veride ' + inst + ' ' + tf.label + ' bulunamadı');
    const list = normalize(rows.map(parseCandle));
    return Object.assign(splitLive(list.slice(-count)), { updatedAt: d.updatedAt });
  }

  /**
   * Son `count` mum (canlı mum dahil). /market/candles istek başına en fazla
   * 300 mum döndürür; daha fazlası `after` imleciyle geriye sayfalanır.
   * @returns {{candles: object[], live: object|null}}  candles yalnızca kapanmış mumlar
   */
  async function getRecentCandles(inst, tf, count, opts) {
    opts = opts || {};
    if (getSource() === 'static') return recentFromStatic(inst, tf, count);
    const per = CONFIG.CANDLES_LIMIT || 300;
    const out = [];
    let after = null;
    while (out.length < count) {
      const limit = Math.min(per, count - out.length);
      const data = await okxGet(
        '/api/v5/market/candles',
        { instId: inst, bar: tf.okxBar, limit, after },
        { lane: 'candles', signal: opts.signal }
      );
      if (!data.length) break;
      for (const a of data) out.push(parseCandle(a));
      after = data[data.length - 1][0]; // en eski mumun zamanı → sonraki sayfa bundan eskiler
      if (data.length < limit) break;
    }
    return Object.assign(splitLive(normalize(out)), { updatedAt: Date.now() });
  }

  // ------------------------------------------------------------------ geçmiş (backtest)
  const historyCache = new Map(); // "inst|tf" → {from, to, candles}

  /** Aralık için gereken yaklaşık istek sayısı (ilerleme ve süre tahmini için). */
  function estimatePages(tf, startMs, endMs) {
    const bars = Math.max(0, (Math.min(endMs, Date.now()) - startMs) / tf.ms);
    return Math.max(1, Math.ceil(bars / (CONFIG.HISTORY_LIMIT || 100)));
  }

  /**
   * [startMs, endMs] aralığındaki KAPANMIŞ mumlar, eskiden yeniye.
   * /market/history-candles `after` imleciyle yeniden eskiye sayfalanır.
   * Sonuç bellekte önbelleğe alınır; aynı coin için yeni bir aralık
   * istendiğinde yalnızca eksik kısım çekilir.
   *
   * @param opts.onProgress ({inst, done, total}) → ilerleme çubuğu için
   * @param opts.signal     AbortSignal → iptal için
   */
  async function getHistory(inst, tf, startMs, endMs, opts) {
    opts = opts || {};
    const report = (done, total) => opts.onProgress && opts.onProgress({ inst, done, total: Math.max(done, total) });

    if (getSource() === 'static') {
      report(0, 1);
      const d = await staticGet('history/' + inst + '_' + tf.id + '.json', opts.signal);
      report(1, 1);
      const list = normalize((d.candles || []).map(parseCandle));
      const out = list.filter((c) => c.time >= startMs && c.time <= endMs);
      out.coverageFrom = list.length ? list[0].time : null;
      return out;
    }

    const now = Date.now();
    endMs = Math.min(endMs, now);
    const key = inst + '|' + tf.id;
    let entry = historyCache.get(key);
    // İstenen aralık önbellekle örtüşmüyorsa aradaki boşluğu çekmek yerine baştan başla
    if (entry && (endMs < entry.from - tf.ms || startMs > entry.to + tf.ms)) entry = null;
    const lastClosable = Math.min(endMs, now - tf.ms); // kapanmış olabilecek son mumun açılışı

    // Önbellekte olmayan aralıklar. Önce yeni uç (tail), sonra eski uç (head): her aralık
    // yeniden eskiye indirildiği için yarıda kesilen bir 'full'/'head' indirmesi de önbellekle
    // bitişik kalır ve kaydedilebilir.
    const ranges = [];
    if (!entry) ranges.push({ from: startMs, to: endMs, kind: 'full' });
    else {
      if (entry.to + tf.ms <= lastClosable) ranges.push({ from: entry.to + 1, to: endMs, kind: 'tail' });
      if (startMs < entry.from) ranges.push({ from: startMs, to: entry.from - 1, kind: 'head' });
    }

    const per = CONFIG.HISTORY_LIMIT || 100;
    const total = ranges.reduce((s, r) => s + estimatePages(tf, r.from, r.to), 0);
    let done = 0;
    report(done, total);

    // İndirilenleri önbelleğe işler. complete=false ise (iptal/hata) yalnızca bitişik kısım kaydedilir.
    const save = (list, r, complete, oldest) => {
      if (!complete && (r.kind === 'tail' || oldest == null)) return;
      const candles = normalize((entry ? entry.candles : []).concat(list.filter((c) => c.confirmed)));
      const newFrom = complete ? r.from : oldest;
      const lastTime = candles.length ? candles[candles.length - 1].time : r.from - 1;
      entry = {
        from: entry && r.kind === 'tail' ? entry.from : Math.min(entry ? entry.from : Infinity, newFrom),
        to: Math.max(entry ? entry.to : -Infinity, lastTime),
        candles,
      };
      historyCache.set(key, entry);
    };

    for (const r of ranges) {
      const got = [];
      let cursor = r.to + 1; // after=cursor → zaman damgası cursor'dan küçük mumlar
      let oldest = null;
      try {
        for (;;) {
          const data = await okxGet(
            '/api/v5/market/history-candles',
            { instId: inst, bar: tf.okxBar, after: cursor, limit: per },
            { lane: 'history', signal: opts.signal }
          );
          done++;
          report(done, total);
          if (!data.length) break;
          for (const a of data) got.push(parseCandle(a));
          const o = +data[data.length - 1][0];
          if (oldest == null || o < oldest) oldest = o;
          if (o <= r.from || o >= cursor) break;
          cursor = o;
        }
      } catch (err) {
        save(got, r, false, oldest); // iptal edilse de indirilen kısım boşa gitmesin
        throw err;
      }
      save(got, r, true, oldest);
    }

    report(total, total);
    const all = entry ? entry.candles : [];
    return all.filter((c) => c.time >= startMs && c.time <= endMs);
  }

  const OKX = {
    OkxError,
    init,
    getSource,
    setSource,
    onStatus,
    instId,
    parseCandle,
    normalize,
    splitLive,
    mergeCandles,
    getInstruments,
    checkListings,
    getTickers,
    getRecentCandles,
    getHistory,
    estimatePages,
    sleep,
  };

  if (typeof module === 'object' && module.exports) module.exports = OKX;
  root.OKX = OKX;
})(typeof globalThis !== 'undefined' ? globalThis : this);
