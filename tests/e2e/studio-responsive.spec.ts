import { expect, test } from '@playwright/test';
import { setVietnameseUi } from './use-vietnamese-ui';

test.beforeEach(async ({ context }) => setVietnameseUi(context));

test('Studio không bị cắt ở màn hình ngang thấp và mobile @critical', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 600 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Dùng thử không cần tài khoản' }).click();
  await page.getByRole('textbox', { name: 'Tên hiển thị' }).fill(`Guest Responsive ${Date.now()}`);
  await page.getByRole('button', { name: 'Vào Nét' }).click();
  const openCanvas = page.getByRole('button', { name: 'Mở canvas' });
  await expect(openCanvas).toBeVisible();
  await openCanvas.click();

  const studio = page.getByRole('dialog', { name: 'Nét Studio' });
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
  const mobileSend = page.locator('.studio-footer').getByRole('button', { name: 'Vẽ trước khi gửi', exact: true });
  await expect(mobileSend).toBeInViewport();
  await expect(mobileSend).toBeDisabled();
  await expect(page.locator('.studio-header-send')).toBeHidden();
  await expect(page.getByRole('textbox', { name: 'Lời nhắn cho bản vẽ' })).toBeInViewport();
  for (const name of [/Di chuyển/, /Bút chì/, /Tẩy/, /Hình dạng/, /Chèn chữ/, 'Công cụ khác']) {
    await expect(page.getByRole('button', { name })).toBeInViewport();
  }
  await expect(page.getByRole('button', { name: /Bút highlight/ })).toBeHidden();
  await page.getByRole('button', { name: 'Công cụ khác' }).click();
  const moreTools = page.getByRole('dialog', { name: 'Công cụ khác' });
  await expect(moreTools).toBeVisible();
  await expect(moreTools.getByRole('button', { name: /Bút highlight/ })).toBeVisible();
  await expect(moreTools.getByRole('button', { name: /Đường thẳng/ })).toBeVisible();
  await expect(moreTools.getByRole('button', { name: /Mũi tên/ })).toBeVisible();
  await moreTools.getByRole('button', { name: 'Đóng công cụ khác' }).click();
  await page.getByRole('button', { name: 'Mở pha màu nâng cao' }).click();
  const mixer = page.getByRole('region', { name: 'Pha màu nâng cao' });
  const mixerBox = await mixer.boundingBox();
  expect(mixerBox).not.toBeNull();
  expect(Math.abs(mixerBox!.x)).toBeLessThan(0.5);
  expect(Math.abs(mixerBox!.y)).toBeLessThan(0.5);
  expect(Math.abs(mixerBox!.width - 390)).toBeLessThan(0.5);
  expect(Math.abs(mixerBox!.height - 844)).toBeLessThan(0.5);
  await expect(mixer.getByRole('button', { name: 'Dùng màu' })).toBeInViewport();
  await expect(mixer.getByRole('button', { name: 'Lưu trong phiên' })).toBeInViewport();
  await mixer.getByRole('button', { name: 'Đóng pha màu nâng cao' }).click();

  await page.getByRole('button', { name: /Đóng/ }).click();
  await page.getByRole('button', { name: 'Tìm trong tin nhắn' }).click();
  await expect(page.getByRole('textbox', { name: 'Tìm nội dung tin nhắn' })).toBeVisible();
  await page.getByRole('button', { name: 'Đóng tìm kiếm' }).click();
  await page.getByRole('button', { name: 'Mở danh sách trò chuyện' }).click();
  await page.getByRole('button', { name: 'Kết thúc phiên khách' }).click();
  await page.getByRole('button', { name: 'Kết thúc phiên', exact: true }).click();
  await expect(page.getByRole('heading', { name: /Có những điều/ })).toBeVisible();
});
