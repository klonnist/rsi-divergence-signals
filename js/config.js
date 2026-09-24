/**
 * config.js — Sitenin tüm ayarları bu dosyada.
 *
 * Coin listesini, zaman dilimlerini, strateji parametrelerini, backtest
 * varsayılanlarını ve veri kaynağını buradan değiştirebilirsiniz. Build adımı
 * yoktur: dosyayı kaydedip commit/push etmeniz yeterli.
 *
 * Bu dosya hem tarayıcıda (window.CONFIG) hem de Node'da
 * (require('./js/config.js')) çalışır; GitHub Actions veri betiği de
 * aynı ayarları okur.
 */
(function (root) {
  'use strict';

  const MIN = 60 * 1000;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;

  const CONFIG = {
    // ------------------------------------------------------------------
    // VERİ KAYNAĞI
    //  'direct' → Tarayıcı OKX API'den doğrudan çeker (OKX CORS'a izin veriyor).
    //  'static' → GitHub Actions'ın (fetch-data.yml) her 15 dakikada ürettiği
    //             data/*.json dosyaları okunur. Bu modda workflow'u Actions
    //             sekmesinden etkinleştirmeyi unutmayın.
    //  'auto'   → Önce doğrudan dener; OKX'e ulaşılamazsa data/ dosyalarına düşer.
    // Test için adrese ?source=static | direct | auto ekleyerek geçici olarak
    // değiştirebilirsiniz.
    // ------------------------------------------------------------------
    DATA_SOURCE: 'direct',
    STATIC_DATA_PATH: 'data',
    OKX_BASE_URL: 'https://www.okx.com',

    // Sayfa altındaki "Kaynak kod" bağlantısı
    REPO_URL: 'https://github.com/klonnist/rsi-divergence-signals',

    // ------------------------------------------------------------------
    // COİNLER — USDT spot çiftleri (OKX instId: <COIN>-USDT)
    // ------------------------------------------------------------------
    QUOTE: 'USDT',
    COINS: ['BTC', 'ETH', 'XRP', 'AVAX', 'SOL', 'BNB', 'DOGE', 'ADA', 'LINK', 'DOT', 'LTC', 'TRX', 'TON', 'NEAR', 'SUI'],

    // ------------------------------------------------------------------
    // ZAMAN DİLİMLERİ
    //  okxBar: OKX'in bar parametresi. OKX'in '1D' mumu Hong Kong saatine
    //  (UTC+8) göre açılır; burada UTC gece yarısında açılan '1Dutc' kullanılır.
    //  refreshMs: sinyal panelinde otomatik yenileme aralığı.
    // ------------------------------------------------------------------
    TIMEFRAMES: [
      { id: '15m', label: '15m', okxBar: '15m', ms: 15 * MIN, refreshMs: 1 * MIN },
      { id: '4H', label: '4H', okxBar: '4H', ms: 4 * HOUR, refreshMs: 5 * MIN },
      { id: '1D', label: '1D', okxBar: '1Dutc', ms: DAY, refreshMs: 15 * MIN },
    ],

    // Sinyal panelinde her coin/TF için yüklenecek mum sayısı. EMA 200'ün
    // oturması için 200'ün epey üzerinde tutulur (/market/candles son 1440
    // muma kadar sayfalanabilir).
    SIGNAL_CANDLES: 600,
    TICKER_REFRESH_MS: 1 * MIN,

    // ------------------------------------------------------------------
    // OKX İSTEK AYARLARI
    // Limitler (IP başına): candles 40 istek/2 sn, history-candles 20 istek/2 sn.
    // Aşağıdaki aralıklar bu limitlerin güvenli biçimde altında kalır.
    // ------------------------------------------------------------------
    CANDLES_LIMIT: 300, // /market/candles istek başına mum (OKX üst sınırı 300)
    HISTORY_LIMIT: 100, // /market/history-candles istek başına mum
    RATE_LIMIT_MS: { candles: 70, history: 120, other: 110 },
    MAX_RETRIES: 4, // hata başına yeniden deneme (üstel bekleme: 1, 2, 4, 8 sn)
    REQUEST_TIMEOUT_MS: 15000,

    // ------------------------------------------------------------------
    // STRATEJİ — sinyal paneli ve backtest AYNI parametrelerle başlar
    // ------------------------------------------------------------------
    STRATEGY: {
      rsiPeriod: 14, // RSI (Wilder) periyodu
      pivotLeft: 5, // pivot için soldaki mum sayısı
      pivotRight: 5, // pivot için sağdaki mum sayısı (onay gecikmesi)
      minBars: 5, // iki pivot arası en az mum
      maxBars: 60, // iki pivot arası en çok mum
      bullRsiMax: 40, // pozitif uyumsuzlukta ikinci dipte RSI bu değerin ALTINDA olmalı
      bearRsiMin: 60, // negatif uyumsuzlukta ikinci tepede RSI bu değerin ÜSTÜNDE olmalı
      // RSI tepesi/dibi: fiyat pivotunun ±rsiWindow mum çevresindeki en uç RSI değeri.
      // Fitilli pivot mumlarında RSI, fiyattan bir iki mum önce döner; 0 = yalnızca pivot mumu.
      // pivotRight'tan büyük olsa da onay mumunu geçmez (lookahead yok).
      rsiWindow: 2,
      useHidden: false, // gizli uyumsuzlukları da kullan
      useEmaFilter: false, // EMA trend filtresi (BUY yalnızca fiyat > EMA, SELL yalnızca fiyat < EMA)
      emaPeriod: 200,
      atrPeriod: 14,
      atrMult: 0.5, // SL = swing seviyesi ∓ atrMult × ATR
      tp1R: 1.5, // TP1 = giriş ± 1.5 × risk
      tp2R: 3, // TP2 = giriş ± 3 × risk
    },

    // ------------------------------------------------------------------
    // BACKTEST VARSAYILANLARI (backtest sayfasındaki form bu değerlerle açılır)
    // ------------------------------------------------------------------
    BACKTEST: {
      initialCapital: 10000,
      riskPct: 1, // işlem başına sermayenin %'si kadar risk
      commissionPct: 0.1, // her alım/satımda işlem tutarının %'si
      slippagePct: 0.05, // piyasa ve stop emirlerinde aleyhe kayma
      maxLeverage: 3, // açık pozisyonların toplam büyüklüğü ≤ sermaye × bu değer
      exitMode: 'partial', // 'partial' (TP1'de yarısı + SL girişe), 'tp1', 'tp2'
      direction: 'both', // 'both' | 'long' | 'short'
      warmupBars: 600, // göstergelerin oturması için başlangıçtan önce yüklenen mum
      defaultDays: { '15m': 60, '4H': 365, '1D': 3 * 365 },
    },

    // Yedek yöntemde (static) backtest için saklanan geçmiş uzunluğu (gün)
    STATIC_HISTORY_DAYS: { '15m': 60, '4H': 730, '1D': 1825 },
  };

  if (typeof module === 'object' && module.exports) module.exports = CONFIG;
  root.CONFIG = CONFIG;
})(typeof globalThis !== 'undefined' ? globalThis : this);
