import { expect, test, type Locator, type Page } from '@playwright/test';

const CANVAS_WIDTH = 1200;
const CANVAS_HEIGHT = 720;

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

async function drawLine(page: Page, canvas: Locator, from: { x: number; y: number }, to: { x: number; y: number }) {
  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + from.x, box!.y + from.y);
  await page.mouse.down();
  await page.mouse.move(box!.x + to.x, box!.y + to.y, { steps: 12 });
  await page.mouse.up();
}

async function readCanvasPixel(canvas: Locator, position: { x: number; y: number }) {
  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  return canvas.evaluate((element, point) => {
    const context = (element as HTMLCanvasElement).getContext('2d');
    if (!context) throw new Error('Không thể đọc canvas 2D');
    return Array.from(context.getImageData(point.x, point.y, 1, 1).data);
  }, {
    x: Math.round(position.x / box!.width * CANVAS_WIDTH),
    y: Math.round(position.y / box!.height * CANVAS_HEIGHT),
  });
}

test('tẩy xóa sạch mọi nét bên dưới chỉ trong một lần @critical', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Tiếp tục với tư cách khách' }).click();
  await page.getByRole('textbox', { name: 'Tên hiển thị' }).fill(`Guest Eraser ${Date.now()}`);
  await page.getByRole('button', { name: 'Vào không gian Nét' }).click();
  await expect(page.getByText('kết nối trực tiếp')).toBeVisible();

  await page.getByRole('button', { name: 'Mở canvas' }).click();
  const canvas = page.getByRole('dialog').getByLabel('Vùng vẽ nâng cao');
  const crossing = { x: 360, y: 220 };

  await setRangeValue(page.getByLabel('Độ dày'), 40);
  await drawLine(page, canvas, { x: 160, y: crossing.y }, { x: 560, y: crossing.y });
  await drawLine(page, canvas, { x: 160, y: crossing.y }, { x: 560, y: crossing.y });

  await expect.poll(async () => {
    const [red, green, blue] = await readCanvasPixel(canvas, crossing);
    return blue - Math.max(red, green);
  }).toBeGreaterThan(40);

  await setRangeValue(page.getByLabel('Độ trong suốt'), 10);
  await page.getByRole('button', { name: /Tẩy/ }).click();
  await expect(canvas).toHaveCSS('cursor', 'none');
  const eraserCursor = page.locator('.eraser-size-cursor');
  await setRangeValue(page.getByLabel('Kích thước tẩy'), 8);
  const canvasBox = await canvas.boundingBox();
  expect(canvasBox).not.toBeNull();
  await page.mouse.move(canvasBox!.x + crossing.x, canvasBox!.y + crossing.y);
  await expect(eraserCursor).toHaveAttribute('data-visible', 'true');
  const smallCursorBox = await eraserCursor.boundingBox();
  expect(smallCursorBox).not.toBeNull();

  await setRangeValue(page.getByLabel('Kích thước tẩy'), 40);
  await page.mouse.move(canvasBox!.x + crossing.x, canvasBox!.y + crossing.y);
  const largeCursorBox = await eraserCursor.boundingBox();
  expect(largeCursorBox).not.toBeNull();
  expect(largeCursorBox!.width).toBeGreaterThan(smallCursorBox!.width * 4);
  expect(Math.abs(largeCursorBox!.width - 40 / CANVAS_WIDTH * canvasBox!.width)).toBeLessThan(1);
  expect(Math.abs(largeCursorBox!.x + largeCursorBox!.width / 2 - (canvasBox!.x + crossing.x))).toBeLessThan(2);
  expect(Math.abs(largeCursorBox!.y + largeCursorBox!.height / 2 - (canvasBox!.y + crossing.y))).toBeLessThan(2);

  await drawLine(page, canvas, { x: crossing.x, y: 140 }, { x: crossing.x, y: 300 });

  await expect.poll(async () => {
    const [red, green, blue, alpha] = await readCanvasPixel(canvas, crossing);
    return { red, green, blue, alpha };
  }).toEqual({ red: 255, green: 254, blue: 251, alpha: 255 });

  await page.getByRole('button', { name: /Bút chì/ }).click();
  await expect(page.getByLabel('Độ dày')).toHaveValue('40');
  await page.getByRole('button', { name: /Bút highlight/ }).click();
  await expect(page.getByLabel('Độ dày')).toHaveValue('18');
  await page.getByRole('button', { name: /Tẩy/ }).click();
  await expect(page.getByLabel('Kích thước tẩy')).toHaveValue('40');

  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: /Đóng/ }).click();
  await page.getByRole('button', { name: 'Kết thúc phiên khách' }).click();
  await page.getByRole('button', { name: 'Xoá và kết thúc phiên' }).click();
  await expect(page.getByRole('heading', { name: /Có những điều/ })).toBeVisible();
});
