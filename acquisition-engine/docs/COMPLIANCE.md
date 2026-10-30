# Uyumluluk notları ve kapılar

Bu belge hukuki görüş değildir; sistemdeki **teknik kapıları** ve canlıya geçmeden önce doğrulanması gereken varsayımları listeler. Kesin olmayan hiçbir varsayım otomatik yetkilendirmeye dönüştürülmemiştir: ilgili bayraklar `false` iken sistem manuel göreve düşer.

## Türkiye — ticari elektronik ileti, İYS, KVKK

- 6563 sayılı Kanun ve Ticari İletişim ve Ticari Elektronik İletiler Hakkında Yönetmelik: ticari elektronik ileti kural olarak **önceden onay** ister; tacir/esnafa yönelik iletilerde istisna uygulanabilir, ancak İYS kaydı ve ret hakkı yükümlülükleri devam eder. Bu istisnanın pilot hedef kitlesine (işletmelerin kurumsal adresleri) uygulanabilirliği **hukuk danışmanıyla doğrulanmalıdır**.
- Kapı: `COMPLIANCE_IYS_VERIFIED=true` + `COMPLIANCE_KVKK_VERIFIED=true` olmadan otomatik gönderim yok.
- Her mesajda ret yolu ("hayır" yanıtı, `List-Unsubscribe`) zorunlu (`validateDraft`).
- Ret → `suppressions` (tüm kanallar), `channel_permissions=opt_out`; bu kayıtlar silinmez.
- KVKK: yalnız kamuya açık işletme iletişim bilgileri toplanır; kişi adı yalnız elle girilirse tutulur. Aydınlatma metni ve veri saklama süreleri hukuk ekibince belirlenmeli; `audit_log` işlem izlerini tutar.

## WhatsApp (Meta)

- İş başlatılan konuşmalar yalnız **onaylı şablon** ile ve **opt-in** ile mümkündür; soğuk tanıtım mesajı politika ihlalidir.
- Sistem: `WHATSAPP_ENABLED=false` varsayılan; `channel_permissions.status='opt_in'` yoksa `manual_task`. Gönderim adaptörü bilinçli olarak eklenmedi; webhook yalnız gelen mesajları işler.

## Instagram ve LinkedIn

- Yetkisiz otomatik DM/mesaj/bağlantı daveti **hiçbir modda** yapılmaz (`decidePolicy` → `manual_task`). Panel, onaylı metni manuel görevle sunar.

## Klinikler (sağlık kuruluşları)

- Tanıtım ve bilgilendirme mevzuata tabidir; indirim/kampanya/referans videosu ve paylaşımı hukuki kontrol olmadan yayınlanmaz (`referral_campaigns.compliance_status='pending'`, yayın engeli testli).
- Sağlık verisi toplanmaz (`CLINIC_HEALTH_DATA_COLLECTION=false`; taslak doğrulayıcı "hasta kaydı/tanı" ifadelerini reddeder).
- AI asistan tanımı: teşhis/tedavi/tıbbi tavsiye yok (`ai_assistant_restrictions`), taslaklarda açıkça belirtilir.

## Google Places verisi

- Places (New) hizmet şartları: sonuçların 30 günden uzun önbelleklenmemesi (place id hariç), Google atfı. Pilot için işletme kayıtları yenilenmeden önce yeniden çekilmeli; panelde Google verisi gösterilirken atıf eklenmesi önerilir.

## Web sitesi tarama

- robots.txt tam yasağına uyulur, 1 istek/sn, tanımlı UA ve iletişim adresi, yalnız ana sayfa + iletişim sayfası, yalnız işletme iletişim bilgileri ve özellik gözlemleri çıkarılır.
