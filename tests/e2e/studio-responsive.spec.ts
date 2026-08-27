import { expect, test } from '@playwright/test';

test('Studio không bị cắt ở màn hình ngang thấp và mobile @critical', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 600 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Tiếp tục với tư cách khách' }).click();
  await page.getByRole('textbox', { name: 'Tên hiển thị' }).fill(`Guest Responsive ${Date.now()}`);
  await page.getByRole('button', { name: 'Vào không gian Nét' }).click();
  await expect(page.getByText('kết nối trực tiếp')).toBeVisible();
  await page.getByRole('button', { name: 'Mở canvas' }).click();

  const studio = page.getByRole('dialog', { name: 'Studio Nét' });
  await expect.poll(async () => (await studio.boundingBox())?.y ?? Number.POSITIVE_INFINITY).toBeLessThan(0.5);
  const landscapeBox = await studio.boundingBox();
  expect(landscapeBox).not.toBeNull();
  expect(Math.abs(landscapeBox!.x)).toBeLessThan(0.5);
  expect(Math.abs(landscapeBox!.y)).toBeLessThan(0.5);
  expect(Math.abs(landscapeBox!.width - 900)).toBeLessThan(0.5);
  expect(Math.abs(landscapeBox!.height - 600)).toBeLessThan(0.5);
  await expect(page.getByRole('textbox', { name: 'Lời nhắn cho bản vẽ' })).toBeInViewport();
  await expect(page.getByRole('button', { name: /Chèn chữ/ })).toBeInViewport();

  await page.setViewportSize({ width: 390, height: 844 });
  const mobileBox = await studio.boundingBox();
  expect(mobileBox).not.toBeNull();
  expect(mobileBox!.x).toBe(0);
  expect(mobileBox!.y).toBeGreaterThanOrEqual(0);
  expect(mobileBox!.y + mobileBox!.height).toBeLessThanOrEqual(844);
  await expect(page.getByRole('button', { name: 'Vẽ trước khi gửi', exact: true }).first()).toBeInViewport();
  await expect(page.getByRole('button', { name: 'Vẽ trước khi gửi', exact: true }).first()).toBeDisabled();
  await expect(page.getByRole('textbox', { name: 'Lời nhắn cho bản vẽ' })).toBeInViewport();
  const toolRailShell = page.locator('.tool-rail-shell');
  await expect(toolRailShell).toHaveClass(/has-more/);
  await expect.poll(() => toolRailShell.evaluate((element) => getComputedStyle(element, '::after').content)).toContain('Thêm');
  await page.locator('.tool-rail').evaluate((rail) => { rail.scrollLeft = rail.scrollWidth; rail.dispatchEvent(new Event('scroll')); });
  await expect(toolRailShell).not.toHaveClass(/has-more/);
  await expect(page.getByRole('button', { name: /Chèn chữ/ })).toBeInViewport();

  await page.getByRole('button', { name: /Đóng/ }).click();
  await page.getByRole('button', { name: 'Tìm trong tin nhắn' }).click();
  await expect(page.getByRole('textbox', { name: 'Tìm nội dung tin nhắn' })).toBeVisible();
  await page.getByRole('button', { name: 'Đóng tìm kiếm' }).click();
  await page.getByRole('button', { name: 'Mở danh sách trò chuyện' }).click();
  await page.getByRole('button', { name: 'Kết thúc phiên khách' }).click();
  await page.getByRole('button', { name: 'Kết thúc phiên', exact: true }).click();
  await expect(page.getByRole('heading', { name: /Có những điều/ })).toBeVisible();
});
