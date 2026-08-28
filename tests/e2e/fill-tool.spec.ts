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

async function readCanvasColumn(canvas: Locator, x: number, fromY: number, toY: number) {
  return canvas.evaluate((element, sample) => {
    const context = (element as HTMLCanvasElement).getContext('2d');
    if (!context) throw new Error('Không thể đọc canvas 2D');
    const height = sample.toY - sample.fromY + 1;
    const data = context.getImageData(sample.x, sample.fromY, 1, height).data;
    return Array.from({ length: height }, (_, index) => Array.from(data.slice(index * 4, index * 4 + 4)));
  }, { x, fromY, toY });
}

async function readCanvasRow(canvas: Locator, y: number, fromX: number, toX: number) {
  return canvas.evaluate((element, sample) => {
    const context = (element as HTMLCanvasElement).getContext('2d');
    if (!context) throw new Error('Không thể đọc canvas 2D');
    const width = sample.toX - sample.fromX + 1;
    const data = context.getImageData(sample.fromX, sample.y, width, 1).data;
    return Array.from({ length: width }, (_, index) => Array.from(data.slice(index * 4, index * 4 + 4)));
  }, { y, fromX, toX });
}

async function countFillEdgeGaps(canvas: Locator, bounds: { left: number; top: number; width: number; height: number }) {
  return canvas.evaluate((element, area) => {
    const context = (element as HTMLCanvasElement).getContext('2d');
    if (!context) throw new Error('Không thể đọc canvas 2D');
    const data = context.getImageData(area.left, area.top, area.width, area.height).data;
    const colorAt = (x: number, y: number) => {
      const offset = (y * area.width + x) * 4;
      return [data[offset], data[offset + 1], data[offset + 2]];
    };
    const isPaperLike = ([red, green, blue]: number[]) => Math.max(Math.abs(255 - red), Math.abs(254 - green), Math.abs(251 - blue)) < 70;
    const isPinkFill = ([red, green, blue]: number[]) => Math.max(Math.abs(211 - red), Math.abs(77 - green), Math.abs(139 - blue)) < 32;
    const isPurpleOutline = ([red, green, blue]: number[]) => blue - red > 65 && blue - green > 50;
    let gaps = 0;
    for (let y = 1; y < area.height - 1; y += 1) {
      for (let x = 1; x < area.width - 1; x += 1) {
        if (!isPaperLike(colorAt(x, y))) continue;
        const neighbours = [
          colorAt(x - 1, y - 1), colorAt(x, y - 1), colorAt(x + 1, y - 1),
          colorAt(x - 1, y), colorAt(x + 1, y),
          colorAt(x - 1, y + 1), colorAt(x, y + 1), colorAt(x + 1, y + 1),
        ];
        if (neighbours.some(isPinkFill) && neighbours.some(isPurpleOutline)) gaps += 1;
      }
    }
    return gaps;
  }, bounds);
}

async function readCanvasRegionSignature(canvas: Locator, bounds: { left: number; top: number; width: number; height: number }) {
  return canvas.evaluate((element, area) => {
    const context = (element as HTMLCanvasElement).getContext('2d');
    if (!context) throw new Error('Không thể đọc canvas 2D');
    const data = context.getImageData(area.left, area.top, area.width, area.height).data;
    const colors = new Set<string>();
    let minimumLightness = 255;
    let maximumLightness = 0;
    let hash = 2166136261;
    for (let offset = 0; offset < data.length; offset += 4) {
      const red = data[offset];
      const green = data[offset + 1];
      const blue = data[offset + 2];
      colors.add(`${red},${green},${blue}`);
      const lightness = Math.round((red + green + blue) / 3);
      minimumLightness = Math.min(minimumLightness, lightness);
      maximumLightness = Math.max(maximumLightness, lightness);
      hash ^= red | green << 8 | blue << 16;
      hash = Math.imul(hash, 16777619);
    }
    return { uniqueColors: colors.size, lightnessRange: maximumLightness - minimumLightness, hash: hash >>> 0 };
  }, bounds);
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
    top: Math.round((from.y - box!.y) / box!.height * CANVAS_HEIGHT),
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
  await expect.poll(async () => {
    const pixels = await readCanvasColumn(canvas, center.x, center.top - 8, center.top + 24);
    const paperDistance = ([red, green, blue]: number[]) => Math.max(Math.abs(255 - red), Math.abs(254 - green), Math.abs(251 - blue));
    const firstBoundaryPixel = pixels.findIndex((pixel) => paperDistance(pixel) > 90);
    if (firstBoundaryPixel < 0) return -1;
    return pixels.slice(firstBoundaryPixel).filter((pixel) => paperDistance(pixel) < 70).length;
  }, { message: 'Màu tô phải chạm sát nét, không để lại viền màu giấy' }).toBe(0);

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

test('paint bucket phủ kín mép anti-alias của nét vẽ tự do mà không tràn ra ngoài @critical', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Dùng thử không cần tài khoản' }).click();
  await page.getByRole('textbox', { name: 'Tên hiển thị' }).fill(`Guest Fill Edge ${Date.now()}`);
  await page.getByRole('button', { name: 'Vào Nét' }).click();
  await page.getByRole('button', { name: 'Mở canvas' }).click();

  const studio = page.getByRole('dialog', { name: 'Studio Nét' });
  const canvas = studio.getByLabel('Vùng vẽ nâng cao');
  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  const center = { x: 600, y: 360 };
  const radius = 190;
  const screenPoint = (x: number, y: number) => ({
    x: box!.x + x / CANVAS_WIDTH * box!.width,
    y: box!.y + y / CANVAS_HEIGHT * box!.height,
  });

  const start = screenPoint(center.x - radius, center.y);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  // Continue past the start point so the smoothed freehand path overlaps its
  // own endpoint. A mathematically closed pointer path can otherwise retain a
  // sub-pixel gap because the renderer trims the spline at both ends.
  for (let index = 1; index <= 68; index += 1) {
    const angle = Math.PI + index / 64 * Math.PI * 2;
    const point = screenPoint(center.x + Math.cos(angle) * radius, center.y + Math.sin(angle) * radius);
    await page.mouse.move(point.x, point.y);
  }
  await page.mouse.up();

  await studio.getByRole('button', { name: 'Chọn màu #d34d8b' }).click();
  await studio.locator('.tool-rail [data-tool-id="fill"]').click();
  const centerOnScreen = screenPoint(center.x, center.y);
  await page.mouse.click(centerOnScreen.x, centerOnScreen.y);
  await expect(studio.getByText('2 thao tác')).toBeVisible();
  await expect.poll(async () => readCanvasPixel(canvas, center)).toEqual([211, 77, 139, 255]);
  await expect.poll(async () => readCanvasPixel(canvas, { x: center.x - radius - 24, y: center.y })).toEqual([255, 254, 251, 255]);

  await expect.poll(async () => {
    const pixels = await readCanvasRow(canvas, center.y, center.x - radius - 12, center.x);
    const paperDistance = ([red, green, blue]: number[]) => Math.max(Math.abs(255 - red), Math.abs(254 - green), Math.abs(251 - blue));
    const firstBoundaryPixel = pixels.findIndex((pixel) => paperDistance(pixel) > 90);
    if (firstBoundaryPixel < 0) return -1;
    return pixels.slice(firstBoundaryPixel).filter((pixel) => paperDistance(pixel) < 70).length;
  }, { message: 'Nét vẽ tự do không được có viền màu giấy giữa đường bao và vùng tô' }).toBe(0);
  await expect.poll(async () => countFillEdgeGaps(canvas, {
    left: center.x - radius - 16,
    top: center.y - radius - 16,
    width: radius * 2 + 32,
    height: radius * 2 + 32,
  }), { message: 'Không được còn pixel sáng nằm kẹp giữa màu tô và nét vẽ' }).toBe(0);
});

test('màu nước tạo granulation ổn định, đọng viền và vẫn hoàn tác được @critical', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Dùng thử không cần tài khoản' }).click();
  await page.getByRole('textbox', { name: 'Tên hiển thị' }).fill(`Guest Watercolor ${Date.now()}`);
  await page.getByRole('button', { name: 'Vào Nét' }).click();
  await page.getByRole('button', { name: 'Mở canvas' }).click();

  const studio = page.getByRole('dialog', { name: 'Studio Nét' });
  const canvas = studio.getByLabel('Vùng vẽ nâng cao');
  await page.getByRole('button', { name: /Hình dạng/ }).click();
  await page.getByRole('dialog', { name: 'Chọn hình dạng' }).getByRole('button', { name: 'Chữ nhật', exact: true }).click();
  const center = await drawRectangle(page, canvas);
  await studio.getByRole('button', { name: 'Chọn màu #d34d8b' }).click();
  await studio.locator('.tool-rail [data-tool-id="fill"]').click();

  const materialGroup = studio.getByRole('group', { name: 'Chất liệu tô' });
  const watercolor = materialGroup.getByRole('button', { name: /Màu nước/ });
  await expect(watercolor).toBeVisible();
  const watercolorBox = await watercolor.boundingBox();
  expect(watercolorBox?.height).toBeGreaterThanOrEqual(44);
  await watercolor.click();
  await expect(watercolor).toHaveAttribute('aria-pressed', 'true');
  await expect(studio.getByLabel('Độ chất liệu')).toHaveValue('60');

  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  await canvas.click({ position: { x: center.x / CANVAS_WIDTH * box!.width, y: center.y / CANVAS_HEIGHT * box!.height } });
  await expect(studio.getByText('2 thao tác')).toBeVisible();
  const sample = { left: center.x - 50, top: center.y - 40, width: 100, height: 80 };
  await expect.poll(async () => {
    const signature = await readCanvasRegionSignature(canvas, sample);
    return signature.uniqueColors > 12 && signature.lightnessRange > 8;
  }).toBe(true);
  const paintedSignature = await readCanvasRegionSignature(canvas, sample);
  expect(paintedSignature.uniqueColors).toBeGreaterThan(12);
  expect(paintedSignature.lightnessRange).toBeGreaterThan(8);
  await expect.poll(async () => readCanvasPixel(canvas, { x: 60, y: 60 })).toEqual([255, 254, 251, 255]);

  await studio.getByRole('button', { name: 'Hoàn tác' }).click();
  await expect.poll(async () => readCanvasPixel(canvas, center)).toEqual([255, 254, 251, 255]);
  await studio.getByRole('button', { name: 'Làm lại' }).click();
  await expect.poll(async () => readCanvasRegionSignature(canvas, sample)).toEqual(paintedSignature);

  await studio.getByRole('button', { name: 'Hoàn tác' }).click();
  const pencil = materialGroup.getByRole('button', { name: /Chì màu/ });
  await pencil.click();
  await canvas.click({ position: { x: center.x / CANVAS_WIDTH * box!.width, y: center.y / CANVAS_HEIGHT * box!.height } });
  const pencilSignature = await readCanvasRegionSignature(canvas, sample);
  expect(pencilSignature.uniqueColors).toBeGreaterThan(20);
  expect(pencilSignature.lightnessRange).toBeGreaterThan(20);
  expect(pencilSignature.hash).not.toBe(paintedSignature.hash);
  await studio.getByRole('button', { name: 'Hoàn tác' }).click();
  await studio.getByRole('button', { name: 'Làm lại' }).click();
  await expect.poll(async () => readCanvasRegionSignature(canvas, sample)).toEqual(pencilSignature);

  await studio.getByRole('button', { name: 'Hoàn tác' }).click();
  const marker = materialGroup.getByRole('button', { name: /Marker/ });
  await marker.click();
  await canvas.click({ position: { x: center.x / CANVAS_WIDTH * box!.width, y: center.y / CANVAS_HEIGHT * box!.height } });
  const markerSignature = await readCanvasRegionSignature(canvas, sample);
  expect(markerSignature.uniqueColors).toBeGreaterThan(10);
  expect(markerSignature.lightnessRange).toBeGreaterThan(8);
  expect(markerSignature.hash).not.toBe(paintedSignature.hash);
  expect(markerSignature.hash).not.toBe(pencilSignature.hash);
  await studio.getByRole('button', { name: 'Hoàn tác' }).click();
  await studio.getByRole('button', { name: 'Làm lại' }).click();
  await expect.poll(async () => readCanvasRegionSignature(canvas, sample)).toEqual(markerSignature);

  // A material is a glaze, so applying it over a solid fill of the same RGB
  // must still create a new visual action rather than being treated as a no-op.
  await studio.getByRole('button', { name: 'Hoàn tác' }).click();
  const solid = materialGroup.getByRole('button', { name: /Phẳng/ });
  await solid.click();
  await canvas.click({ position: { x: center.x / CANVAS_WIDTH * box!.width, y: center.y / CANVAS_HEIGHT * box!.height } });
  const solidSignature = await readCanvasRegionSignature(canvas, sample);
  await watercolor.click();
  await canvas.click({ position: { x: center.x / CANVAS_WIDTH * box!.width, y: center.y / CANVAS_HEIGHT * box!.height } });
  await expect(studio.getByText('3 thao tác')).toBeVisible();
  const glazedSignature = await readCanvasRegionSignature(canvas, sample);
  expect(glazedSignature.hash).not.toBe(solidSignature.hash);
  await studio.getByRole('button', { name: 'Hoàn tác' }).click();
  await expect.poll(async () => readCanvasRegionSignature(canvas, sample)).toEqual(solidSignature);
  await studio.getByRole('button', { name: 'Làm lại' }).click();
  await expect.poll(async () => readCanvasRegionSignature(canvas, sample)).toEqual(glazedSignature);

  for (const viewport of [{ width: 375, height: 812 }, { width: 844, height: 390 }]) {
    await page.setViewportSize(viewport);
    for (const material of await materialGroup.getByRole('button').all()) {
      const materialBox = await material.boundingBox();
      expect(materialBox?.height).toBeGreaterThanOrEqual(44);
    }
    for (const sliderName of ['Độ chất liệu', 'Độ lan màu']) {
      const sliderBox = await studio.getByLabel(sliderName).boundingBox();
      expect(sliderBox?.height).toBeGreaterThanOrEqual(44);
    }
    const widths = await page.locator('body').evaluate((body) => ({ client: body.clientWidth, scroll: body.scrollWidth }));
    expect(widths.scroll).toBe(widths.client);
  }
});
