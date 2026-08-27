import { expect, test } from '@playwright/test';

test('bộ chọn hình mở cạnh toolbar và vẽ được hình thang @critical', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Tiếp tục với tư cách khách' }).click();
  await page.getByRole('textbox', { name: 'Tên hiển thị' }).fill(`Shape E2E ${Date.now()}`);
  await page.getByRole('button', { name: 'Vào không gian Nét' }).click();
  await page.getByRole('button', { name: 'Mở canvas' }).click();

  const shapeButton = page.getByRole('button', { name: /Hình dạng/ });
  await shapeButton.click();
  await expect(shapeButton).toHaveAttribute('aria-expanded', 'true');

  const picker = page.getByRole('dialog', { name: 'Chọn hình dạng' });
  await expect(picker).toBeVisible();
  await expect(picker.getByRole('button', { name: 'Chữ nhật', exact: true })).toBeFocused();
  for (const name of ['Chữ nhật', 'Bo góc', 'Ellipse', 'Tam giác', 'Hình thang', 'Hình thoi', 'Ngôi sao', 'Bong bóng']) {
    await expect(picker.getByRole('button', { name, exact: true })).toBeVisible();
  }

  const shapeBounds = await shapeButton.boundingBox();
  const pickerBounds = await picker.boundingBox();
  expect(shapeBounds).not.toBeNull();
  expect(pickerBounds).not.toBeNull();
  expect(Math.abs(pickerBounds!.x - (shapeBounds!.x + shapeBounds!.width))).toBeLessThan(40);

  await picker.getByRole('button', { name: 'Hình thang', exact: true }).click();
  await expect(picker).toBeHidden();
  await expect(shapeButton).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByText('Hình thang').first()).toBeVisible();

  const canvas = page.getByRole('dialog', { name: 'Studio Nét' }).locator('canvas[aria-label="Vùng vẽ nâng cao"]');
  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + 100, box!.y + 80);
  await page.mouse.down();
  await page.mouse.move(box!.x + 280, box!.y + 200, { steps: 7 });
  await page.mouse.up();
  await expect(page.getByText('1 thao tác')).toBeVisible();

  const purplePixels = await canvas.evaluate((element: HTMLCanvasElement) => {
    const context = element.getContext('2d');
    if (!context) return 0;
    const pixels = context.getImageData(0, 0, element.width, element.height).data;
    let count = 0;
    for (let index = 0; index < pixels.length; index += 4) {
      if (pixels[index + 2] - pixels[index] > 40 && pixels[index + 2] - pixels[index + 1] > 10) count += 1;
    }
    return count;
  });
  expect(purplePixels).toBeGreaterThan(300);

  await shapeButton.click();
  await picker.getByRole('button', { name: 'Ngôi sao', exact: true }).click();
  await expect(page.getByText('Ngôi sao').first()).toBeVisible();

  await page.getByRole('button', { name: /Bút chì/ }).click();
  await shapeButton.click();
  await expect(picker.getByRole('button', { name: 'Ngôi sao', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('v');
  await expect(picker).toBeHidden();
  await expect(shapeButton).toBeFocused();
  await expect(page.getByText('Hình thang').first()).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await shapeButton.scrollIntoViewIfNeeded();
  await shapeButton.click();
  const mobileShapeBounds = await shapeButton.boundingBox();
  const mobilePickerBounds = await picker.boundingBox();
  expect(mobileShapeBounds).not.toBeNull();
  expect(mobilePickerBounds).not.toBeNull();
  expect(mobilePickerBounds!.x).toBeGreaterThanOrEqual(8);
  expect(mobilePickerBounds!.x + mobilePickerBounds!.width).toBeLessThanOrEqual(382);
  expect(mobilePickerBounds!.y).toBeGreaterThan(mobileShapeBounds!.y);
  expect(mobilePickerBounds!.y + mobilePickerBounds!.height).toBeLessThanOrEqual(836);
  await page.keyboard.press('Escape');
  await expect(picker).toBeHidden();
  await expect(shapeButton).toBeFocused();

  await page.setViewportSize({ width: 667, height: 375 });
  await shapeButton.scrollIntoViewIfNeeded();
  await shapeButton.click();
  const landscapeShapeBounds = await shapeButton.boundingBox();
  const landscapePickerBounds = await picker.boundingBox();
  expect(landscapeShapeBounds).not.toBeNull();
  expect(landscapePickerBounds).not.toBeNull();
  expect(landscapePickerBounds!.x).toBeGreaterThanOrEqual(landscapeShapeBounds!.x + landscapeShapeBounds!.width);
  expect(landscapePickerBounds!.y).toBeGreaterThanOrEqual(8);
  expect(landscapePickerBounds!.y + landscapePickerBounds!.height).toBeLessThanOrEqual(375);
  await page.keyboard.press('Escape');

  await page.setViewportSize({ width: 1280, height: 720 });
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: /Đóng/ }).click();
  await expect(page.getByRole('dialog', { name: 'Studio Nét' })).toBeHidden();
  const endResponse = page.waitForResponse((response) => response.url().endsWith('/api/guest') && response.request().method() === 'DELETE');
  await page.getByRole('button', { name: 'Kết thúc phiên khách' }).click();
  expect((await endResponse).status()).toBe(200);
});
