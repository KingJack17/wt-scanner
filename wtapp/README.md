# WT Tarayıcı

WaveTrend (WT alpha) ile listeleri kurar, bu listelerdeki sembollerde kırılım arar. Sonuçları iPhone'da uygulama gibi çalışan bir web sayfasında gösterir. Her şey ücretsiz: tarama GitHub Actions'ta çalışır, uygulama GitHub Pages'ta yayınlanır.

```
GitHub Actions (her gün otomatik)          iPhone (ana ekrandaki uygulama)
 ├─ US / BIST / Kripto verisini indir       ├─ 4 liste: Kısa/Uzun × Oversold/Overbought
 ├─ WT alpha → 4 liste (Aşama 1)            ├─ Kırılım taraması (Aşama 2): göstergeleri
 ├─ SQLite + JSON kaydet                    │   ve parametreleri uygulamadan seç
 └─ GitHub Pages'a yayınla  ───────────►    ├─ Grafik: mumlar, Supertrend/EMA, WT, RSI, MACD
                                            │   ve sinyal okları
                                            └─ WT alpha parametrelerini değiştir → yeniden tarama
```

## Kurulum (bir kere, yaklaşık 10 dk)

1. **Repo oluştur.** github.com'da **New repository** → isim ver (ör. `wt-scanner`) → **Public** seç. Ücretsiz GitHub Pages için repo public olmalı.
2. **Dosyaları yükle.** Mac'te Terminal ile:
   ```bash
   cd wtapp
   git init && git add . && git commit -m "ilk kurulum"
   git branch -M main
   git remote add origin https://github.com/KULLANICI/wt-scanner.git
   git push -u origin main
   ```
   Web arayüzünden yükleyeceksen `.github` klasörünü unutma. Finder'da gizli klasörleri göstermek için Cmd+Shift+. kısayolunu kullan.
3. **Pages'i aç.** Repo → Settings → Pages → Source: **GitHub Actions**.
4. **İlk taramayı başlat.** Repo → Actions → **scan** → **Run workflow** (market: all). İlk tarama 15–30 dk sürer.
5. **iPhone'a ekle.** Safari'de `https://KULLANICI.github.io/wt-scanner/` adresini aç → Paylaş → **Ana Ekrana Ekle**.

### WT alpha parametrelerini uygulamadan değiştirmek için (opsiyonel)
GitHub → Settings → Developer settings → Personal access tokens → **Fine-grained tokens** → Generate new token:
- Repository access: **Only select repositories** → `wt-scanner`
- Permissions: **Contents: Read and write**, **Actions: Read and write**

Token'ı uygulamada Ayarlar → WT alpha bölümüne yapıştır. Token sadece telefonunda saklanır, repoya yazılmaz.

### Telegram bildirimi (opsiyonel)
Repo → Settings → Secrets and variables → Actions → `TELEGRAM_TOKEN` ve `TELEGRAM_CHAT_ID` ekle. Güçlü sinyaller her taramadan sonra Telegram'a gelir.

## Zamanlama
| Piyasa | Saat | Tarar |
|---|---|---|
| US | Hafta içi 21:40 UTC (NY kapanışından sonra) | günlük + haftalık + 4 saatlik |
| US gün içi | Hafta içi NY 11:05 ve 15:05 | 4 saatlik (son bar canlı, henüz kapanmamış) |
| BIST | Hafta içi 16:00 UTC (TR 19:00) | günlük + haftalık |
| Kripto | Her gün 00:15 UTC | günlük + haftalık |

Haftalık listeler sadece hafta kapandığında değişir, çünkü bitmemiş barlar hiçbir zaman kullanılmaz.

## Uygulama
- **Sinyaller:** Seçili piyasadaki tüm zaman dilimlerinin kırılımları tek listede ve puana göre sıralı. **YENİ** = sinyal son barda başladı. Puan (0–100): RSI teyidi, tetikleyici sayısı, WT kesişimi, ±53 derinliği, tazelik.
- **WT Listeleri:** 4S / Günlük / Haftalık × Oversold / Overbought listeleri. WT kesişimi filtresi.
- **İzleme:** Kendi sembollerin. WT bölgesinde olmasalar da taranır. Kaydetmek için GitHub token gerekir (Ayarlar). Liste reponun en üstündeki `my_symbols.json` dosyasına yazılır.
- **Grafik:** Parmağını gezdirince açılış, yüksek, düşük, kapanış ve WT/RSI değerleri görünür.

## Uygulamadaki ayarlar
- **WT alpha (ana gösterge):** n1, n2, sinyal SMA, OS1/OS2/OB1/OB2 bantları, çıkıştan sonra listede tutma süresi. Kaydedince `wt_params.json` güncellenir ve tüm piyasalar yeniden taranır.
- **Kırılım tetikleyicileri:** Supertrend (ATR, çarpan), EMA kesişimi (hızlı/yavaş), MACD kesişimi (12/26/9). "Herhangi biri" veya "hepsi birlikte" seçilebilir. Bir de tetikleyicinin son kaç bar içinde olması gerektiği ayarlanır.
- **RSI teyidi:** Ayırıcı (güçlü/zayıf), zorunlu veya kapalı. Kesişim ya da 50 seviyesi.
- **Yön:** OS listelerinde yükseliş, OB listelerinde düşüş aranır. Devam sinyalleri ayrıca açılabilir.

Kırılım ayarları cihazda anında uygulanır, sunucuya gitmez.

## Grafik
- Büyük ok: güçlü sinyal (tetikleyici + RSI teyidi). Sarı nokta: zayıf sinyal.
- Sinyaller sadece sembol WT bölgesindeyken veya bölgeden çıktıktan sonraki N bar içinde işaretlenir.
- WT panelinde ±45/±55 bantları ve bölgeye giriş noktaları gösterilir.
- Grafik altyapısı TradingView Lightweight Charts™ (Apache 2.0).

## Yerelde çalıştırma
```bash
pip install -r requirements.txt
python scan.py --market us            # gerçek veri
python scan.py --market all --demo    # internetsiz sentetik veri
python tools/build_preview.py         # demo verisiyle tek dosyalık preview.html
```

## Dosyalar
| | |
|---|---|
| `scan.py` | Aşama 1 + Aşama 2 + çıktı |
| `indicators.py` | WaveTrend, Supertrend, EMA, RSI |
| `data.py` | yfinance (US, BIST), ccxt (kripto) |
| `db.py`, `export.py` | SQLite ve uygulama JSON'ları |
| `config.yaml` | Likidite filtreleri, varsayılan kırılım ayarları |
| `wt_params.json` | WT alpha parametreleri (uygulama bu dosyayı günceller) |
| `bist_symbols.txt` | BIST sembol listesi |
| `docs/` | Web uygulaması |
| `tools/scan.yml` | Reponun en üstündeki `.github/workflows/scan.yml` dosyasının güncel hali |
| `my_symbols.json` | İzleme listesi (uygulama reponun en üstündeki kopyayı günceller) |

## Bilinmesi gerekenler
- Veriler Yahoo Finance'ten (resmî olmayan API) ve borsaların açık API'lerinden geliyor. Yahoo zaman zaman GitHub sunucularından gelen istekleri sınırlayabilir. Bir tarama başarısız olursa bir sonraki zamanlanmış çalışma tekrar dener.
- Binance ABD'deki sunuculardan gelen istekleri engeller. Bu durumda kripto verisi otomatik olarak Kraken'den çekilir.
- GitHub, public repolarda 60 gün boyunca hiçbir değişiklik olmazsa zamanlanmış görevleri durdurur. Durursa Actions sekmesinden tek tıkla yeniden açabilirsin.
