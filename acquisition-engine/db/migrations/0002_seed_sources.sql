-- Kaynak tanımları (izin verilen / resmî kaynaklar)
INSERT INTO sources(key, name, kind, terms_url, is_allowed, notes) VALUES
  ('google_places', 'Google Places API (New)', 'api', 'https://developers.google.com/maps/documentation/places/web-service/policies', true, 'Yalnızca API ile; sonuçların önbelleklenmesi 30 gün ile sınırlıdır (politikaya bakın).'),
  ('website', 'İşletme web sitesi (kamuya açık)', 'web', NULL, true, 'robots.txt gözetilir, 1 istek/sn, yalnız ana sayfa ve iletişim sayfası.'),
  ('csv_import', 'CSV içe aktarım', 'csv', NULL, true, 'Elle hazırlanan listeler.'),
  ('manual', 'Manuel giriş', 'manual', NULL, true, NULL),
  ('mock', 'Test/mock kaynağı', 'api', NULL, true, 'Gerçek veri değildir; yalnız test.'),
  ('ai_inference', 'AI çıkarımı', 'manual', NULL, true, 'Doğrulanmış gözlem DEĞİLDİR; her zaman kind=inference olarak kaydedilir.')
ON CONFLICT (key) DO NOTHING;
