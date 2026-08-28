import { expect, test, type Locator, type Page } from '@playwright/test';

const CANVAS_WIDTH = 1200;
const CANVAS_HEIGHT = 720;

test.use({ hasTouch: true });

test.afterEach(async ({ page }) => {
  page.on('dialog', (dialog) => void dialog.accept());
  const studio = page.getByRole('dialog', { name: 'Studio Nét' });
  if (await studio.isVisible().catch(() => false)) await studio.getByRole('button', { name: /Đóng/ }).click().catch(() => undefined);
  const openSidebar = page.getByRole('button', { name: 'Mở danh sách trò chuyện' });
  if (await openSidebar.isVisible().catch(() => false)) await openSidebar.click();
  const endSession = page.getByRole('button', { name: 'Kết thúc phiên khách' });
  if (await endSession.isVisible().catch(() => false)) {
    await expect(endSession).toBeInViewport();
    await endSession.click();
    await page.getByRole('button', { name: 'Kết thúc phiên', exact: true }).click();
  }
});

async function setRangeValue(locator: Locator, value: number) {
  await locator.evaluate((element, nextValue) => {
    const input = element as HTMLInputElement;
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (!setValue) throw new Error('Không thể cập nhật thanh điều chỉnh');
    setValue.call(input, String(nextValue));
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);
  await expect(locator).toHaveValue(String(value));
}

async function readCanvasPixel(canvas: Locator, point: { x: number; y: number }) {
  return canvas.evaluate((element, position) => {
    const context = (element as HTMLCanvasElement).getContext('2d');
    if (!context) throw new Error('Không thể đọc canvas 2D');
    return Array.from(context.getImageData(position.x, position.y, 1, 1).data);
  }, point);
}

async function drawRectangle(page: Page, canvas: Locator) {
  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  const from = { x: box!.x + box!.width * 0.2, y: box!.y + box!.height * 0.2 };
  const to = { x: box!.x + box!.width * 0.62, y: box!.y + box!.height * 0.7 };
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 8 });
  await page.mouse.up();
  return {
    x: Math.round(((from.x + to.x) / 2 - box!.x) / box!.width * CANVAS_WIDTH),
    y: Math.round(((from.y + to.y) / 2 - box!.y) / box!.height * CANVAS_HEIGHT),
  };
}

test('paint bucket tô vùng kín bằng một chạm, hoàn tác được và nằm trong menu mobile @critical', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Dùng thử không cần tài khoản' }).click();
  await page.getByRole('textbox', { name: 'Tên hiển thị' }).fill(`Guest Fill ${Date.now()}`);
  await page.getByRole('button', { name: 'Vào Nét' }).click();
  const openCanvas = page.getByRole('button', { name: 'Mở canvas' });
  await expect(openCanvas).toBeVisible();
  await openCanvas.click();

  const studio = page.getByRole('dialog', { name: 'Studio Nét' });
  const canvas = studio.getByLabel('Vùng vẽ nâng cao');
  await page.getByRole('button', { name: /Hình dạng/ }).click();
  await page.getByRole('dialog', { name: 'Chọn hình dạng' }).getByRole('button', { name: 'Chữ nhật', exact: true }).click();
  const center = await drawRectangle(page, canvas);
  await expect(studio.getByText('1 thao tác')).toBeVisible();

  const fillButton = studio.locator('.tool-rail [data-tool-id="fill"]');
  await expect(fillButton).toBeVisible();
  await fillButton.click();
  await expect(fillButton).toHaveAttribute('aria-pressed', 'true');
  await expect(canvas).toHaveCSS('cursor', /fill\.svg/);
  await expect(studio.getByText('Chạm vùng kín để tô')).toBeVisible();
  await expect(studio.getByLabel('Độ lan màu')).toHaveValue('24');

  const desktopBox = await canvas.boundingBox();
  expect(desktopBox).not.toBeNull();
  await canvas.click({ position: { x: center.x / CANVAS_WIDTH * desktopBox!.width, y: center.y / CANVAS_HEIGHT * desktopBox!.height } });
  await expect(studio.getByText('2 thao tác')).toBeVisible();
  await expect.poll(async () => readCanvasPixel(canvas, center)).toEqual([111, 78, 232, 255]);
  await expect.poll(async () => readCanvasPixel(canvas, { x: 60, y: 60 })).toEqual([255, 254, 251, 255]);

  await studio.getByRole('button', { name: 'Hoàn tác' }).click();
  await expect(studio.getByText('1 thao tác')).toBeVisible();
  await expect.poll(async () => readCanvasPixel(canvas, center)).toEqual([255, 254, 251, 255]);
  await studio.getByRole('button', { name: 'Làm lại' }).click();
  await expect.poll(async () => readCanvasPixel(canvas, center)).toEqual([111, 78, 232, 255]);
  await studio.getByRole('button', { name: 'Hoàn tác' }).click();

  await setRangeValue(studio.getByLabel('Độ lan màu'), 36);
  await setRangeValue(studio.getByLabel('Độ trong suốt'), 50);

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(fillButton).toBeHidden();
  await studio.getByRole('button', { name: 'Công cụ khác' }).click();
  const moreTools = studio.getByRole('dialog', { name: 'Công cụ khác' });
  await expect(moreTools.getByRole('button', { name: /Bút highlight/ })).toBeFocused();
  const mobileFill = moreTools.getByRole('button', { name: /Tô màu/ });
  await expect(mobileFill).toBeVisible();
  const mobileFillBox = await mobileFill.boundingBox();
  expect(mobileFillBox?.width).toBeGreaterThanOrEqual(44);
  expect(mobileFillBox?.height).toBeGreaterThanOrEqual(44);
  await mobileFill.click();
  await expect(canvas).toBeFocused();
  for (const name of ['Độ lan màu', 'Độ trong suốt']) {
    const rangeBox = await studio.getByLabel(name).boundingBox();
    expect(rangeBox?.height).toBeGreaterThanOrEqual(44);
  }

  const mobileCanvasBox = await canvas.boundingBox();
  expect(mobileCanvasBox).not.toBeNull();
  await page.touchscreen.tap(
    mobileCanvasBox!.x + center.x / CANVAS_WIDTH * mobileCanvasBox!.width,
    mobileCanvasBox!.y + center.y / CANVAS_HEIGHT * mobileCanvasBox!.height,
  );
  await expect(studio.getByText('2 thao tác')).toBeVisible();
  await expect.poll(async () => {
    const [red, green, blue, alpha] = await readCanvasPixel(canvas, center);
    return { red, green, blue, alpha };
  }).toEqual({ red: 183, green: 166, blue: 241, alpha: 255 });
  await expect.poll(async () => readCanvasPixel(canvas, { x: 60, y: 60 })).toEqual([255, 254, 251, 255]);
  await expect(studio.getByText(/độ lan 36/)).toBeVisible();

});
