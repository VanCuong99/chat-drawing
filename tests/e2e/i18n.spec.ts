import { expect, test } from '@playwright/test';

test('English is the default and the language choice persists across routes and reloads @critical', async ({ page }) => {
  test.setTimeout(60_000);
  await page.context().clearCookies();
  await page.goto('/', { waitUntil: 'domcontentloaded' });

  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.getByRole('heading', { name: /Some things are easier to draw than say/ })).toBeVisible();
  const languageSwitcher = page.getByRole('group', { name: 'Switch language' });
  await expect(languageSwitcher.locator('button[lang="en"]')).toHaveAttribute('aria-pressed', 'true');

  await languageSwitcher.locator('button[lang="vi"]').click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'vi');
  await expect(page.getByRole('heading', { name: /Có những điều vẽ ra dễ hơn nói/ })).toBeVisible();

  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.locator('html')).toHaveAttribute('lang', 'vi');
  await expect(page.getByRole('button', { name: 'Dùng thử không cần tài khoản' })).toBeVisible();

  await page.getByRole('navigation').getByRole('link', { name: 'Đăng nhập', exact: true }).click();
  await expect(page).toHaveURL(/\/auth\/sign-in/);
  await expect(page.getByRole('heading', { name: 'Đăng nhập' })).toBeVisible();
  const authSwitcher = page.locator('.auth-card').getByRole('group', { name: 'Chuyển ngôn ngữ' });
  const authEnglishButton = authSwitcher.locator('button[lang="en"]');
  await expect(authEnglishButton).toBeEnabled({ timeout: 30_000 });
  await authEnglishButton.click();
  await expect.poll(async () => (await page.context().cookies()).find((cookie) => cookie.name === 'net_locale')?.value).toBe('en');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.getByRole('heading', { name: 'Sign In' })).toBeVisible();
});

test('language controls remain touch-safe and do not cause mobile overflow @critical', async ({ page }) => {
  await page.context().clearCookies();
  for (const viewport of [{ width: 390, height: 844 }, { width: 844, height: 390 }]) {
    await page.setViewportSize(viewport);
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    for (const button of await page.locator('.language-switcher button').all()) {
      const box = await button.boundingBox();
      expect(box?.width).toBeGreaterThanOrEqual(44);
      expect(box?.height).toBeGreaterThanOrEqual(44);
    }
    const widths = await page.locator('body').evaluate((body) => ({ client: body.clientWidth, scroll: body.scrollWidth }));
    expect(widths.scroll).toBe(widths.client);
  }
});
