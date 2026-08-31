import { expect, test } from '@playwright/test';
import { setVietnameseUi } from './use-vietnamese-ui';

test.beforeEach(async ({ context }) => setVietnameseUi(context));

test('Studio không bị cắt ở màn hình ngang thấp và mobile @critical', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 600 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Dùng thử không cần tài khoản' }).click();
  await page.getByRole('textbox', { name: 'Tên hiển thị' }).fill(`Guest Responsive ${Date.now()}`);
  await page.getByRole('button', { name: 'Vào Nét' }).click();
  const openCanvas = page.locator('.composer-modes').getByRole('button', { name: 'Vẽ' });
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
  const mobileSend = studio.locator('.studio-header').getByRole('button', { name: 'Gửi', exact: true });
  await expect(mobileSend).toBeInViewport();
  await expect(mobileSend).toBeDisabled();
  await expect(page.getByRole('textbox', { name: 'Lời nhắn cho bản vẽ' })).toBeHidden();
  for (const name of [/Bút chì/, 'Màu và cài đặt công cụ', 'Hoàn tác', 'Thêm vào canvas', 'Công cụ khác']) {
    await expect(studio.locator('.tool-rail').getByRole('button', { name })).toBeInViewport();
  }
  await expect(page.getByRole('button', { name: /Bút highlight/ })).toBeHidden();
  await expect(page.getByRole('button', { name: /Tẩy/ })).toBeHidden();
  await expect(page.getByRole('button', { name: /Hình dạng/ })).toBeHidden();
  await expect(page.getByRole('button', { name: /Chèn chữ/ })).toBeHidden();

  await page.getByRole('button', { name: 'Thêm vào canvas' }).click();
  const addTools = page.getByRole('dialog', { name: 'Thêm vào Canvas' });
  await expect(addTools.getByRole('button', { name: 'Chọn hình dạng' })).toBeVisible();
  await expect(addTools.getByRole('button', { name: 'Chèn chữ' })).toBeVisible();
  await expect(addTools.getByRole('button', { name: 'Thêm lời nhắn' })).toBeVisible();
  await addTools.getByRole('button', { name: 'Thêm lời nhắn' }).click();
  const caption = page.getByRole('textbox', { name: 'Lời nhắn cho bản vẽ' });
  await expect(caption).toBeInViewport();
  const captionBox = await caption.boundingBox();
  const dockBox = await studio.locator('.tool-rail').boundingBox();
  expect(captionBox && dockBox ? captionBox.y + captionBox.height <= dockBox.y : false).toBe(true);
  await page.getByRole('button', { name: 'Đóng ô lời nhắn' }).click();
  await expect(caption).toBeHidden();

  await page.getByRole('button', { name: 'Công cụ khác' }).click();
  const moreTools = page.getByRole('dialog', { name: 'Công cụ khác' });
  await expect(moreTools).toBeVisible();
  await expect(moreTools.getByRole('button', { name: /Bút highlight/ })).toBeVisible();
  await expect(moreTools.getByRole('button', { name: /Tẩy/ })).toBeVisible();
  await expect(moreTools.getByRole('button', { name: /Đường thẳng/ })).toBeVisible();
  await expect(moreTools.getByRole('button', { name: /Mũi tên/ })).toBeVisible();
  await moreTools.getByRole('button', { name: 'Đóng công cụ khác' }).click();
  await page.getByRole('button', { name: 'Màu và cài đặt công cụ' }).click();
  await expect(page.locator('.tool-inspector')).toBeVisible();
  await page.getByRole('button', { name: 'Mở pha màu nâng cao' }).click();
  const mixer = page.getByRole('region', { name: 'Pha màu nâng cao' });
  const mixerBox = await mixer.boundingBox();
  expect(mixerBox).not.toBeNull();
  expect(Math.abs(mixerBox!.x)).toBeLessThan(0.5);
  expect(Math.abs(mixerBox!.y)).toBeLessThan(0.5);
  expect(Math.abs(mixerBox!.width - 390)).toBeLessThan(0.5);
  expect(Math.abs(mixerBox!.height - 844)).toBeLessThan(0.5);
  await expect(mixer.getByRole('button', { name: 'Dùng màu' })).toBeInViewport();
  await expect(mixer.getByText('Lưu vào bảng màu')).toBeInViewport();
  await mixer.getByRole('button', { name: 'Đóng pha màu nâng cao' }).click();
  await page.locator('.tool-inspector').getByRole('button', { name: 'Đóng cài đặt công cụ' }).click();
  await studio.locator('.studio-header').getByRole('button', { name: /Đóng/ }).click();
  await page.getByRole('button', { name: 'Thêm thao tác cuộc trò chuyện' }).click();
  await page.getByRole('button', { name: 'Tìm trong tin nhắn' }).click();
  await expect(page.getByRole('searchbox', { name: 'Tìm nội dung tin nhắn' })).toBeVisible();
  await page.getByRole('button', { name: 'Đóng tìm kiếm' }).click();
  await page.getByRole('button', { name: 'Mở danh sách trò chuyện' }).click();
  await page.getByRole('button', { name: 'Kết thúc phiên khách' }).click();
  await page.getByRole('button', { name: 'Kết thúc phiên', exact: true }).click();
  await expect(page.getByRole('heading', { name: /Có những điều/ })).toBeVisible();
});
