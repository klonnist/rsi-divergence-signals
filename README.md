# RSI Uyumsuzluk Radarı

**Canlı site:** https://klonnist.github.io/rsi-divergence-signals/

RSI ile fiyat arasındaki **pozitif (bullish)** ve **negatif (bearish)** uyumsuzlukları tespit edip
**BUY / SELL** önerisi, **giriş**, **stop (SL)** ve **hedef (TP1, TP2)** seviyeleri veren; aynı
stratejiyi geçmiş veriyle test eden tamamen statik bir kripto sinyal ve backtest sitesi.

- HTML + CSS + vanilla JavaScript. **Build adımı yok.**
- Veri: **OKX Public API** (API anahtarı gerekmez), doğrudan tarayıcıdan.
- Grafikler: TradingView **Lightweight Charts** (CDN).
- Yayın: **GitHub Pages** (GitHub Actions ile, testler geçerse).

> ⚠️ **Bu site yatırım tavsiyesi değildir.** Sinyaller geçmiş fiyat verisinden otomatik hesaplanır;
> geçmiş performans gelecekteki sonuçları garanti etmez.

---

## Sayfalar

### 1. Sinyal Paneli (`index.html`)

- 15 coin × 3 zaman dilimi (15m, 4H, 1D) tablosu: Coin, TF, Yön, Giriş, SL, TP1, TP2, R:R, Güç skoru,
  Sinyal zamanı, Güncel fiyat, **Durum**.
- **Durum** sütunu, sinyalden sonraki mumları backtest ile aynı kurallarla işler: *Giriş bekleniyor*,
  *Pozisyonda*, *TP1 alındı · açık*, *TP2 hedefi*, *Başa baş*, *Stop oldu* (gerçekleşen R ile).
- Zaman dilimi, yön ve görünüm filtreleri; sütun başlıklarıyla sıralama (varsayılan: en yeni sinyal).
- Gizli uyumsuzluk ve EMA 200 trend filtresi anahtarları (anında yeniden hesaplanır).
- Otomatik yenileme: 15m her dakika, 4H 5 dakikada, 1D 15 dakikada bir (sekme arka plandayken durur).
- Satıra tıklayınca grafik: mumlar, EMA, altta RSI paneli, uyumsuzluk çizgileri **hem fiyatta hem
  RSI'da**, giriş/SL/TP1/TP2 yatay çizgileri ve "şimdi girilirse R:R".
- Mobilde tablo kart görünümüne geçer.

### 2. Backtest (`backtest.html`)

- Girdiler: coinler (tek/çoklu), zaman dilimi, başlangıç–bitiş tarihi, başlangıç sermayesi, işlem
  başına risk %, komisyon % (varsayılan 0,1), slippage %, maks. kaldıraç, RSI periyodu, pivot sol/sağ,
  pivotlar arası mesafe, RSI eşikleri, ATR çarpanı, TP1/TP2 (R), kâr alma modu, işlem yönü, filtreler.
- Sonuçlar: toplam getiri %, işlem sayısı, kazanma oranı, profit factor, ortalama R, max drawdown,
  Sharpe, en uzun kayıp serisi (+ komisyon, ortalama süre, atlanan sinyal).
- Sermaye eğrisi + drawdown paneli, işlemlerin grafikte işaretlenmesi, coin bazında özet (al-tut
  karşılaştırmalı), işlem tablosu ve **CSV indirme**.
- Uzun aralıklarda **ilerleme çubuğu** ve **İptal** düğmesi. İndirilen veri oturum boyunca önbellekte
  kalır; parametreleri değiştirip tekrar çalıştırmak anında sonuç verir.

---

## Strateji

Sinyal paneli ve backtest **aynı strateji fonksiyonunu** kullanır (`js/signals.js → Strategy.run`,
çıkışlar için `Strategy.stepExit`).

| Adım | Kural |
|---|---|
| RSI | Wilder yöntemi, periyot 14 |
| Pivot | Solda 5, sağda 5 mum. Pivot **ancak sağdaki 5 mum kapandıktan sonra** onaylanır → lookahead yok |
| Pozitif uyumsuzluk (BUY) | Fiyat daha düşük dip, RSI daha yüksek dip; ikinci dipte RSI < 40; iki pivot arası 5–60 mum |
| Negatif uyumsuzluk (SELL) | Fiyat daha yüksek tepe, RSI daha düşük tepe; ikinci tepede RSI > 60 |
| RSI tepesi / dibi | Fiyat pivotunun ±2 mum çevresindeki en yüksek / en düşük RSI (onay mumunu geçmez). RSI kapanışla hesaplandığı için fitilli bir pivot mumunda RSI tepesi bir iki mum önce oluşur; yalnızca pivot mumuna bakmak yanlış uyumsuzluk üretir |
| Gizli uyumsuzluk (isteğe bağlı) | BUY: fiyat yüksek dip + RSI düşük dip · SELL: fiyat düşük tepe + RSI yüksek tepe |
| EMA 200 filtresi (isteğe bağlı) | BUY yalnızca kapanış > EMA, SELL yalnızca kapanış < EMA (onay mumunda) |
| Giriş | Pivot onayından sonraki mumun **açılışı** |
| SL | BUY: son swing low − 0,5 × ATR(14) · SELL: son swing high + 0,5 × ATR(14) |
| TP | R = \|giriş − SL\|; TP1 = 1,5R, TP2 = 3R |
| Güç skoru (0–100) | RSI farkı 40 puan (≥10 RSI puanı tam) + ATR cinsinden fiyat farkı 30 puan (≥2 ATR tam) + EMA trend uyumu 30 puan |

Uyumsuzluk her zaman **ardışık iki pivot** arasında aranır. Kapanmamış mum (`confirm = 0`) sinyal
hesabına katılmaz; yalnızca güncel fiyat ve bekleyen girişin açılış fiyatı için kullanılır. Günlük
mumlar OKX'in `1Dutc` barıyla (UTC 00:00 açılış) çekilir; OKX'in düz `1D` barı UTC+8'e göre açılır.

---

## Ayarları değiştirme — `js/config.js`

Tüm ayarlar tek dosyada. Düzenleyip commit/push etmeniz yeterli; GitHub Actions testleri çalıştırıp
siteyi yeniden yayınlar.

```js
COINS: ['BTC', 'ETH', 'XRP', ...],   // USDT spot çiftleri (OKX instId: COIN-USDT)
TIMEFRAMES: [ { id: '15m', okxBar: '15m', refreshMs: 60000 }, ... ],
STRATEGY: {
  rsiPeriod: 14, pivotLeft: 5, pivotRight: 5, minBars: 5, maxBars: 60,
  bullRsiMax: 40, bearRsiMin: 60, rsiWindow: 2, useHidden: false, useEmaFilter: false,
  emaPeriod: 200, atrPeriod: 14, atrMult: 0.5, tp1R: 1.5, tp2R: 3,
},
BACKTEST: { initialCapital: 10000, riskPct: 1, commissionPct: 0.1, slippagePct: 0.05, maxLeverage: 3, exitMode: 'partial' },
DATA_SOURCE: 'direct',               // 'direct' | 'static' | 'auto'
```

- **Coin eklemek/çıkarmak:** `COINS` listesini düzenleyin. Site açılışta her çiftin OKX'te listelenip
  işlem gördüğünü kontrol eder (`OKX.checkListings`); bulunamayanları uyarıyla atlar.
  *Not: TON-USDT şu an OKX spot'ta listelenmediği için atlanıyor; OKX yeniden listelerse kendiliğinden devreye girer.*
- **Strateji parametreleri:** `STRATEGY` hem panelin hem de backtest formunun varsayılanıdır.
  Sayfadaki açıklama metni de bu değerlerden otomatik doldurulur.
- **Yenileme sıklığı:** `TIMEFRAMES[].refreshMs`.
- Panel ve backtest sayfasındaki filtre/form seçimleri tarayıcınızda (localStorage) hatırlanır.

---

## Veri kaynağı ve yedek yöntem

OKX Public API tarayıcıdan gelen isteklere CORS izni verdiği için site varsayılan olarak veriyi
**doğrudan** çeker (`DATA_SOURCE: 'direct'`). İstekler OKX limitlerinin altında kalacak şekilde
aralıklandırılır; hata olursa üstel beklemeyle yeniden denenir ve anlaşılır bir uyarı gösterilir.

Doğrudan erişim mümkün değilse (ağ engeli vb.) **yedek yöntem** kullanılabilir:

1. `js/config.js` → `DATA_SOURCE: 'static'` (yalnızca yedek veri) veya `'auto'` (önce doğrudan dener,
   olmazsa yedeğe düşer). Commit + push.
2. GitHub → **Actions** → **"OKX verisini güncelle (yedek yöntem)"** → **Enable workflow**, ardından
   güncel veri için **Run workflow**. (Doğrudan mod çalıştığı için bu workflow başlangıçta devre dışı
   bırakıldı; terminalden: `gh workflow enable fetch-data.yml`.)

`.github/workflows/fetch-data.yml` her 15 dakikada `scripts/fetch-data.js`'i çalıştırır, sonuçları
`data/` klasörüne JSON olarak yazar ve **`data` dalına** commit eder, ardından Pages'i yeniden yayınlar.
Site bu dosyaları `data/` yolundan okur. Veri, `main` dalının geçmişini her 15 dakikada şişirmemek
için ayrı dalda **tek commit** olarak tutulur (her çalışmada üzerine yazılır). `DATA_SOURCE: 'direct'`
iken zamanlanmış çalışmalar hiçbir şey yapmadan biter.

Yedek modda backtest, saklanan geçmişle sınırlıdır: 15m son 60 gün, 4H son 730 gün, 1D son 1825 gün
(`STATIC_HISTORY_DAYS`). Denemek için adrese `?source=static` ekleyebilirsiniz.

---

## Backtest kuralları

- Coin başına **aynı anda tek pozisyon**; mumun açılışında pozisyon açıksa o mumdaki yeni sinyal atlanır.
- Giriş onaydan sonraki mumun açılışında, aleyhe slippage ile. Giriş mumunun kendi hareketi de kontrol edilir.
- **Aynı mumda hem TP hem SL görülürse SL kabul edilir.** Mum SL'in ötesinde açılırsa (gap) açılıştan çıkılır.
- Kâr alma modları: **TP1'de yarısını kapat + SL'i girişe çek, kalan TP2** (varsayılan) · tamamı TP1 · tamamı TP2.
  TP1 mumunda kapanış girişin aleyhine ise başa baş stop o mumda tetiklenmiş sayılır.
- Pozisyon büyüklüğü: `(bakiye × risk%) / |giriş − SL|`. Açık pozisyonların toplam büyüklüğü
  `bakiye × maks. kaldıraç`'ı aşamaz (aşarsa pozisyon küçültülür).
- Komisyon her dolumda işlem tutarı üzerinden alınır. Slippage piyasa/stop emirlerine (giriş, SL,
  başa baş, test sonu) uygulanır; TP'ler limit emir kabul edilir.
- SELL sinyalleri açığa satış olarak simüle edilir (vadeli/marjin). Yalnızca spot için **İşlem yönü → Yalnızca BUY** seçin.
- Göstergelerin oturması için başlangıçtan önce 600 mum ısınma verisi yüklenir; işlemler yalnızca seçilen aralıkta açılır.
- Test sonunda açık pozisyonlar son kapanıştan kapatılır.

**Metrikler:** *Ortalama R* = işlem net PnL'i / işlemin başlangıç riski. *Max drawdown*, mum
kapanışlarında açık pozisyonlar dahil piyasa değerli sermaye üzerinden. *Sharpe*, UTC gün sonu
sermayesinden günlük getirilerle, risksiz faiz 0 ve √365 ile yıllıklandırılır. *En uzun kayıp serisi*,
kapanış sırasına göre ardışık zararlı işlem sayısıdır.

---

## Proje yapısı

```
index.html              Sinyal paneli
backtest.html           Backtest sayfası
css/style.css           Koyu tema, mobil uyumlu stiller
js/config.js            Tüm ayarlar
js/okx.js               OKX istemcisi: hız sınırı, yeniden deneme, sayfalama, önbellek, veri kaynağı
js/indicators.js        RSI (Wilder), ATR (Wilder), EMA, SMA
js/divergence.js        Pivot tespiti (lookahead'siz) ve uyumsuzluklar
js/signals.js           ORTAK strateji: sinyal, seviyeler, güç skoru, çıkış kuralları
js/backtest.js          Portföy backtest motoru ve metrikler
js/ui.js                Arayüz, grafikler, otomatik yenileme, CSV
tests/                  node:test birim testleri
scripts/fetch-data.js   Yedek yöntem veri betiği (Node 18+)
.github/workflows/pages.yml       Test + GitHub Pages yayını
.github/workflows/fetch-data.yml  15 dakikada bir yedek veri
```

`indicators.js`, `divergence.js`, `signals.js`, `backtest.js` ve `okx.js` DOM'a dokunmaz; hem
tarayıcıda (`window.X`) hem Node'da (`require`) çalışır.

## Yerelde çalıştırma ve testler

```bash
# Testler (Node 18+)
npm test

# Siteyi yerelde açmak için herhangi bir statik sunucu yeterli:
python -m http.server 8000     # → http://localhost:8000
# veya
npx serve .
```

Testler: RSI'ın referans tabloyla eşleşmesi, ATR/EMA, pivot ve uyumsuzluk kuralları, **lookahead
olmadığı** (kısaltılmış veride üretilen sinyallerin tam veridekilerle aynı olması), SL/TP seviyeleri,
çıkış kuralları (aynı mumda SL önceliği, kısmi TP, gap), backtest muhasebesi (komisyon, slippage,
kaldıraç sınırı, metrikler) ve OKX istemcisi (sahte fetch ile sayfalama, önbellek, iptal edip kaldığı
yerden devam, 429 sonrası yeniden deneme). GitHub Actions her push'ta testleri çalıştırır; geçmezse
site yayınlanmaz.

## Yayınlama

`main` dalına her push'ta `.github/workflows/pages.yml` çalışır: testler → site dosyaları `_site/`'a
kopyalanır → GitHub Pages'e yayınlanır. Pages kaynağı **Settings → Pages → Build and deployment →
Source: GitHub Actions** olmalıdır. Tüm dosya yolları göreceli olduğundan site `/rsi-divergence-signals/`
alt dizininde sorunsuz çalışır.

## Sorun giderme

- **"Sunucuya ulaşılamadı (internet bağlantısı veya CORS engeli)"**: Ağınız okx.com'u engelliyor
  olabilir. Yedek yönteme geçin (`DATA_SOURCE: 'auto'`) ve fetch-data workflow'unu etkinleştirin.
- **"İstek limiti aşıldı (429)"**: Site otomatik olarak bekleyip yeniden dener. Çok sayıda sekme
  açıksa kapatın.
- **Grafik görünmüyor**: Lightweight Charts CDN'den (jsdelivr) yüklenir; engelliyse tablo ve
  hesaplamalar yine çalışır.

---

⚠️ **Bu site yatırım tavsiyesi değildir.** Kripto paralar yüksek risk içerir.
