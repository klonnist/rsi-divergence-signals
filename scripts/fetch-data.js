#!/usr/bin/env node
/**
 * scripts/fetch-data.js — YEDEK VERİ YÖNTEMİ
 *
 * Tarayıcı OKX'e doğrudan ulaşamazsa (CORS, ağ engeli vb.) site, bu betiğin
 * ürettiği JSON dosyalarını okur (config.js → DATA_SOURCE: 'static' veya 'auto').
 * GitHub Actions (.github/workflows/fetch-data.yml) betiği 15 dakikada bir
 * çalıştırır ve çıktıyı `data` dalına yazar.
 *
 * Üretilen dosyalar (data/ altında):
 *   instruments.json          → listeleme kontrolü için OKX spot çiftleri
 *   tickers.json              → güncel fiyatlar
 *   latest/<TF>.json          → sinyal paneli için son mumlar (canlı mum dahil)
 *   history/<INST>_<TF>.json  → backtest için kayan pencere geçmişi (artımlı güncellenir)
 *
 * Yerelde çalıştırma: node scripts/fetch-data.js   (Node 18+)
 */
'use strict';

const fs = require('fs');
const path = require('path');
const CONFIG = require('../js/config.js');
const OKX = require('../js/okx.js');

const OUT = path.resolve(__dirname, '..', process.env.DATA_DIR || 'data');
const DAY = 86400000;

OKX.setSource('direct'); // betik her zaman OKX'ten çeker
OKX.onStatus((ev) => {
  if (ev.type === 'retry') console.warn(`  ↻ ${ev.label}: ${ev.error.message} (deneme ${ev.attempt}/${ev.max})`);
});

// Mum satırı: [zaman, açılış, yüksek, düşük, kapanış, hacim] (+ latest dosyalarında kapanış bayrağı 1/0)
const row = (c) => [c.time, c.open, c.high, c.low, c.close, c.volume];

function writeJson(rel, obj) {
  const file = path.join(OUT, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj));
}

function readJson(rel) {
  try {
    return JSON.parse(fs.readFileSync(path.join(OUT, rel), 'utf8'));
  } catch (_) {
    return null;
  }
}

async function main() {
  const t0 = Date.now();
  const updatedAt = Date.now();
  const stats = { ok: 0, failed: 0 };
  console.log('OKX yedek veri güncellemesi →', OUT);

  // 1) Listeleme kontrolü
  const { listed, missing, inactive, instruments } = await OKX.checkListings(CONFIG.COINS);
  if (missing.length) console.warn('  OKX’te bulunamadı:', missing.join(', '));
  if (inactive.length) console.warn('  İşleme kapalı:', inactive.map((x) => x.instId).join(', '));
  const wanted = new Set(CONFIG.COINS.map(OKX.instId));
  writeJson('instruments.json', {
    updatedAt,
    instruments: Array.from(instruments.values()).filter((i) => wanted.has(i.instId)),
  });
  console.log(`  ${listed.length} çift listeleniyor`);

  // 2) Güncel fiyatlar
  try {
    const tickers = await OKX.getTickers();
    const out = {};
    for (const id of listed) {
      const t = tickers.get(id);
      if (t) out[id] = { last: t.last, open24h: t.open24h, ts: t.ts };
    }
    writeJson('tickers.json', { updatedAt, tickers: out });
    stats.ok++;
  } catch (err) {
    stats.failed++;
    console.error('  Fiyatlar alınamadı:', err.message);
  }

  // 3) Sinyal paneli için son mumlar — zaman dilimi başına tek dosya
  for (const tf of CONFIG.TIMEFRAMES) {
    const prev = readJson(`latest/${tf.id}.json`);
    const series = {};
    await Promise.all(
      listed.map(async (id) => {
        try {
          const { candles, live } = await OKX.getRecentCandles(id, tf, CONFIG.SIGNAL_CANDLES);
          series[id] = candles.map((c) => row(c).concat(1)).concat(live ? [row(live).concat(0)] : []);
          stats.ok++;
        } catch (err) {
          stats.failed++;
          console.error(`  ${id} ${tf.label} son mumlar alınamadı: ${err.message}`);
          if (prev && prev.series && prev.series[id]) series[id] = prev.series[id]; // eski veriyi koru
        }
      })
    );
    writeJson(`latest/${tf.id}.json`, { updatedAt, bar: tf.okxBar, series });
    console.log(`  latest/${tf.id}.json yazıldı (${Object.keys(series).length} çift)`);
  }

  // 4) Backtest için geçmiş — kayan pencere, yalnızca eksik mumlar çekilir
  const keep = new Set();
  for (const tf of CONFIG.TIMEFRAMES) {
    const days = (CONFIG.STATIC_HISTORY_DAYS || {})[tf.id] || 365;
    const from = Date.now() - days * DAY;
    await Promise.all(
      listed.map(async (id) => {
        const rel = `history/${id}_${tf.id}.json`;
        keep.add(path.basename(rel));
        const prev = readJson(rel);
        // Pencere büyütüldüyse (ör. 60 → 90 gün) baştan doldur
        const reuse = prev && Array.isArray(prev.candles) && prev.requestedFrom != null && prev.requestedFrom <= from + tf.ms;
        const prevCandles = reuse ? prev.candles.map(OKX.parseCandle) : [];
        const lastTime = prevCandles.length ? prevCandles[prevCandles.length - 1].time : null;
        const start = lastTime != null ? lastTime + 1 : from;
        try {
          const fresh = await OKX.getHistory(id, tf, start, Date.now());
          const merged = OKX.normalize(prevCandles.concat(fresh)).filter((c) => c.time >= from);
          writeJson(rel, {
            updatedAt,
            instId: id,
            bar: tf.okxBar,
            requestedFrom: reuse ? prev.requestedFrom : from,
            from: merged.length ? merged[0].time : null,
            to: merged.length ? merged[merged.length - 1].time : null,
            candles: merged.map(row),
          });
          stats.ok++;
        } catch (err) {
          stats.failed++;
          console.error(`  ${id} ${tf.label} geçmiş alınamadı: ${err.message}`);
        }
      })
    );
    console.log(`  history (${tf.label}, ${days} gün) güncellendi`);
  }

  // Config'den çıkarılan coinlerin eski dosyalarını temizle
  const hdir = path.join(OUT, 'history');
  if (fs.existsSync(hdir)) {
    for (const f of fs.readdirSync(hdir)) if (!keep.has(f)) fs.unlinkSync(path.join(hdir, f));
  }

  writeJson('meta.json', {
    updatedAt,
    durationMs: Date.now() - t0,
    listed,
    missing,
    inactive,
    ok: stats.ok,
    failed: stats.failed,
  });
  console.log(`Bitti: ${stats.ok} başarılı, ${stats.failed} hatalı · ${((Date.now() - t0) / 1000).toFixed(1)} sn`);
  if (stats.ok === 0) process.exitCode = 1; // hiçbir şey alınamadıysa workflow başarısız görünsün
}

main().catch((err) => {
  console.error('Beklenmeyen hata:', err);
  process.exitCode = 1;
});
