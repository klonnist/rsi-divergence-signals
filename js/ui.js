/**
 * ui.js — Arayüz katmanı.
 *   index.html    → Sinyal paneli: tablo, filtreler, otomatik yenileme, grafik penceresi
 *   backtest.html → Backtest: form, ilerleme çubuğu, metrikler, grafikler, işlem tablosu, CSV
 *
 * Strateji (signals.js) ve backtest (backtest.js) saf fonksiyonlardır. Bu dosya
 * veriyi okx.js ile çeker, o fonksiyonları çağırır ve sonuçları çizer.
 */
(function () {
  'use strict';

  const CONFIG = window.CONFIG;
  const OKX = window.OKX;
  const Strategy = window.Strategy;
  const TFS = CONFIG.TIMEFRAMES;
  const TF = Object.fromEntries(TFS.map((t) => [t.id, t]));
  const DAY = 86400000;

  // Grafik renkleri — css/style.css'deki tokenlarla aynı
  const C = {
    surface: '#121822',
    grid: '#1c2430',
    text: '#e8ebf1',
    muted: '#8f99aa',
    accent: '#3987e5',
    buy: '#26a69a',
    sell: '#ef5350',
    rsi: '#9085e9',
    ema: '#c98500',
    good: '#0ca30c',
    warn: '#fab219',
    bad: '#d03b3b',
  };

  // =====================================================================
  // YARDIMCILAR
  // =====================================================================

  /** Küçük DOM oluşturucu: h('div', {class: 'x'}, 'metin', çocuk...) — metinler her zaman textContent olarak eklenir. */
  function h(tag, props, ...children) {
    const el = document.createElement(tag);
    if (props) {
      for (const [k, v] of Object.entries(props)) {
        if (v == null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
        else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
        else el.setAttribute(k, v === true ? '' : String(v));
      }
    }
    for (const c of children.flat(Infinity)) {
      if (c == null || c === false) continue;
      el.append(c instanceof Node ? c : String(c));
    }
    return el;
  }

  const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
  const nfCache = new Map();
  function nf(dec) {
    let f = nfCache.get(dec);
    if (!f) {
      f = new Intl.NumberFormat('tr-TR', { minimumFractionDigits: dec, maximumFractionDigits: dec });
      nfCache.set(dec, f);
    }
    return f;
  }
  const plainNf = new Intl.NumberFormat('tr-TR', { maximumFractionDigits: 2 });
  const fmtNum = (v, dec = 2) => (isNum(v) ? nf(dec).format(v).replace('-', '−') : '—');
  const fmtSigned = (v, dec = 2, suffix = '') =>
    isNum(v) ? (v > 0 ? '+' : v < 0 ? '−' : '') + nf(dec).format(Math.abs(v)) + suffix : '—';
  const fmtPct = (v, dec = 2) => fmtSigned(v, dec, '%');

  // Fiyat hassasiyeti: OKX'in tickSz değerinden (ör. 0.1 → 1 ondalık)
  let INSTRUMENTS = new Map();
  function priceDec(inst, sample) {
    const it = INSTRUMENTS.get(inst);
    if (it && it.tickSz) {
      const s = String(it.tickSz);
      if (/e-/i.test(s)) return Math.min(10, parseInt(s.split(/e-/i)[1], 10));
      const i = s.indexOf('.');
      return i < 0 ? 0 : Math.min(10, s.replace(/0+$/, '').length - i - 1);
    }
    const a = Math.abs(sample || 0);
    return a >= 1000 ? 1 : a >= 10 ? 2 : a >= 1 ? 3 : a >= 0.1 ? 4 : a >= 0.001 ? 6 : 8;
  }
  const fmtPrice = (inst, v) => fmtNum(v, priceDec(inst, v));

  const DTF = new Intl.DateTimeFormat('tr-TR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  const DTF_SHORT = new Intl.DateTimeFormat('tr-TR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  const DATE_ONLY = new Intl.DateTimeFormat('tr-TR', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' });
  const CLOCK = new Intl.DateTimeFormat('tr-TR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const fmtTime = (ms) => (isNum(ms) ? DTF.format(new Date(ms)) : '—');
  const fmtShort = (ms) => (isNum(ms) ? DTF_SHORT.format(new Date(ms)) : '—');
  const fmtDateUtc = (ms) => (isNum(ms) ? DATE_ONLY.format(new Date(ms)) : '—');
  const fmtClock = (ms) => (isNum(ms) ? CLOCK.format(new Date(ms)) : '—');
  function fmtDuration(ms) {
    const m = ms / 60000;
    if (m < 1) return Math.max(1, Math.round(ms / 1000)) + ' sn';
    if (m < 60) return Math.round(m) + ' dk';
    const hrs = m / 60;
    if (hrs < 48) return plainNf.format(Math.round(hrs * 10) / 10) + ' saat';
    return plainNf.format(Math.round((hrs / 24) * 10) / 10) + ' gün';
  }

  /** localStorage — gizli pencerede veya engelliyse sessizce varsayılana döner. */
  const store = {
    get(key, fallback) {
      try {
        const raw = window.localStorage.getItem('rds:' + key);
        return raw == null ? fallback : JSON.parse(raw);
      } catch (_) {
        return fallback;
      }
    },
    set(key, value) {
      try {
        window.localStorage.setItem('rds:' + key, JSON.stringify(value));
      } catch (_) {
        /* depolama kapalı olabilir */
      }
    },
    remove(key) {
      try {
        window.localStorage.removeItem('rds:' + key);
      } catch (_) {
        /* yok say */
      }
    },
  };

  // ---------------------------------------------------------------- uyarılar
  function showAlert(id, type, message, actions) {
    const box = document.getElementById('alerts');
    if (!box) return;
    const node = h(
      'div',
      { class: 'alert ' + type, 'data-alert': id, role: type === 'error' ? 'alert' : null },
      h('span', { class: 'alert-icon', 'aria-hidden': 'true' }, type === 'info' ? 'i' : '!'),
      h('div', { class: 'alert-body' }, message),
      actions && actions.length
        ? h(
            'div',
            { class: 'alert-actions' },
            actions.map((a) => h('button', { class: 'btn small', type: 'button', onclick: a.onClick }, a.label))
          )
        : null
    );
    const old = box.querySelector('[data-alert="' + id + '"]');
    if (old) old.replaceWith(node);
    else box.append(node);
  }
  function clearAlert(id) {
    const box = document.getElementById('alerts');
    const el = box && box.querySelector('[data-alert="' + id + '"]');
    if (el) el.remove();
  }

  function setSourceStatus(kind, text, title) {
    const el = document.getElementById('source-status');
    if (!el) return;
    el.querySelector('.dot').className = 'dot ' + kind;
    el.querySelector('.txt').textContent = text;
    el.title = title || text;
  }

  function describeSource(info) {
    if (info.source === 'direct') {
      setSourceStatus('ok', 'Canlı · OKX API', 'Veriler tarayıcıdan doğrudan OKX Public API’den çekiliyor');
    } else {
      setSourceStatus('warn', 'Yedek veri · GitHub Actions', 'Veriler GitHub Actions’ın ürettiği data/ dosyalarından okunuyor (≈15 dk gecikmeli)');
      if (info.fallbackReason) {
        showAlert(
          'source',
          'warn',
          'OKX’e doğrudan ulaşılamadı (' + info.fallbackReason + '). Yedek veriler gösteriliyor; en fazla ~15–30 dakika gecikmeli olabilir.'
        );
      }
    }
  }

  // Tüm istek yeniden denemelerini tek bir uyarıda göster
  let retryTimer = 0;
  function wireOkxEvents() {
    OKX.onStatus((ev) => {
      if (ev.type === 'retry') {
        showAlert(
          'retry',
          'warn',
          'OKX isteği başarısız: ' +
            ev.error.message +
            '. ' +
            Math.max(1, Math.round(ev.wait / 1000)) +
            ' sn içinde yeniden denenecek (' +
            ev.attempt +
            '/' +
            ev.max +
            ').'
        );
        clearTimeout(retryTimer);
        retryTimer = setTimeout(() => clearAlert('retry'), ev.wait + 10000);
      } else if (ev.type === 'recovered') {
        clearTimeout(retryTimer);
        clearAlert('retry');
      }
    });
  }

  /** Sayfadaki data-cfg alanlarını config.js değerleriyle doldurur (metin ayarlarla hep uyumlu kalır). */
  function fillConfigText() {
    document.querySelectorAll('[data-cfg]').forEach((el) => {
      const v = CONFIG.STRATEGY[el.dataset.cfg];
      if (v != null) el.textContent = typeof v === 'number' ? plainNf.format(v) : String(v);
    });
    document.querySelectorAll('[data-cfg-root]').forEach((el) => {
      const v = CONFIG[el.dataset.cfgRoot];
      if (v != null) el.textContent = String(v);
    });
    document.querySelectorAll('#repo-link').forEach((a) => {
      if (CONFIG.REPO_URL) a.href = CONFIG.REPO_URL;
      else a.remove();
    });
  }

  // =====================================================================
  // GRAFİKLER (TradingView Lightweight Charts v5)
  // =====================================================================

  const hasCharts = () => typeof window.LightweightCharts !== 'undefined';
  const sec = (ms) => Math.floor(ms / 1000);
  const MONTHS = ['Oca', 'Şub', 'Mar', 'Nis', 'May', 'Haz', 'Tem', 'Ağu', 'Eyl', 'Eki', 'Kas', 'Ara'];
  const pad2 = (n) => String(n).padStart(2, '0');

  function tickFormatter(time, type) {
    const d = new Date(time * 1000); // yerel saat
    if (type === 0) return String(d.getFullYear());
    if (type === 1) return MONTHS[d.getMonth()] + ' ' + d.getFullYear();
    if (type === 2) return d.getDate() + ' ' + MONTHS[d.getMonth()];
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  const priceFmt = (dec) => ({ type: 'custom', minMove: Math.pow(10, -dec), formatter: (p) => nf(dec).format(p) });

  function withAlpha(hex, a) {
    const n = parseInt(hex.slice(1), 16);
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
  }

  function deepMerge(a, b) {
    const out = Object.assign({}, a);
    for (const [k, v] of Object.entries(b || {})) {
      out[k] = v && typeof v === 'object' && !Array.isArray(v) && a[k] && typeof a[k] === 'object' ? deepMerge(a[k], v) : v;
    }
    return out;
  }

  /**
   * Grafik, kapsayıcının o anki ölçüsüyle oluşturulur (autoSize kullanılmaz: autoSize ile
   * ilk boyut ResizeObserver'ı beklediğinden hemen ayarlanan görünür aralık bozuluyordu).
   * Sonraki boyut değişiklikleri kendi ResizeObserver'ımızla uygulanır.
   */
  function createChart(container, extra) {
    const LW = window.LightweightCharts;
    const base = {
      width: container.clientWidth,
      height: container.clientHeight,
      layout: {
        background: { type: 'solid', color: C.surface },
        textColor: C.muted,
        fontFamily: getComputedStyle(document.body).fontFamily,
        fontSize: 11,
        panes: { separatorColor: C.grid, separatorHoverColor: 'rgba(255,255,255,0.08)', enableResize: true },
      },
      grid: { vertLines: { color: C.grid }, horzLines: { color: C.grid } },
      rightPriceScale: { borderColor: C.grid },
      timeScale: {
        borderColor: C.grid,
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 4,
        lockVisibleTimeRangeOnResize: true, // pencere boyutu değişince aynı zaman aralığı görünür kalsın
        tickMarkFormatter: tickFormatter,
      },
      crosshair: { mode: LW.CrosshairMode.Normal },
      localization: { locale: 'tr-TR', timeFormatter: (t) => fmtTime(t * 1000) },
    };
    const chart = LW.createChart(container, deepMerge(base, extra));
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver((entries) => {
        const r = entries[0].contentRect;
        if (r.width > 0 && r.height > 0) chart.resize(Math.floor(r.width), Math.floor(r.height));
      });
      ro.observe(container);
      chartObservers.set(chart, ro);
    }
    return chart;
  }
  /**
   * Görünür aralığı uygular. Grafik henüz ilk kez çizilmediyse zaman ekseninin genişliği
   * bilinmez; bu durumda EN SON istenen aralık, eksen gerçek genişliğini aldığında
   * yeniden uygulanır.
   */
  const rangeState = new WeakMap();
  function applyRange(chart, fn) {
    const ts = chart.timeScale();
    let st = rangeState.get(chart);
    if (!st) {
      st = { sized: ts.width() > 50, fn: null };
      rangeState.set(chart, st);
      if (!st.sized) {
        const onSize = (w) => {
          if (w <= 50) return;
          ts.unsubscribeSizeChange(onSize);
          st.sized = true;
          if (st.fn) st.fn(ts);
          st.fn = null;
        };
        ts.subscribeSizeChange(onSize);
      }
    }
    fn(ts);
    if (!st.sized) st.fn = fn;
  }
  const chartObservers = new WeakMap();
  function disposeChart(chart) {
    const ro = chartObservers.get(chart);
    if (ro) ro.disconnect();
    chart.remove();
  }

  function chartUnavailable(container) {
    container.replaceChildren(
      h(
        'div',
        { class: 'chart-msg' },
        'Grafik kütüphanesi yüklenemedi (CDN erişimi engellenmiş olabilir). Tablo ve hesaplamalar çalışmaya devam eder.'
      )
    );
  }

  /**
   * Mum + EMA + alt panelde RSI grafiği kurar.
   * opts: {inst, candles, live, rsi[], ema[], params, showEma}
   */
  function buildPriceChart(container, legendEl, opts) {
    const LW = window.LightweightCharts;
    const chart = createChart(container);
    const bars = opts.live ? opts.candles.concat([opts.live]) : opts.candles.slice();
    const dec = priceDec(opts.inst, bars.length ? bars[bars.length - 1].close : 0);
    const pf = priceFmt(dec);
    const times = new Set(bars.map((c) => sec(c.time)));

    const candle = chart.addSeries(LW.CandlestickSeries, {
      upColor: C.buy,
      downColor: C.sell,
      wickUpColor: C.buy,
      wickDownColor: C.sell,
      borderVisible: false,
      priceFormat: pf,
    });
    candle.setData(bars.map((c) => ({ time: sec(c.time), open: c.open, high: c.high, low: c.low, close: c.close })));

    const lineData = (arr) => opts.candles.map((c, i) => (arr[i] == null ? { time: sec(c.time) } : { time: sec(c.time), value: arr[i] }));

    if (opts.showEma && opts.ema) {
      const ema = chart.addSeries(LW.LineSeries, {
        color: C.ema,
        lineWidth: 1,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
        priceFormat: pf,
      });
      ema.setData(lineData(opts.ema));
    }

    // RSI paneli (0–100 sabit ölçek)
    const rsi = chart.addSeries(
      LW.LineSeries,
      {
        color: C.rsi,
        lineWidth: 2,
        priceLineVisible: false,
        lastValueVisible: true,
        priceFormat: priceFmt(1),
        autoscaleInfoProvider: () => ({ priceRange: { minValue: 0, maxValue: 100 } }),
      },
      1
    );
    rsi.setData(lineData(opts.rsi));
    rsi.priceScale().applyOptions({ scaleMargins: { top: 0.06, bottom: 0.04 } });
    const p = opts.params || {};
    const guides = [
      [70, LW.LineStyle.Dotted, false],
      [30, LW.LineStyle.Dotted, false],
      [p.bearRsiMin, LW.LineStyle.Dashed, true],
      [p.bullRsiMax, LW.LineStyle.Dashed, true],
    ];
    for (const [price, lineStyle, label] of guides) {
      if (!isNum(price)) continue;
      rsi.createPriceLine({ price, color: label ? '#5b6577' : '#3a4454', lineWidth: 1, lineStyle, axisLabelVisible: label, title: '' });
    }
    const panes = chart.panes();
    if (panes[0] && panes[0].setStretchFactor) panes[0].setStretchFactor(3);
    if (panes[1] && panes[1].setStretchFactor) panes[1].setStretchFactor(1);

    // Crosshair açıklaması (üzerine gelinen mumun değerleri)
    const lastBar = bars[bars.length - 1];
    const lastRsi = (() => {
      for (let i = opts.rsi.length - 1; i >= 0; i--) if (opts.rsi[i] != null) return opts.rsi[i];
      return null;
    })();
    function legend(timeSec, b, r) {
      if (!legendEl || !b) return;
      const chg = b.open ? (b.close / b.open - 1) * 100 : null;
      legendEl.replaceChildren(
        h('span', { class: 'li' }, fmtTime(timeSec * 1000)),
        h('span', { class: 'li' }, 'A ', h('b', null, nf(dec).format(b.open))),
        h('span', { class: 'li' }, 'Y ', h('b', null, nf(dec).format(b.high))),
        h('span', { class: 'li' }, 'D ', h('b', null, nf(dec).format(b.low))),
        h('span', { class: 'li' }, 'K ', h('b', null, nf(dec).format(b.close))),
        chg != null ? h('span', { class: 'li' }, fmtPct(chg)) : null,
        isNum(r)
          ? h('span', { class: 'li' }, h('span', { class: 'swatch', style: 'background:' + C.rsi }), 'RSI ', h('b', null, nf(1).format(r)))
          : null
      );
    }
    const setDefault = () => lastBar && legend(sec(lastBar.time), lastBar, lastRsi);
    setDefault();
    chart.subscribeCrosshairMove((param) => {
      const b = param && param.time != null ? param.seriesData.get(candle) : null;
      if (!b) return setDefault();
      const r = param.seriesData.get(rsi);
      legend(param.time, b, r && r.value);
    });

    let markersApi = null;
    let priceLines = [];

    return {
      chart,
      candle,
      rsi,
      bars,
      dec,
      /** Uyumsuzluk çizgilerini hem fiyatta hem RSI'da çizer. */
      addDivergenceLines(signals, selectedId) {
        for (const s of signals) {
          if (!times.has(sec(s.time1)) || !times.has(sec(s.time2))) continue;
          const sel = s.id === selectedId;
          const color = s.type === 'BUY' ? C.buy : C.sell;
          const style = {
            color: sel ? color : withAlpha(color, 0.55),
            lineWidth: sel ? 3 : 1,
            priceLineVisible: false,
            lastValueVisible: false,
            crosshairMarkerVisible: false,
            pointMarkersVisible: sel,
          };
          chart
            .addSeries(LW.LineSeries, Object.assign({ priceFormat: pf }, style), 0)
            .setData([
              { time: sec(s.time1), value: s.price1 },
              { time: sec(s.time2), value: s.price2 },
            ]);
          // RSI çizgisi RSI'ın kendi tepe/diplerine bağlanır (fiyat pivotundan ±rsiWindow mum)
          const rt1 = sec(s.rsiTime1 != null ? s.rsiTime1 : s.time1);
          const rt2 = sec(s.rsiTime2 != null ? s.rsiTime2 : s.time2);
          if (times.has(rt1) && times.has(rt2)) {
            chart
              .addSeries(LW.LineSeries, Object.assign({ priceFormat: priceFmt(1) }, style), 1)
              .setData([
                { time: rt1, value: s.rsi1 },
                { time: rt2, value: s.rsi2 },
              ]);
          }
        }
      },
      setMarkers(markers) {
        const valid = markers.filter((m) => times.has(m.time)).sort((a, b) => a.time - b.time);
        if (markersApi) markersApi.setMarkers(valid);
        else markersApi = LW.createSeriesMarkers(candle, valid);
      },
      /** Giriş / SL / TP1 / TP2 yatay çizgileri (öncekileri siler). */
      setLevels(levels) {
        priceLines.forEach((l) => candle.removePriceLine(l));
        priceLines = [];
        const def = [
          ['entry', 'Giriş', C.accent, LW.LineStyle.Solid],
          ['sl', 'SL', C.sell, LW.LineStyle.Dashed],
          ['tp1', 'TP1', C.buy, LW.LineStyle.Dashed],
          ['tp2', 'TP2', C.buy, LW.LineStyle.Dashed],
        ];
        for (const [key, title, color, lineStyle] of def) {
          if (levels && isNum(levels[key])) {
            priceLines.push(candle.createPriceLine({ price: levels[key], color, lineWidth: 1, lineStyle, axisLabelVisible: true, title }));
          }
        }
      },
      destroy() {
        disposeChart(chart);
      },
    };
  }

  // Durum etiketleri — her zaman ikon + metin (renk tek başına anlam taşımaz)
  const STATUS = {
    PENDING: { label: 'Giriş bekleniyor', ic: '…', cls: 'st-wait' },
    OPEN: { label: 'Pozisyonda', ic: '●', cls: 'st-open' },
    TP1_OPEN: { label: 'TP1 alındı · açık', ic: '½', cls: 'st-good' },
    TP1: { label: 'TP1 hedefi', ic: '✓', cls: 'st-good' },
    TP2: { label: 'TP2 hedefi', ic: '✓', cls: 'st-good' },
    BE: { label: 'Başa baş', ic: '=', cls: 'st-warn' },
    SL: { label: 'Stop oldu', ic: '✕', cls: 'st-bad' },
    INVALID: { label: 'Geçersiz seviye', ic: '!', cls: 'st-none' },
  };
  const OPEN_STATES = new Set(['PENDING', 'OPEN', 'TP1_OPEN']);

  function statusBadge(ev) {
    const s = STATUS[ev.status] || STATUS.INVALID;
    const showR = ev.status !== 'PENDING' && ev.status !== 'OPEN' && ev.status !== 'INVALID';
    return h(
      'span',
      { class: 'status ' + s.cls },
      h('span', { class: 'ic', 'aria-hidden': 'true' }, s.ic),
      s.label + (showR ? ' · ' + fmtSigned(ev.r, 2, 'R') : '')
    );
  }

  function sideBadge(type, kind) {
    const buy = type === 'BUY';
    return h(
      'span',
      null,
      h('span', { class: 'side ' + (buy ? 'buy' : 'sell') }, h('span', { class: 'arrow', 'aria-hidden': 'true' }, buy ? '▲' : '▼'), type),
      kind === 'hidden' ? h('span', { class: 'kind-tag' }, 'gizli') : null
    );
  }

  function scoreTitle(sig) {
    const p = sig.scoreParts;
    const trend = p.aligned == null ? 'EMA hesaplanamadı' : p.aligned ? 'trendle uyumlu' : 'trende ters';
    return (
      'RSI farkı ' +
      nf(1).format(p.rsiDiff) +
      ' → ' +
      Math.round(p.rsiPts) +
      '/40 · Fiyat farkı ' +
      nf(2).format(p.priceDiffAtr) +
      ' ATR → ' +
      Math.round(p.pricePts) +
      '/30 · ' +
      trend +
      ' → ' +
      Math.round(p.trendPts) +
      '/30'
    );
  }

  function scoreCell(sig) {
    return h(
      'span',
      { class: 'score', title: scoreTitle(sig) },
      h('span', { class: 'meter', 'aria-hidden': 'true' }, h('span', { style: 'width:' + sig.score + '%' })),
      h('b', null, String(sig.score))
    );
  }

  const rrText = (sig) => '1:' + plainNf.format(sig.rr1) + ' · 1:' + plainNf.format(sig.rr2);

  // =====================================================================
  // SİNYAL PANELİ
  // =====================================================================
  function initSignalsPage() {
    const tbody = document.getElementById('sig-body');
    const state = {
      rows: [],
      byKey: new Map(),
      tickers: new Map(),
      filters: Object.assign({ tf: 'all', dir: 'all', view: 'all' }, store.get('sig-filters', {})),
      toggles: Object.assign(
        { useHidden: !!CONFIG.STRATEGY.useHidden, useEmaFilter: !!CONFIG.STRATEGY.useEmaFilter },
        store.get('sig-toggles', {})
      ),
      sort: Object.assign({ key: 'time', dir: 'desc' }, store.get('sig-sort', {})),
      lastUpdate: {},
      busy: new Set(),
      stale: new Set(),
      openKey: null,
      staticTime: null,
    };
    // Kayıtlı filtreler config değişince geçersiz kalmış olabilir
    if (state.filters.tf !== 'all' && !TF[state.filters.tf]) state.filters.tf = 'all';
    if (!['all', 'BUY', 'SELL'].includes(state.filters.dir)) state.filters.dir = 'all';
    if (!['all', 'signals', 'open', '24h'].includes(state.filters.view)) state.filters.view = 'all';

    document.getElementById('coin-count').textContent = String(CONFIG.COINS.length);
    document.getElementById('tf-list').textContent = TFS.map((t) => t.label).join(' / ');
    document.getElementById('t-refresh').textContent =
      'Otomatik: ' + TFS.map((t) => t.label + ' ' + fmtDuration(t.refreshMs)).join(' · ');

    // Satırlar: her coin × her zaman dilimi
    for (const tf of TFS) {
      for (const coin of CONFIG.COINS) {
        const inst = OKX.instId(coin);
        const row = { key: inst + '|' + tf.id, inst, coin, tf, candles: null, live: null, result: null, sig: null, ev: null, error: null, missing: null };
        state.rows.push(row);
        state.byKey.set(row.key, row);
      }
    }

    const strategyParams = () => Object.assign({}, CONFIG.STRATEGY, state.toggles);

    /** Aynı strateji fonksiyonuyla son sinyali ve durumunu hesaplar. */
    function compute(row) {
      row.result = null;
      row.sig = null;
      row.ev = null;
      if (!row.candles || !row.candles.length) return;
      const p = strategyParams();
      const res = Strategy.run(row.candles, p);
      row.result = res;
      const sig = res.signals.length ? res.signals[res.signals.length - 1] : null;
      if (!sig) return;
      if (sig.pending) {
        // Onay son kapanan mumda: giriş, şu an açık olan mumun açılışı
        const expected = sig.confirmTime + row.tf.ms;
        if (row.live && row.live.time === expected) {
          Strategy.setEntry(sig, row.live.open, p);
          sig.entryTime = row.live.time;
        } else {
          Strategy.setEntry(sig, row.candles[row.candles.length - 1].close, p);
          sig.entryTime = expected;
          sig.entryEstimated = true;
        }
      }
      const after = sig.pending ? [] : row.candles.slice(sig.entryIndex);
      if (row.live && row.live.time >= sig.entryTime) after.push(row.live);
      row.sig = sig;
      row.ev = Strategy.evaluate(sig, after, CONFIG.BACKTEST.exitMode);
      row.barsAgo = row.candles.length - 1 - sig.confirmIndex;
    }

    const currentPrice = (row) => {
      const t = state.tickers.get(row.inst);
      if (t && isNum(t.last)) return t.last;
      if (row.live) return row.live.close;
      return row.candles && row.candles.length ? row.candles[row.candles.length - 1].close : null;
    };
    const pnlPct = (row, price) => {
      const s = row.sig;
      if (!s || !isNum(s.entry) || !isNum(price)) return null;
      return ((s.type === 'BUY' ? 1 : -1) * (price - s.entry) * 100) / s.entry;
    };

    // ------------------------------------------------------------ filtre ve sıralama
    function visible(row) {
      const f = state.filters;
      if (f.tf !== 'all' && row.tf.id !== f.tf) return false;
      if (f.dir !== 'all' && (!row.sig || row.sig.type !== f.dir)) return false;
      if (f.view === 'signals' && !row.sig) return false;
      if (f.view === 'open' && !(row.ev && OPEN_STATES.has(row.ev.status))) return false;
      if (f.view === '24h' && !(row.sig && Date.now() - row.sig.entryTime <= DAY)) return false;
      return true;
    }

    const STATUS_ORDER = { PENDING: 0, OPEN: 1, TP1_OPEN: 2, TP2: 3, TP1: 4, BE: 5, SL: 6, INVALID: 7 };
    function sortValue(row, key) {
      switch (key) {
        case 'coin':
          return CONFIG.COINS.indexOf(row.coin);
        case 'tf':
          return TFS.indexOf(row.tf);
        case 'dir':
          return row.sig ? (row.sig.type === 'BUY' ? 0 : 1) : null;
        case 'score':
          return row.sig ? row.sig.score : null;
        case 'price':
          return row.sig && row.ev && OPEN_STATES.has(row.ev.status) ? pnlPct(row, currentPrice(row)) : null;
        case 'status':
          return row.ev ? STATUS_ORDER[row.ev.status] : null;
        default:
          return row.sig ? row.sig.entryTime : null;
      }
    }
    function compare(a, b) {
      const { key, dir } = state.sort;
      const va = sortValue(a, key);
      const vb = sortValue(b, key);
      if (va == null && vb == null) return tieBreak(a, b);
      if (va == null) return 1; // değeri olmayanlar her zaman sonda
      if (vb == null) return -1;
      if (va === vb) return tieBreak(a, b);
      return dir === 'asc' ? va - vb : vb - va;
    }
    const tieBreak = (a, b) => TFS.indexOf(a.tf) - TFS.indexOf(b.tf) || CONFIG.COINS.indexOf(a.coin) - CONFIG.COINS.indexOf(b.coin);

    // ------------------------------------------------------------ çizim
    function cell(cls, label, ...content) {
      return h('td', { class: cls, 'data-label': label }, ...content);
    }

    function renderRow(row) {
      const s = row.sig;
      const price = currentPrice(row);
      const stale = row.error && row.candles;
      const tr = h('tr', {
        class: 'clickable' + (s ? '' : ' no-signal') + (stale ? ' is-stale' : '') + (row.key === state.openKey ? ' selected' : ''),
        tabindex: '0',
        'data-key': row.key,
        'aria-label': row.coin + ' ' + row.tf.label + (s ? ' ' + s.type + ' sinyali' : ' sinyal yok') + ' — grafiği aç',
      });
      const errIcon = row.error ? h('span', { class: 'err-ic', title: 'Son güncelleme başarısız: ' + row.error.message }, '⚠') : null;

      tr.append(
        cell(
          'c-coin',
          'Coin',
          h(
            'span',
            { class: 'coin' },
            h('span', { class: 'coin-icon', 'aria-hidden': 'true' }, row.coin.slice(0, 4)),
            h('span', null, h('b', null, row.coin), h('small', null, '/' + CONFIG.QUOTE), errIcon)
          )
        ),
        cell('c-tf', 'TF', h('span', { class: 'tf-badge' }, row.tf.label))
      );

      if (row.missing) {
        tr.append(
          cell('c-dir', 'Yön', h('span', { class: 'muted' }, row.missing)),
          ...['c-entry', 'c-sl', 'c-tp1', 'c-tp2', 'c-rr', 'c-score'].map((c) => cell(c + ' num', '', '—')),
          cell('c-time', 'Sinyal zamanı', '—'),
          cell('c-price num', 'Güncel fiyat', '—'),
          cell('c-status', 'Durum', h('span', { class: 'status st-none' }, 'Atlandı'))
        );
        tr.classList.add('no-signal');
        return tr;
      }

      if (!row.candles) {
        const sk = () => h('span', { class: 'skeleton' });
        tr.append(
          cell('c-dir', 'Yön', row.error ? h('span', { class: 'muted' }, 'Veri alınamadı') : sk()),
          ...['c-entry', 'c-sl', 'c-tp1', 'c-tp2', 'c-rr', 'c-score'].map((c) => cell(c + ' num', '', row.error ? '—' : sk())),
          cell('c-time', 'Sinyal zamanı', row.error ? '—' : sk()),
          cell('c-price num', 'Güncel fiyat', isNum(price) ? fmtPrice(row.inst, price) : '—'),
          cell(
            'c-status',
            'Durum',
            row.error ? h('span', { class: 'status st-none', title: row.error.message }, 'Hata · tekrar denenecek') : h('span', { class: 'loading-text' }, 'Yükleniyor…')
          )
        );
        tr.classList.add('no-signal');
        return tr;
      }

      if (!s) {
        tr.append(
          cell('c-dir', 'Yön', h('span', { class: 'muted' }, '—')),
          ...['c-entry', 'c-sl', 'c-tp1', 'c-tp2', 'c-rr', 'c-score'].map((c) => cell(c + ' num', '', '—')),
          cell('c-time', 'Sinyal zamanı', '—'),
          cell('c-price num', 'Güncel fiyat', fmtPrice(row.inst, price)),
          cell('c-status', 'Durum', h('span', { class: 'status st-none' }, 'Sinyal yok'))
        );
        return tr;
      }

      const pl = OPEN_STATES.has(row.ev.status) ? pnlPct(row, price) : null;
      tr.append(
        cell('c-dir', 'Yön', sideBadge(s.type, s.kind)),
        cell('c-entry num', 'Giriş', fmtPrice(row.inst, s.entry), s.entryEstimated ? h('span', { class: 'cell-sub' }, 'tahmini') : null),
        cell('c-sl num', 'SL', fmtPrice(row.inst, s.sl)),
        cell('c-tp1 num', 'TP1', fmtPrice(row.inst, s.tp1)),
        cell('c-tp2 num', 'TP2', fmtPrice(row.inst, s.tp2)),
        cell('c-rr num', 'R:R', rrText(s)),
        cell('c-score num', 'Güç', scoreCell(s)),
        cell(
          'c-time',
          'Sinyal zamanı',
          h('span', null, fmtShort(s.entryTime)),
          h('span', { class: 'cell-sub' }, row.barsAgo <= 0 ? 'son mumda' : row.barsAgo + ' mum önce')
        ),
        cell(
          'c-price num',
          'Güncel fiyat',
          fmtPrice(row.inst, price),
          isNum(pl)
            ? h(
                'span',
                { class: 'delta', title: 'Girişe göre yön bazlı kâr/zarar' },
                h('span', { class: pl >= 0 ? 'up' : 'down', 'aria-hidden': 'true' }, pl >= 0 ? '▲ ' : '▼ '),
                fmtPct(pl)
              )
            : null
        ),
        cell('c-status', 'Durum', statusBadge(row.ev))
      );
      return tr;
    }

    function renderTiles() {
      let buy = 0;
      let sell = 0;
      let recent = 0;
      let loaded = 0;
      let expected = 0;
      const now = Date.now();
      for (const r of state.rows) {
        if (!r.missing) expected++;
        if (r.candles) loaded++;
        if (r.sig && r.ev && OPEN_STATES.has(r.ev.status)) r.sig.type === 'BUY' ? buy++ : sell++;
        if (r.result) {
          for (const s of r.result.signals) {
            const t = s.entryTime != null ? s.entryTime : s.confirmTime + r.tf.ms;
            if (now - t <= DAY) recent++;
          }
        }
      }
      document.getElementById('t-buy').textContent = String(buy);
      document.getElementById('t-sell').textContent = String(sell);
      document.getElementById('t-24h').textContent = String(recent);
      document.getElementById('t-loaded').textContent = loaded + '/' + expected;
    }

    function renderMeta() {
      const parts = TFS.filter((t) => state.lastUpdate[t.id]).map(
        (t) => t.label + ' ' + fmtClock(state.lastUpdate[t.id]).slice(0, 5) + (state.busy.has(t.id) ? '…' : '')
      );
      const busy = state.busy.size > 0;
      document.getElementById('last-update').textContent = busy
        ? 'Güncelleniyor…'
        : parts.length
          ? 'Son güncelleme: ' + parts.join(' · ')
          : '';
      document.getElementById('refresh-btn').disabled = busy;
    }

    function renderSortHeaders() {
      document.querySelectorAll('#sig-table th[data-sort]').forEach((th) => {
        th.setAttribute(
          'aria-sort',
          th.dataset.sort === state.sort.key ? (state.sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'
        );
      });
    }

    function render() {
      const focusedKey = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.key : null;
      const rows = state.rows.filter(visible).sort(compare);
      const frag = document.createDocumentFragment();
      for (const r of rows) frag.append(renderRow(r));
      if (!rows.length) frag.append(h('tr', null, h('td', { colspan: '12', class: 'table-empty' }, 'Bu filtrelere uyan satır yok.')));
      tbody.replaceChildren(frag);
      if (focusedKey) {
        const el = tbody.querySelector('tr[data-key="' + focusedKey + '"]');
        if (el) el.focus({ preventScroll: true });
      }
      document.getElementById('table-count').textContent = rows.length + ' satır gösteriliyor (toplam ' + state.rows.length + ')';
      renderTiles();
      renderSortHeaders();
    }
    let raf = 0;
    const scheduleRender = () => {
      if (!raf) raf = requestAnimationFrame(() => ((raf = 0), render()));
    };

    // ------------------------------------------------------------ veri
    async function loadRow(row, full) {
      if (row.missing) return;
      const tf = row.tf;
      try {
        const incremental = !full && row.candles && row.candles.length && OKX.getSource() === 'direct';
        let fresh = null;
        if (incremental) {
          // Artımlı: yalnızca son 100 mumu çekip mevcut verinin üstüne ekle
          const r = await OKX.getRecentCandles(row.inst, tf, 100);
          const first = r.candles[0];
          const last = row.candles[row.candles.length - 1];
          if (first && first.time <= last.time + tf.ms) {
            row.candles = OKX.mergeCandles(row.candles, r.candles, CONFIG.SIGNAL_CANDLES);
            row.live = r.live;
          } else fresh = await OKX.getRecentCandles(row.inst, tf, CONFIG.SIGNAL_CANDLES); // arada boşluk var → tam yükle
        } else fresh = await OKX.getRecentCandles(row.inst, tf, CONFIG.SIGNAL_CANDLES);
        if (fresh) {
          row.candles = fresh.candles;
          row.live = fresh.live;
          if (OKX.getSource() === 'static' && fresh.updatedAt) state.staticTime = fresh.updatedAt;
        }
        row.error = null;
        compute(row);
      } catch (err) {
        if (err.name !== 'AbortError') row.error = err;
      }
      scheduleRender();
    }

    async function refreshTF(tf, full) {
      if (state.busy.has(tf.id)) return;
      state.busy.add(tf.id);
      renderMeta();
      const rows = state.rows.filter((r) => r.tf === tf && !r.missing);
      await Promise.all(rows.map((r) => loadRow(r, full)));
      state.busy.delete(tf.id);
      const failed = rows.filter((r) => r.error);
      if (rows.length && failed.length === rows.length) {
        showAlert(
          'load-' + tf.id,
          'error',
          tf.label + ' verisi alınamadı: ' + failed[0].error.message + '. Otomatik olarak tekrar denenecek.',
          [{ label: 'Şimdi dene', onClick: () => refreshTF(tf, true) }]
        );
        setSourceStatus('bad', 'Bağlantı hatası', failed[0].error.message);
      } else {
        clearAlert('load-' + tf.id);
        state.lastUpdate[tf.id] = Date.now();
        if (OKX.getSource() === 'direct') setSourceStatus('ok', 'Canlı · OKX API');
        else setSourceStatus('warn', 'Yedek veri' + (state.staticTime ? ' · ' + fmtClock(state.staticTime).slice(0, 5) : ''));
      }
      if (state.openKey) {
        const row = state.byKey.get(state.openKey);
        if (row && row.tf === tf) renderDialogInfo(row);
      }
      renderMeta();
      scheduleRender();
    }

    async function refreshTickers() {
      try {
        state.tickers = await OKX.getTickers();
        scheduleRender();
      } catch (_) {
        /* fiyat, mum verisinden gösterilmeye devam eder */
      }
    }

    function startTimers() {
      for (const tf of TFS) {
        setInterval(() => {
          if (document.hidden) state.stale.add(tf.id);
          else refreshTF(tf);
        }, tf.refreshMs);
      }
      setInterval(() => {
        if (!document.hidden) refreshTickers();
      }, CONFIG.TICKER_REFRESH_MS);
      // Sekme arka plandayken yenileme yapılmaz; geri gelince bekleyenler yenilenir
      document.addEventListener('visibilitychange', () => {
        if (document.hidden) return;
        for (const id of state.stale) refreshTF(TF[id]);
        state.stale.clear();
        refreshTickers();
      });
    }

    // ------------------------------------------------------------ filtre kontrolleri
    const tfSeg = document.getElementById('f-tf');
    tfSeg.replaceChildren(
      h('button', { type: 'button', 'data-v': 'all' }, 'Tümü'),
      ...TFS.map((t) => h('button', { type: 'button', 'data-v': t.id }, t.label))
    );
    function syncSeg(seg, value) {
      seg.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === value)));
    }
    function bindSeg(seg, key) {
      syncSeg(seg, state.filters[key]);
      seg.addEventListener('click', (e) => {
        const b = e.target.closest('button[data-v]');
        if (!b) return;
        state.filters[key] = b.dataset.v;
        store.set('sig-filters', state.filters);
        syncSeg(seg, b.dataset.v);
        render();
      });
    }
    bindSeg(tfSeg, 'tf');
    bindSeg(document.getElementById('f-dir'), 'dir');

    const viewSel = document.getElementById('f-view');
    viewSel.value = state.filters.view;
    viewSel.addEventListener('change', () => {
      state.filters.view = viewSel.value;
      store.set('sig-filters', state.filters);
      render();
    });

    const optHidden = document.getElementById('opt-hidden');
    const optEma = document.getElementById('opt-ema');
    optHidden.checked = state.toggles.useHidden;
    optEma.checked = state.toggles.useEmaFilter;
    const onToggle = () => {
      state.toggles = { useHidden: optHidden.checked, useEmaFilter: optEma.checked };
      store.set('sig-toggles', state.toggles);
      state.rows.forEach(compute); // veri önbellekte; yalnızca yeniden hesapla
      render();
    };
    optHidden.addEventListener('change', onToggle);
    optEma.addEventListener('change', onToggle);

    document.querySelectorAll('#sig-table th[data-sort] button').forEach((btn) => {
      btn.addEventListener('click', () => {
        const key = btn.parentElement.dataset.sort;
        if (state.sort.key === key) state.sort.dir = state.sort.dir === 'asc' ? 'desc' : 'asc';
        else state.sort = { key, dir: key === 'coin' || key === 'tf' || key === 'dir' || key === 'status' ? 'asc' : 'desc' };
        store.set('sig-sort', state.sort);
        render();
      });
    });

    document.getElementById('refresh-btn').addEventListener('click', () => {
      refreshTickers();
      TFS.forEach((tf) => refreshTF(tf));
    });

    tbody.addEventListener('click', (e) => {
      const tr = e.target.closest('tr[data-key]');
      if (tr) openDialog(tr.dataset.key);
    });
    tbody.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const tr = e.target.closest('tr[data-key]');
      if (!tr) return;
      e.preventDefault();
      openDialog(tr.dataset.key);
    });

    // ------------------------------------------------------------ grafik penceresi
    const dlg = document.getElementById('chart-dialog');
    let dlgChart = null;

    function levelBox(label, value, sub, swatch) {
      return h(
        'div',
        { class: 'level' },
        h('div', { class: 'k' }, swatch ? h('span', { class: 'swatch', style: 'background:' + swatch }) : null, label),
        h('div', { class: 'v' }, value),
        sub ? h('div', { class: 's' }, sub) : null
      );
    }

    function renderDialogInfo(row) {
      const s = row.sig;
      document.getElementById('dlg-title').textContent = row.coin + '/' + CONFIG.QUOTE + ' · ' + row.tf.label;
      const badges = document.getElementById('dlg-badges');
      badges.replaceChildren(s ? sideBadge(s.type, s.kind) : h('span', { class: 'muted' }, 'Bu pencerede uyumsuzluk sinyali yok'));
      const levels = document.getElementById('dlg-levels');
      const price = currentPrice(row);
      if (!s) {
        levels.replaceChildren(levelBox('Güncel fiyat', fmtPrice(row.inst, price), null));
        return;
      }
      const pct = (a, b) => (isNum(a) && isNum(b) ? ((a - b) / b) * 100 : null);
      const buy = s.type === 'BUY';
      let rrNow = null;
      if (OPEN_STATES.has(row.ev.status) && isNum(price) && s.valid) {
        const reward = buy ? s.tp2 - price : price - s.tp2;
        const risk = buy ? price - s.sl : s.sl - price;
        if (reward > 0 && risk > 0) rrNow = reward / risk;
      }
      const dipWord = buy ? 'Dip' : 'Tepe';
      levels.replaceChildren(
        levelBox('Giriş', fmtPrice(row.inst, s.entry), (s.entryEstimated ? 'tahmini · ' : '') + fmtShort(s.entryTime), C.accent),
        levelBox('SL', fmtPrice(row.inst, s.sl), 'Risk ' + fmtNum(Math.abs(pct(s.sl, s.entry)), 2) + '%', C.sell),
        levelBox('TP1', fmtPrice(row.inst, s.tp1), fmtPct(pct(s.tp1, s.entry)) + ' · ' + plainNf.format(s.rr1) + 'R', C.buy),
        levelBox('TP2', fmtPrice(row.inst, s.tp2), fmtPct(pct(s.tp2, s.entry)) + ' · ' + plainNf.format(s.rr2) + 'R', C.buy),
        levelBox('Güç skoru', s.score + '/100', scoreTitle(s).replace(/ · /g, ' | ')),
        levelBox('Durum', statusBadge(row.ev), row.ev.fills.length ? row.ev.fills.map((f) => f.reason).join(' → ') : null),
        levelBox('Güncel fiyat', fmtPrice(row.inst, price), rrNow != null ? 'Şimdi girilirse R:R 1:' + nf(2).format(rrNow) + ' (TP2)' : null),
        levelBox(
          'Uyumsuzluk',
          fmtPrice(row.inst, s.price1) + ' → ' + fmtPrice(row.inst, s.price2),
          dipWord + ' RSI ' + nf(1).format(s.rsi1) + ' → ' + nf(1).format(s.rsi2) + ' · ' + (s.i2 - s.i1) + ' mum arayla'
        )
      );
    }

    function drawDialogChart(row) {
      const box = document.getElementById('dlg-chart');
      const legend = document.getElementById('dlg-legend');
      if (dlgChart) dlgChart.destroy();
      dlgChart = null;
      box.replaceChildren();
      legend.replaceChildren();
      if (!hasCharts()) return chartUnavailable(box);
      const res = row.result;
      const pc = buildPriceChart(box, legend, {
        inst: row.inst,
        candles: row.candles,
        live: row.live,
        rsi: res.rsi,
        ema: res.ema,
        params: res.params,
        showEma: true,
      });
      dlgChart = pc;
      const selId = row.sig ? row.sig.id : null;
      pc.addDivergenceLines(res.signals, selId);
      pc.setMarkers(
        res.signals.map((s) => {
          const buy = s.type === 'BUY';
          const t = s.entryTime != null ? s.entryTime : s.confirmTime + row.tf.ms;
          return {
            time: sec(t),
            position: buy ? 'belowBar' : 'aboveBar',
            shape: buy ? 'arrowUp' : 'arrowDown',
            color: buy ? C.buy : C.sell,
            text: s.type + (s.kind === 'hidden' ? ' (gizli)' : ''),
            size: s.id === selId ? 2 : 1,
          };
        })
      );
      if (row.sig) pc.setLevels(row.sig);
      const from = row.sig ? Math.max(0, row.sig.i1 - 60) : Math.max(0, pc.bars.length - 200);
      applyRange(pc.chart, (ts) => ts.setVisibleLogicalRange({ from, to: pc.bars.length + 4 }));
    }

    function openDialog(key) {
      const row = state.byKey.get(key);
      if (!row || !row.candles || !row.candles.length || !row.result) return;
      state.openKey = key;
      renderDialogInfo(row);
      if (!dlg.open) dlg.showModal();
      // showModal'dan sonra pencere yerleşimi hazır; grafik kapsayıcının boyutunu okuyabilir
      drawDialogChart(row);
      scheduleRender();
    }
    dlg.addEventListener('close', () => {
      if (dlgChart) dlgChart.destroy();
      dlgChart = null;
      state.openKey = null;
      scheduleRender();
    });
    document.getElementById('dlg-close').addEventListener('click', () => dlg.close());
    dlg.addEventListener('click', (e) => {
      if (e.target === dlg) dlg.close(); // arka plana tıklayınca kapat
    });

    // ------------------------------------------------------------ başlat
    render();
    (async () => {
      const info = await OKX.init();
      describeSource(info);
      try {
        const chk = await OKX.checkListings(CONFIG.COINS);
        INSTRUMENTS = chk.instruments;
        const bad = new Map(chk.missing.map((id) => [id, 'OKX’te listelenmiyor']));
        chk.inactive.forEach((x) => bad.set(x.instId, 'İşleme kapalı (' + x.state + ')'));
        state.rows.forEach((r) => (r.missing = bad.get(r.inst) || null));
        if (bad.size) {
          showAlert('listing', 'warn', 'Şu çiftler OKX spot piyasasında bulunamadı veya işleme kapalı, atlanıyor: ' + Array.from(bad.keys()).join(', ') + '. Listeyi js/config.js içinden düzenleyebilirsiniz.');
        }
      } catch (err) {
        showAlert('listing', 'warn', 'OKX enstrüman listesi alınamadı (' + err.message + '). Tüm coinler denenecek.');
      }
      render();
      refreshTickers();
      for (const tf of TFS) await refreshTF(tf, true); // önce 15m, sonra 4H, sonra 1D
      startTimers();
    })();

    window.UI = { state, refreshTF, openDialog, get chart() { return dlgChart; } };
  }

  // =====================================================================
  // BACKTEST
  // =====================================================================
  function initBacktestPage() {
    const Backtest = window.Backtest;
    const $ = (id) => document.getElementById(id);
    const els = {
      form: $('bt-form'),
      coins: $('bt-coins'),
      tf: $('bt-tf'),
      start: $('bt-start'),
      end: $('bt-end'),
      exit: $('bt-exit'),
      dir: $('bt-dir'),
      hidden: $('bt-hidden'),
      ema: $('bt-ema'),
      run: $('run-btn'),
      cancel: $('cancel-btn'),
      reset: $('reset-btn'),
      error: $('form-error'),
      estimate: $('estimate'),
      empty: $('bt-empty'),
      progress: $('bt-progress'),
      results: $('bt-results'),
    };

    // [id, grup, anahtar, min, max, tam sayı, etiket]
    const NUM_FIELDS = [
      ['bt-capital', 'bt', 'initialCapital', 1, 1e12, false, 'Başlangıç sermayesi'],
      ['bt-risk', 'bt', 'riskPct', 0.01, 100, false, 'İşlem başına risk'],
      ['bt-comm', 'bt', 'commissionPct', 0, 5, false, 'Komisyon'],
      ['bt-slip', 'bt', 'slippagePct', 0, 5, false, 'Slippage'],
      ['bt-lev', 'bt', 'maxLeverage', 0.1, 100, false, 'Maks. kaldıraç'],
      ['bt-rsi', 'st', 'rsiPeriod', 2, 100, true, 'RSI periyodu'],
      ['bt-atr', 'st', 'atrMult', 0, 10, false, 'ATR çarpanı'],
      ['bt-pl', 'st', 'pivotLeft', 1, 50, true, 'Pivot sol'],
      ['bt-pr', 'st', 'pivotRight', 1, 50, true, 'Pivot sağ'],
      ['bt-min', 'st', 'minBars', 1, 500, true, 'Pivotlar arası en az'],
      ['bt-max', 'st', 'maxBars', 1, 500, true, 'Pivotlar arası en çok'],
      ['bt-bull', 'st', 'bullRsiMax', 0, 100, false, 'BUY RSI eşiği'],
      ['bt-bear', 'st', 'bearRsiMin', 0, 100, false, 'SELL RSI eşiği'],
      ['bt-tp1', 'st', 'tp1R', 0.1, 20, false, 'TP1'],
      ['bt-tp2', 'st', 'tp2R', 0.1, 50, false, 'TP2'],
      ['bt-emap', 'st', 'emaPeriod', 2, 1000, true, 'EMA periyodu'],
    ];

    const isoDate = (ms) => new Date(ms).toISOString().slice(0, 10);
    const dateMs = (s) => {
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || '');
      return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : NaN;
    };
    const defaultTf = TF['4H'] ? '4H' : TFS[0].id;
    function defaults(tfId) {
      const tf = tfId || defaultTf;
      const days = (CONFIG.BACKTEST.defaultDays && CONFIG.BACKTEST.defaultDays[tf]) || 180;
      const end = Date.now();
      return {
        coins: CONFIG.COINS.slice(0, 2),
        tf,
        start: isoDate(end - days * DAY),
        end: isoDate(end),
        bt: Object.assign({}, Backtest.DEFAULTS, CONFIG.BACKTEST),
        st: Object.assign({}, Strategy.DEFAULTS, CONFIG.STRATEGY),
      };
    }

    // ------------------------------------------------------------ form
    els.coins.replaceChildren(
      ...CONFIG.COINS.map((coin) =>
        h('label', { class: 'chip' }, h('input', { type: 'checkbox', name: 'coin', value: coin }), h('span', null, coin))
      )
    );
    els.tf.replaceChildren(...TFS.map((t) => h('option', { value: t.id }, t.label)));
    const coinBoxes = () => Array.from(els.coins.querySelectorAll('input[name=coin]'));

    function writeForm(v) {
      coinBoxes().forEach((b) => (b.checked = v.coins.includes(b.value)));
      els.tf.value = TF[v.tf] ? v.tf : defaultTf;
      els.start.value = v.start;
      els.end.value = v.end;
      for (const [id, grp, key] of NUM_FIELDS) {
        const val = v[grp][key];
        $(id).value = isNum(val) ? String(val) : '';
        $(id).removeAttribute('aria-invalid');
      }
      els.exit.value = v.bt.exitMode;
      els.dir.value = v.bt.direction;
      els.hidden.checked = !!v.st.useHidden;
      els.ema.checked = !!v.st.useEmaFilter;
    }

    function readForm() {
      const errors = [];
      const v = { coins: coinBoxes().filter((b) => b.checked && !b.disabled).map((b) => b.value), tf: els.tf.value, bt: {}, st: {} };
      for (const [id, grp, key, min, max, int, label] of NUM_FIELDS) {
        const el = $(id);
        const num = el.value === '' ? NaN : Number(el.value);
        const ok = Number.isFinite(num) && num >= min && num <= max && (!int || Number.isInteger(num));
        el.setAttribute('aria-invalid', ok ? 'false' : 'true');
        if (!ok) errors.push(label + ': ' + plainNf.format(min) + '–' + plainNf.format(max) + ' arasında ' + (int ? 'bir tam sayı' : 'bir sayı') + ' girin.');
        v[grp][key] = num;
      }
      v.bt.exitMode = els.exit.value;
      v.bt.direction = els.dir.value;
      v.st.useHidden = els.hidden.checked;
      v.st.useEmaFilter = els.ema.checked;
      v.start = els.start.value;
      v.end = els.end.value;
      if (!v.coins.length) errors.unshift('En az bir coin seçin.');
      const s = dateMs(v.start);
      const e = dateMs(v.end);
      if (!isNum(s) || !isNum(e)) errors.push('Başlangıç ve bitiş tarihlerini girin.');
      else if (s >= e) errors.push('Başlangıç tarihi bitişten önce olmalı.');
      else if (s > Date.now()) errors.push('Başlangıç tarihi gelecekte olamaz.');
      if (v.st.minBars > v.st.maxBars) errors.push('Pivotlar arası en az değeri en çoktan büyük olamaz.');
      if (v.bt.exitMode === 'partial' && v.st.tp2R < v.st.tp1R) errors.push('Kısmi modda TP2, TP1’den küçük olamaz.');
      return { v, errors };
    }

    function rangeOf(v) {
      const tf = TF[v.tf];
      const startMs = dateMs(v.start);
      const endMs = Math.min(dateMs(v.end) + DAY - 1, Date.now());
      const warmStart = startMs - (CONFIG.BACKTEST.warmupBars || 600) * tf.ms;
      return { tf, startMs, endMs, warmStart };
    }

    function updateEstimate() {
      const { v, errors } = readForm();
      els.error.textContent = '';
      if (errors.length) {
        els.estimate.textContent = '';
        return;
      }
      const { tf, endMs, warmStart } = rangeOf(v);
      if (OKX.getSource() === 'static') {
        els.estimate.textContent =
          'Yedek veri modu: geçmiş, saklanan pencereyle sınırlı (' + tf.label + ': son ' + ((CONFIG.STATIC_HISTORY_DAYS || {})[tf.id] || '?') + ' gün).';
        return;
      }
      const pages = v.coins.length * OKX.estimatePages(tf, warmStart, endMs);
      // Sayfalar sırayla çekilir: istek başına hız sınırı aralığı veya ~0,3 sn ağ gecikmesi (büyük olan)
      const perReq = Math.max((CONFIG.RATE_LIMIT_MS && CONFIG.RATE_LIMIT_MS.history) || 120, 300);
      const secs = (pages * perReq) / 1000;
      els.estimate.textContent =
        'Tahmini ' + pages + ' istek · ~' + fmtDuration(secs * 1000) + ' (daha önce indirilen veri tekrar indirilmez)' + (pages > 3000 ? ' — uzun sürebilir' : '');
    }

    let startTouched = false;
    els.start.addEventListener('input', () => (startTouched = true));
    els.tf.addEventListener('change', () => {
      if (!startTouched) {
        const d = defaults(els.tf.value);
        els.start.value = d.start;
      }
    });
    els.form.addEventListener('input', updateEstimate);
    els.form.addEventListener('change', updateEstimate);
    $('coins-all').addEventListener('click', () => {
      coinBoxes().forEach((b) => (b.checked = !b.disabled));
      updateEstimate();
    });
    $('coins-none').addEventListener('click', () => {
      coinBoxes().forEach((b) => (b.checked = false));
      updateEstimate();
    });
    els.reset.addEventListener('click', () => {
      store.remove('bt-form');
      startTouched = false;
      writeForm(defaults());
      updateEstimate();
    });

    // Kayıtlı form (varsa) + varsayılanlar
    const saved = store.get('bt-form', null);
    const d0 = defaults(saved && saved.tf);
    writeForm(
      saved
        ? Object.assign({}, d0, saved, { bt: Object.assign({}, d0.bt, saved.bt), st: Object.assign({}, d0.st, saved.st), end: d0.end })
        : d0
    );

    // ------------------------------------------------------------ çalıştırma
    let running = null; // AbortController
    let last = null;

    function setRunning(on) {
      els.run.disabled = on;
      els.cancel.disabled = !on;
      els.run.textContent = on ? 'Çalışıyor…' : "▶ Backtest'i çalıştır";
    }
    function showProgress(pct, label, detail) {
      els.progress.classList.remove('hidden');
      els.empty.classList.add('hidden');
      const p = Math.max(0, Math.min(100, pct));
      $('prog-bar').style.width = p.toFixed(1) + '%';
      $('prog-bar-wrap').setAttribute('aria-valuenow', String(Math.round(p)));
      $('prog-pct').textContent = Math.round(p) + '%';
      $('prog-label').textContent = label;
      $('prog-detail').textContent = detail || '';
    }
    const hideProgress = () => els.progress.classList.add('hidden');

    async function run(e) {
      if (e) e.preventDefault();
      if (running) return;
      const { v, errors } = readForm();
      if (errors.length) {
        els.error.textContent = errors[0] + (errors.length > 1 ? ' (+' + (errors.length - 1) + ' hata daha)' : '');
        return;
      }
      els.error.textContent = '';
      store.set('bt-form', v);
      clearAlert('bt');
      clearAlert('bt-notes');

      const { tf, startMs, endMs, warmStart } = rangeOf(v);
      const insts = v.coins.map(OKX.instId);
      const est = insts.map(() => OKX.estimatePages(tf, warmStart, endMs));
      const totalEst = est.reduce((a, b) => a + b, 0);
      const series = {};
      const notes = [];
      let before = 0;

      running = new AbortController();
      setRunning(true);
      showProgress(0, 'Veri indiriliyor…', '');
      try {
        for (let k = 0; k < insts.length; k++) {
          const inst = insts[k];
          const candles = await OKX.getHistory(inst, tf, warmStart, endMs, {
            signal: running.signal,
            onProgress: ({ done, total }) => {
              const frac = total > 0 ? done / total : 1;
              showProgress(
                ((before + frac * est[k]) / totalEst) * 100,
                inst + ' indiriliyor (' + (k + 1) + '/' + insts.length + ')',
                done + '/' + total + ' istek · ' + tf.label + ' · ' + fmtDateUtc(warmStart) + ' – ' + fmtDateUtc(endMs) + ' (gösterge ısınma mumları dahil)'
              );
            },
          });
          before += est[k];
          const inRange = candles.filter((c) => c.time >= startMs).length;
          if (inRange < 10) {
            notes.push(inst + ': seçilen aralıkta yeterli veri yok, atlandı.');
            continue;
          }
          if (candles[0].time > startMs) {
            notes.push(inst + ': veri ' + fmtDateUtc(candles[0].time) + ' tarihinden başlıyor (listeleme tarihi veya yedek veri sınırı).');
          }
          series[inst] = candles;
        }
        if (!Object.keys(series).length) throw new Error('Seçilen aralıkta hiçbir coin için yeterli veri bulunamadı.');

        showProgress(100, 'Backtest hesaplanıyor…', '');
        await new Promise((r) => setTimeout(r, 30)); // arayüz bir kare çizebilsin
        const t0 = performance.now();
        // Formda olmayan ayarlar (ör. atrPeriod, rsiWindow) config.js'ten gelir
        const result = Backtest.run({
          series,
          startTime: startMs,
          endTime: endMs,
          strategy: Object.assign({}, CONFIG.STRATEGY, v.st),
          settings: Object.assign({}, CONFIG.BACKTEST, v.bt),
        });
        last = { v, tf, series, result, startMs, endMs, calcMs: performance.now() - t0 };
        if (notes.length) showAlert('bt-notes', 'warn', notes.join(' '));
        renderResults();
      } catch (err) {
        if (err.name === 'AbortError') showAlert('bt', 'info', 'Backtest iptal edildi. İndirilen kısım önbellekte tutuldu.');
        else showAlert('bt', 'error', 'Backtest çalıştırılamadı: ' + err.message, [{ label: 'Tekrar dene', onClick: () => run() }]);
        if (!last) els.empty.classList.remove('hidden');
      } finally {
        running = null;
        setRunning(false);
        hideProgress();
      }
    }
    els.form.addEventListener('submit', run);
    els.cancel.addEventListener('click', () => running && running.abort());

    // ------------------------------------------------------------ sonuçlar
    const EXIT_LABEL = { partial: 'TP1’de yarısı + başa baş, kalan TP2', tp1: 'Tamamı TP1', tp2: 'Tamamı TP2' };

    function metricTile(label, value, sub, arrow) {
      return h(
        'div',
        { class: 'tile' },
        h('div', { class: 'tile-label' }, label),
        h(
          'div',
          { class: 'tile-value' },
          arrow ? h('span', { style: 'color:' + (arrow > 0 ? C.buy : C.sell) + ';font-size:14px;margin-right:4px', 'aria-hidden': 'true' }, arrow > 0 ? '▲' : '▼') : null,
          value
        ),
        sub ? h('div', { class: 'tile-sub', title: sub }, sub) : null
      );
    }

    function renderResults() {
      const { result, v, tf, startMs, endMs, calcMs } = last;
      const m = result.metrics;
      els.empty.classList.add('hidden');
      els.results.classList.remove('hidden');
      const insts = Object.keys(last.series);
      $('res-summary').textContent =
        insts.map((i) => i.replace('-' + CONFIG.QUOTE, '')).join(', ') +
        ' · ' +
        tf.label +
        ' · ' +
        fmtDateUtc(startMs) +
        ' – ' +
        fmtDateUtc(endMs) +
        ' · ' +
        EXIT_LABEL[v.bt.exitMode] +
        ' · hesaplama ' +
        Math.max(1, Math.round(calcMs)) +
        ' ms';

      const pf = m.profitFactor === Infinity ? '∞' : fmtNum(m.profitFactor, 2);
      $('bt-metrics').replaceChildren(
        metricTile('Toplam getiri', fmtPct(m.totalReturnPct), fmtSigned(m.netProfit, 2) + ' USDT · son sermaye ' + fmtNum(m.finalEquity, 2), Math.sign(m.totalReturnPct)),
        metricTile('İşlem sayısı', fmtNum(m.trades, 0), m.wins + ' kazanç · ' + m.losses + ' kayıp'),
        metricTile('Kazanma oranı', m.winRate == null ? '—' : fmtNum(m.winRate, 1) + '%', 'Net PnL > 0 olan işlemler'),
        metricTile('Profit factor', pf, 'Brüt kâr ' + fmtNum(m.grossWin, 0) + ' / brüt zarar ' + fmtNum(m.grossLoss, 0)),
        metricTile('Ortalama R', m.avgR == null ? '—' : fmtSigned(m.avgR, 2, 'R'), 'İşlem başına, komisyon dahil'),
        metricTile('Max drawdown', m.maxDrawdownPct > 0 ? '−' + fmtNum(m.maxDrawdownPct, 2) + '%' : '0%', 'Tepe noktasından en büyük düşüş'),
        metricTile('Sharpe', m.sharpe == null ? '—' : fmtNum(m.sharpe, 2), 'Yıllık · günlük getiriler · rf = 0'),
        metricTile('En uzun kayıp serisi', fmtNum(m.maxLosingStreak, 0), 'Ardışık zararlı işlem'),
        metricTile('Toplam komisyon', fmtNum(m.totalFees, 2), 'USDT'),
        metricTile('Ortalama süre', m.avgBars == null ? '—' : fmtNum(m.avgBars, 1) + ' mum', m.avgBars == null ? null : '≈ ' + fmtDuration(m.avgBars * tf.ms)),
        metricTile('Sinyal / atlanan', m.signalCount + ' / ' + m.skippedCount, 'Açık pozisyon veya marj nedeniyle atlanan')
      );

      renderEquity();
      const sel = $('trade-coin');
      sel.replaceChildren(...insts.map((i) => h('option', { value: i }, i.replace('-', '/'))));
      const firstWithTrades = insts.find((i) => result.trades.some((t) => t.inst === i)) || insts[0];
      sel.value = firstWithTrades;
      sel.onchange = () => renderTradeChart(sel.value);
      renderTradeChart(firstWithTrades);
      renderInstTable();
      renderTrades();
    }

    let equityChart = null;
    function renderEquity() {
      const box = $('equity-chart');
      const legendEl = $('equity-legend');
      if (equityChart) disposeChart(equityChart);
      equityChart = null;
      box.replaceChildren();
      if (!hasCharts()) return chartUnavailable(box);
      const LW = window.LightweightCharts;
      const { result, v } = last;
      const chart = createChart(box);
      equityChart = chart;
      const eq = chart.addSeries(LW.AreaSeries, {
        lineColor: C.accent,
        topColor: 'rgba(57,135,229,0.28)',
        bottomColor: 'rgba(57,135,229,0.02)',
        lineWidth: 2,
        priceLineVisible: false,
        priceFormat: priceFmt(2),
      });
      eq.setData(result.equity.map((p) => ({ time: sec(p.time), value: p.value })));
      eq.createPriceLine({ price: v.bt.initialCapital, color: C.muted, lineWidth: 1, lineStyle: LW.LineStyle.Dashed, axisLabelVisible: true, title: 'Başlangıç' });
      const dd = chart.addSeries(
        LW.BaselineSeries,
        {
          baseValue: { type: 'price', price: 0 },
          topLineColor: C.sell,
          topFillColor1: 'rgba(0,0,0,0)',
          topFillColor2: 'rgba(0,0,0,0)',
          bottomLineColor: C.sell,
          bottomFillColor1: 'rgba(239,83,80,0.08)',
          bottomFillColor2: 'rgba(239,83,80,0.4)',
          lineWidth: 1,
          priceLineVisible: false,
          priceFormat: { type: 'custom', minMove: 0.01, formatter: (p) => nf(1).format(p) + '%' },
          autoscaleInfoProvider: (orig) => {
            const r = orig();
            if (r && r.priceRange) r.priceRange.maxValue = 0;
            return r;
          },
        },
        1
      );
      dd.setData(result.drawdown.map((p) => ({ time: sec(p.time), value: p.value })));
      const panes = chart.panes();
      if (panes[0] && panes[0].setStretchFactor) panes[0].setStretchFactor(3);
      if (panes[1] && panes[1].setStretchFactor) panes[1].setStretchFactor(1);
      applyRange(chart, (ts) => ts.fitContent());

      const lastEq = result.equity[result.equity.length - 1];
      const legend = (t, e, d) =>
        legendEl.replaceChildren(
          h('span', { class: 'li' }, fmtTime(t * 1000)),
          h('span', { class: 'li' }, h('span', { class: 'swatch', style: 'background:' + C.accent }), 'Sermaye ', h('b', null, fmtNum(e, 2)), ' USDT'),
          isNum(d) ? h('span', { class: 'li' }, h('span', { class: 'swatch', style: 'background:' + C.sell }), 'Düşüş ', h('b', null, fmtPct(d))) : null
        );
      const setDefault = () => lastEq && legend(sec(lastEq.time), lastEq.value, result.drawdown[result.drawdown.length - 1].value);
      setDefault();
      chart.subscribeCrosshairMove((param) => {
        const e = param && param.time != null ? param.seriesData.get(eq) : null;
        if (!e) return setDefault();
        const d = param.seriesData.get(dd);
        legend(param.time, e.value, d && d.value);
      });
    }

    let tradeChart = null; // {pc, inst, offset}
    const RESULT_LABEL = { TP1: 'TP1', TP2: 'TP2', SL: 'Stop', BE: 'Başa baş', END: 'Test sonu' };
    const resultText = (r) => r.split('+').map((x) => RESULT_LABEL[x] || x).join(' + ');
    const exitColor = (reason) => (reason === 'SL' ? C.bad : reason === 'BE' || reason === 'END' ? C.warn : C.good);

    function renderTradeChart(inst) {
      const box = $('trade-chart');
      const legendEl = $('trade-legend');
      if (tradeChart) tradeChart.pc.destroy();
      tradeChart = null;
      box.replaceChildren();
      legendEl.replaceChildren();
      if (!hasCharts()) return chartUnavailable(box);
      const { result, series, startMs, v } = last;
      const all = series[inst];
      const res = result.strategyResults[inst];
      // Isınma mumlarının yalnızca son 100 tanesini göster
      let first = all.findIndex((c) => c.time >= startMs);
      if (first < 0) first = 0;
      const offset = Math.max(0, first - 100);
      const pc = buildPriceChart(box, legendEl, {
        inst,
        candles: all.slice(offset),
        live: null,
        rsi: res.rsi.slice(offset),
        ema: res.ema.slice(offset),
        params: res.params,
        showEma: v.st.useEmaFilter,
      });
      tradeChart = { pc, inst, offset };

      const trades = result.trades.filter((t) => t.inst === inst);
      const markers = [];
      for (const t of trades) {
        const buy = t.side === 'BUY';
        markers.push({
          time: sec(t.entryTime),
          position: buy ? 'belowBar' : 'aboveBar',
          shape: buy ? 'arrowUp' : 'arrowDown',
          color: buy ? C.buy : C.sell,
          text: '#' + t.no,
        });
        const byTime = new Map();
        for (const f of t.fills) {
          const g = byTime.get(f.time) || { time: f.time, price: f.price, reasons: [] };
          g.reasons.push(f.reason);
          g.price = f.price;
          byTime.set(f.time, g);
        }
        for (const g of byTime.values()) {
          const lastReason = g.reasons[g.reasons.length - 1];
          markers.push({
            time: sec(g.time),
            position: 'atPriceMiddle',
            price: g.price,
            shape: 'circle',
            color: exitColor(lastReason),
            text: g.reasons.map((r) => RESULT_LABEL[r] || r).join('+'),
          });
        }
      }
      pc.setMarkers(markers);
      // İşlem yapılan uyumsuzlukların çizgileri
      const traded = new Set(trades.map((t) => t.signalId));
      pc.addDivergenceLines(res.signals.filter((s) => traded.has(s.id)), null);
      applyRange(pc.chart, (ts) => ts.fitContent());
    }

    function focusTrade(t) {
      const sel = $('trade-coin');
      if (!tradeChart || tradeChart.inst !== t.inst) {
        sel.value = t.inst;
        renderTradeChart(t.inst);
      }
      if (!tradeChart) return;
      tradeChart.pc.setLevels({ entry: t.entryPrice, sl: t.sl, tp1: t.tp1, tp2: t.tp2 });
      const a = t.entryIndex - tradeChart.offset;
      const b = t.exitIndex - tradeChart.offset;
      const pad = Math.max(20, Math.round((b - a) * 0.6));
      applyRange(tradeChart.pc.chart, (ts) => ts.setVisibleLogicalRange({ from: a - pad, to: b + pad }));
      $('trade-chart').scrollIntoView({ behavior: 'smooth', block: 'center' });
      document.querySelectorAll('#trades-body tr.selected').forEach((r) => r.classList.remove('selected'));
      const tr = document.querySelector('#trades-body tr[data-no="' + t.no + '"]');
      if (tr) tr.classList.add('selected');
    }

    function renderInstTable() {
      const { result } = last;
      $('inst-body').replaceChildren(
        ...result.perInst.map((p) =>
          h(
            'tr',
            null,
            h('td', null, h('b', null, p.inst.replace('-', '/'))),
            h('td', { class: 'num' }, fmtNum(p.trades, 0)),
            h('td', { class: 'num' }, p.winRate == null ? '—' : fmtNum(p.winRate, 1) + '%'),
            h('td', { class: 'num' }, fmtSigned(p.pnl, 2)),
            h('td', { class: 'num' }, p.profitFactor === Infinity ? '∞' : fmtNum(p.profitFactor, 2)),
            h('td', { class: 'num' }, p.avgR == null ? '—' : fmtSigned(p.avgR, 2, 'R')),
            h('td', { class: 'num' }, fmtPct(p.buyHoldPct))
          )
        )
      );
    }

    const MAX_ROWS = 1000;
    function renderTrades() {
      const { result } = last;
      const trades = result.trades;
      const shown = trades.slice(0, MAX_ROWS);
      const body = $('trades-body');
      body.replaceChildren(
        ...(shown.length
          ? shown.map((t) => {
              const reasons = t.result.split('+');
              const lastReason = reasons[reasons.length - 1];
              const cls = lastReason === 'SL' ? 'st-bad' : lastReason === 'BE' ? 'st-warn' : lastReason === 'END' ? 'st-wait' : 'st-good';
              const ic = lastReason === 'SL' ? '✕' : lastReason === 'BE' ? '=' : lastReason === 'END' ? '■' : '✓';
              return h(
                'tr',
                { class: 'clickable', tabindex: '0', 'data-no': String(t.no), title: 'Grafikte göster' },
                h('td', { class: 'num' }, String(t.no)),
                h('td', null, h('b', null, t.inst.replace('-' + CONFIG.QUOTE, ''))),
                h('td', null, sideBadge(t.side, t.kind)),
                h('td', null, fmtShort(t.entryTime)),
                h('td', { class: 'num' }, fmtPrice(t.inst, t.entryPrice)),
                h('td', { class: 'num' }, fmtPrice(t.inst, t.sl)),
                h('td', { class: 'num' }, fmtPrice(t.inst, t.tp1)),
                h('td', { class: 'num' }, fmtPrice(t.inst, t.tp2)),
                h('td', null, fmtShort(t.exitTime)),
                h('td', { class: 'num' }, fmtPrice(t.inst, t.exitPrice)),
                h('td', null, h('span', { class: 'status ' + cls }, h('span', { class: 'ic', 'aria-hidden': 'true' }, ic), resultText(t.result))),
                h(
                  'td',
                  { class: 'num' },
                  h('span', { style: 'color:' + (t.pnl >= 0 ? C.buy : C.sell), 'aria-hidden': 'true' }, t.pnl >= 0 ? '▲ ' : '▼ '),
                  fmtSigned(t.pnl, 2)
                ),
                h('td', { class: 'num' }, fmtSigned(t.r, 2)),
                h('td', { class: 'num' }, String(t.score))
              );
            })
          : [h('tr', null, h('td', { colspan: '14', class: 'table-empty' }, 'Bu ayarlarla hiç işlem oluşmadı. Aralığı genişletmeyi veya filtreleri gevşetmeyi deneyin.'))])
      );
      $('trades-count').textContent =
        trades.length + ' işlem' + (trades.length > MAX_ROWS ? ' · ilk ' + MAX_ROWS + ' tanesi gösteriliyor, tamamı CSV’de' : '');
      $('trades-foot').textContent =
        'Giriş: onay mumundan sonraki mumun açılışı (aleyhe slippage ile) · Aynı mumda hem TP hem SL görülürse SL kabul edilir · Zamanlar yerel saat';
    }

    const tradesBody = $('trades-body');
    const pickTrade = (e) => {
      const tr = e.target.closest('tr[data-no]');
      if (!tr || !last) return;
      const t = last.result.trades[Number(tr.dataset.no) - 1];
      if (t) focusTrade(t);
    };
    tradesBody.addEventListener('click', pickTrade);
    tradesBody.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        pickTrade(e);
      }
    });

    // ------------------------------------------------------------ CSV
    const csvCell = (v) => {
      if (v == null) return '';
      if (typeof v === 'number') return Number.isFinite(v) ? String(Number(v.toPrecision(12))) : '';
      const s = String(v);
      return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const isoMin = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 16);

    $('csv-btn').addEventListener('click', () => {
      if (!last) return;
      const { result, v, tf } = last;
      const header = [
        'No', 'Coin', 'Yön', 'Tür', 'Skor', 'Sinyal zamanı (UTC)', 'Giriş zamanı (UTC)', 'Giriş', 'SL', 'TP1', 'TP2',
        'Adet', 'Pozisyon (USDT)', 'Çıkış zamanı (UTC)', 'Ortalama çıkış', 'Sonuç', 'PnL (USDT)', 'PnL (%)', 'R',
        'Komisyon (USDT)', 'Süre (mum)',
      ];
      const rows = result.trades.map((t) => [
        t.no, t.inst, t.side, t.kind === 'hidden' ? 'gizli' : 'normal', t.score, isoMin(t.signalTime), isoMin(t.entryTime),
        t.entryPrice, t.sl, t.tp1, t.tp2, t.qty, t.notional, isoMin(t.exitTime), t.exitPrice, t.result, t.pnl, t.pnlPct, t.r,
        t.fees, t.bars,
      ]);
      const csv = '﻿' + [header].concat(rows).map((r) => r.map(csvCell).join(',')).join('\r\n');
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const name = 'backtest_' + v.coins.join('-') + '_' + tf.id + '_' + v.start + '_' + v.end + '.csv';
      const a = h('a', { href: url, download: name });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    });

    // ------------------------------------------------------------ başlat
    (async () => {
      const info = await OKX.init();
      describeSource(info);
      updateEstimate();
      try {
        const chk = await OKX.checkListings(CONFIG.COINS);
        INSTRUMENTS = chk.instruments;
        const bad = new Set(chk.missing.concat(chk.inactive.map((x) => x.instId)));
        coinBoxes().forEach((b) => {
          if (bad.has(OKX.instId(b.value))) {
            b.checked = false;
            b.disabled = true;
            b.parentElement.title = 'OKX’te listelenmiyor veya işleme kapalı';
          }
        });
        if (bad.size) showAlert('listing', 'warn', 'OKX’te bulunamayan veya işleme kapalı çiftler devre dışı: ' + Array.from(bad).join(', '));
      } catch (err) {
        showAlert('listing', 'warn', 'OKX enstrüman listesi alınamadı (' + err.message + ').');
      }
      updateEstimate();
    })();

    window.UI = { run, get last() { return last; } };
  }

  // =====================================================================
  function boot() {
    fillConfigText();
    wireOkxEvents();
    const page = document.body.dataset.page;
    if (page === 'signals') initSignalsPage();
    else if (page === 'backtest') initBacktestPage();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
