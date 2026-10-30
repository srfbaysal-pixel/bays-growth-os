import { test, expect, type Page } from '@playwright/test';

async function login(page: Page, email = 'owner@test.invalid', password = 'owner-password-123') {
  await page.goto('/login');
  await page.getByLabel('E-posta').fill(email);
  await page.getByLabel('Parola').fill(password);
  await page.getByRole('button', { name: 'Giriş yap' }).click();
  await expect(page).toHaveURL(/\/dashboard/);
}

test('oturumsuz kullanıcı girişe yönlendirilir', async ({ page }) => {
  await page.goto('/leads');
  await expect(page).toHaveURL(/\/login\?next=%2Fleads/);
});

test('hatalı parola hata gösterir', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('E-posta').fill('owner@test.invalid');
  await page.getByLabel('Parola').fill('yanlis-parola-123');
  await page.getByRole('button', { name: 'Giriş yap' }).click();
  await expect(page.locator('form [role="alert"]')).toContainText(/hatalı/i);
});

test('PWA manifest ve service worker dosyaları sunulur', async ({ request }) => {
  const m = await request.get('/manifest.webmanifest');
  expect(m.ok()).toBeTruthy();
  const json = await m.json();
  expect(json.display).toBe('standalone');
  expect(json.icons.length).toBeGreaterThanOrEqual(2);
  expect((await request.get('/sw.js')).ok()).toBeTruthy();
  expect((await request.get('/icons/icon-192.png')).ok()).toBeTruthy();
});

test('özet, leadler, lead detayı, onay akışı, satış, gelir ve sistem sayfaları', async ({ page, isMobile }) => {
  await login(page);
  await expect(page.getByText('TEST MODU', { exact: true })).toBeVisible();
  await expect(page.getByText(/Bugün \(/)).toBeVisible();
  await expect(page.getByText('Yeni lead')).toBeVisible();
  if (isMobile) await expect(page.getByRole('navigation', { name: 'Ana gezinme' })).toBeVisible();

  await page.goto('/leads');
  await expect(page.getByText(/kayıt$/)).toBeVisible();
  const first = page.locator('a.card').first();
  await expect(first).toBeVisible();
  await first.click();
  await expect(page.getByText('Puan dökümü')).toBeVisible();
  await expect(page.getByText('Doğrulanmış gözlemler')).toBeVisible();
  await expect(page.getByText('AI çıkarımları (doğrulanmamış)')).toBeVisible();

  await page.goto('/approvals');
  const card = page.locator('.card').filter({ has: page.getByRole('button', { name: 'Onayla' }) }).first();
  await expect(card).toBeVisible();
  await card.getByRole('button', { name: 'Onayla' }).click();
  await expect(card.getByText(/Manuel iletişim görevi açıldı|kuyruğuna alındı/)).toBeVisible();

  await page.goto('/conversations');
  await expect(page.getByRole('button', { name: /Görevler/ })).toBeVisible();
  await expect(page.locator('.card').first()).toBeVisible();

  await page.goto('/revenue');
  await expect(page.getByText('MRR', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('Sektör performansı')).toBeVisible();

  await page.goto('/health');
  await expect(page.getByText('Veritabanı')).toBeVisible();
  await expect(page.getByText('wf1_discovery')).toBeVisible();
  await expect(page.getByText('Entegrasyonlar')).toBeVisible();
});

test('viewer onay butonlarını görür ama sunucu reddeder', async ({ page }) => {
  await login(page, 'viewer@test.invalid', 'viewer-password-123');
  await page.goto('/approvals');
  const card = page.locator('.card').filter({ has: page.getByRole('button', { name: 'Reddet' }) }).first();
  await expect(card).toBeVisible();
  page.once('dialog', (d) => d.accept('test'));
  await card.getByRole('button', { name: 'Reddet' }).click();
  await expect(card.getByText(/Yetki yok/)).toBeVisible();
});
