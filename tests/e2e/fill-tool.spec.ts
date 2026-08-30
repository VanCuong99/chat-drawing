import { expect, test, type Locator, type Page } from '@playwright/test';

const CANVAS_WIDTH = 1200;
const CANVAS_HEIGHT = 720;

test.use({ hasTouch: true });

test.afterEach(async ({ page }) => {
  page.on('dialog', (dialog) => void dialog.accept());
  const toolSettings = page.getByRole('dialog', { name: /Tool Settings|Cài đặt công cụ/ });
  if (await toolSettings.isVisible().catch(() => false)) {
    await page.locator('.mobile-inspector-dismiss').click({ position: { x: 4, y: 4 } });
    await expect(toolSettings).toBeHidden();
  }
  const studio = page.getByRole('dialog', { name: /Nét Studio|Studio Nét/ });
  if (await studio.isVisible().catch(() => false)) await studio.getByRole('button', { name: /Close|Đóng/ }).click().catch(() => undefined);
  const openSidebar = page.getByRole('button', { name: /Open conversation list|Mở danh sách trò chuyện/ });
  if (await openSidebar.isVisible().catch(() => false)) await openSidebar.click();
  const endSession = page.getByRole('button', { name: /End guest session|Kết thúc phiên khách/ });
  if (await endSession.isVisible().catch(() => false)) {
    await expect(endSession).toBeInViewport();
    await endSession.click();
    await page.getByRole('button', { name: /End Session|Kết thúc phiên/, exact: true }).click();
  }
});

async function setRangeValue(locator: Locator, value: number) {
  await locator.evaluate((element, nextValue) => {
    const input = element as HTMLInputElement;
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (!setValue) throw new Error('Unable to update range control');
    setValue.call(input, String(nextValue));
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);
  await expect(locator).toHaveValue(String(value));
}

async function readCanvasPixel(canvas: Locator, point: { x: number; y: number }) {
  return canvas.evaluate((element, position) => {
    const context = (element as HTMLCanvasElement).getContext('2d');
    if (!context) throw new Error('Unable to read the 2D canvas');
    return Array.from(context.getImageData(position.x, position.y, 1, 1).data);
  }, point);
}

async function readCanvasColumn(canvas: Locator, x: number, fromY: number, toY: number) {
  return canvas.evaluate((element, sample) => {
    const context = (element as HTMLCanvasElement).getContext('2d');
    if (!context) throw new Error('Unable to read the 2D canvas');
    const height = sample.toY - sample.fromY + 1;
    const data = context.getImageData(sample.x, sample.fromY, 1, height).data;
    return Array.from({ length: height }, (_, index) => Array.from(data.slice(index * 4, index * 4 + 4)));
  }, { x, fromY, toY });
}

async function readCanvasRow(canvas: Locator, y: number, fromX: number, toX: number) {
  return canvas.evaluate((element, sample) => {
    const context = (element as HTMLCanvasElement).getContext('2d');
    if (!context) throw new Error('Unable to read the 2D canvas');
    const width = sample.toX - sample.fromX + 1;
    const data = context.getImageData(sample.fromX, sample.y, width, 1).data;
    return Array.from({ length: width }, (_, index) => Array.from(data.slice(index * 4, index * 4 + 4)));
  }, { y, fromX, toX });
}

async function countFillEdgeGaps(canvas: Locator, bounds: { left: number; top: number; width: number; height: number }) {
  return canvas.evaluate((element, area) => {
    const context = (element as HTMLCanvasElement).getContext('2d');
    if (!context) throw new Error('Unable to read the 2D canvas');
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
    if (!context) throw new Error('Unable to read the 2D canvas');
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

test('paint bucket fills a closed region in one tap, supports undo, and remains available on mobile @critical', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Try as a Guest' }).click();
  await page.getByRole('textbox', { name: 'Display Name' }).fill(`Guest Fill ${Date.now()}`);
  await page.getByRole('button', { name: 'Enter Nét' }).click();
  const openCanvas = page.locator('.composer-modes').getByRole('button', { name: 'Draw' });
  await expect(openCanvas).toBeVisible();
  await openCanvas.click();

  const studio = page.getByRole('dialog', { name: 'Nét Studio' });
  const canvas = studio.getByLabel('Advanced drawing area');
  await page.getByRole('button', { name: /Shape/ }).click();
  await page.getByRole('dialog', { name: 'Choose a Shape' }).getByRole('button', { name: 'Rectangle', exact: true }).click();
  const center = await drawRectangle(page, canvas);
  await expect(studio.getByText('1 actions')).toBeVisible();

  const fillButton = studio.locator('.tool-rail [data-tool-id="fill"]');
  await expect(fillButton).toBeVisible();
  await fillButton.click();
  await expect(fillButton).toHaveAttribute('aria-pressed', 'true');
  await expect(canvas).toHaveCSS('cursor', /fill\.svg/);
  await expect(studio.getByText('Tap a closed region to fill')).toBeVisible();
  await expect(studio.getByLabel('Color Tolerance')).toHaveValue('24');

  const desktopBox = await canvas.boundingBox();
  expect(desktopBox).not.toBeNull();
  await canvas.click({ position: { x: center.x / CANVAS_WIDTH * desktopBox!.width, y: center.y / CANVAS_HEIGHT * desktopBox!.height } });
  await expect(studio.getByText('2 actions')).toBeVisible();
  await expect.poll(async () => readCanvasPixel(canvas, center)).toEqual([111, 78, 232, 255]);
  await expect.poll(async () => readCanvasPixel(canvas, { x: 60, y: 60 })).toEqual([255, 254, 251, 255]);
  await expect.poll(async () => {
    const pixels = await readCanvasColumn(canvas, center.x, center.top - 8, center.top + 24);
    const paperDistance = ([red, green, blue]: number[]) => Math.max(Math.abs(255 - red), Math.abs(254 - green), Math.abs(251 - blue));
    const firstBoundaryPixel = pixels.findIndex((pixel) => paperDistance(pixel) > 90);
    if (firstBoundaryPixel < 0) return -1;
    return pixels.slice(firstBoundaryPixel).filter((pixel) => paperDistance(pixel) < 70).length;
  }, { message: 'The fill must reach the outline without leaving a paper-colored halo' }).toBe(0);

  await studio.getByRole('button', { name: 'Undo' }).click();
  await expect(studio.getByText('1 actions')).toBeVisible();
  await expect.poll(async () => readCanvasPixel(canvas, center)).toEqual([255, 254, 251, 255]);
  await studio.getByRole('button', { name: 'Redo' }).click();
  await expect.poll(async () => readCanvasPixel(canvas, center)).toEqual([111, 78, 232, 255]);
  await studio.getByRole('button', { name: 'Undo' }).click();

  await setRangeValue(studio.getByLabel('Color Tolerance'), 36);
  await setRangeValue(studio.getByLabel('Opacity'), 50);

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(fillButton).toBeHidden();
  await studio.getByRole('button', { name: 'More tools' }).click();
  const moreTools = studio.getByRole('dialog', { name: 'More Tools' });
  await expect(moreTools.getByRole('button', { name: /Pan/ })).toBeFocused();
  const mobileFill = moreTools.getByRole('button', { name: /Fill/ });
  await expect(mobileFill).toBeVisible();
  const mobileFillBox = await mobileFill.boundingBox();
  expect(mobileFillBox?.width).toBeGreaterThanOrEqual(44);
  expect(mobileFillBox?.height).toBeGreaterThanOrEqual(44);
  await mobileFill.click();
  const mobileInspector = studio.locator('.tool-inspector');
  await expect(mobileInspector).toBeVisible();
  await expect(mobileInspector.getByRole('button', { name: 'Close tool settings' })).toBeFocused();
  for (const name of ['Color Tolerance', 'Opacity']) {
    const rangeBox = await mobileInspector.getByLabel(name).boundingBox();
    expect(rangeBox?.height).toBeGreaterThanOrEqual(44);
  }
  await mobileInspector.getByRole('button', { name: 'Close tool settings' }).click();
  await expect(studio.getByRole('button', { name: 'More tools' })).toBeFocused();

  const mobileCanvasBox = await canvas.boundingBox();
  expect(mobileCanvasBox).not.toBeNull();
  await page.touchscreen.tap(
    mobileCanvasBox!.x + center.x / CANVAS_WIDTH * mobileCanvasBox!.width,
    mobileCanvasBox!.y + center.y / CANVAS_HEIGHT * mobileCanvasBox!.height,
  );
  await expect(studio.getByRole('button', { name: 'Undo' })).toBeEnabled();
  await expect.poll(async () => {
    const [red, green, blue, alpha] = await readCanvasPixel(canvas, center);
    return { red, green, blue, alpha };
  }).toEqual({ red: 183, green: 166, blue: 241, alpha: 255 });
  await expect.poll(async () => readCanvasPixel(canvas, { x: 60, y: 60 })).toEqual([255, 254, 251, 255]);

});

test('paint bucket seals an anti-aliased freehand edge without leaking outside @critical', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Try as a Guest' }).click();
  await page.getByRole('textbox', { name: 'Display Name' }).fill(`Guest Fill Edge ${Date.now()}`);
  await page.getByRole('button', { name: 'Enter Nét' }).click();
  await page.locator('.composer-modes').getByRole('button', { name: 'Draw' }).click();

  const studio = page.getByRole('dialog', { name: 'Nét Studio' });
  const canvas = studio.getByLabel('Advanced drawing area');
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

  await studio.getByRole('button', { name: 'Choose color #d34d8b' }).click();
  await studio.locator('.tool-rail [data-tool-id="fill"]').click();
  const centerOnScreen = screenPoint(center.x, center.y);
  await page.mouse.click(centerOnScreen.x, centerOnScreen.y);
  await expect(studio.getByText('2 actions')).toBeVisible();
  await expect.poll(async () => readCanvasPixel(canvas, center)).toEqual([211, 77, 139, 255]);
  await expect.poll(async () => readCanvasPixel(canvas, { x: center.x - radius - 24, y: center.y })).toEqual([255, 254, 251, 255]);

  await expect.poll(async () => {
    const pixels = await readCanvasRow(canvas, center.y, center.x - radius - 12, center.x);
    const paperDistance = ([red, green, blue]: number[]) => Math.max(Math.abs(255 - red), Math.abs(254 - green), Math.abs(251 - blue));
    const firstBoundaryPixel = pixels.findIndex((pixel) => paperDistance(pixel) > 90);
    if (firstBoundaryPixel < 0) return -1;
    return pixels.slice(firstBoundaryPixel).filter((pixel) => paperDistance(pixel) < 70).length;
  }, { message: 'A freehand outline must not leave a paper-colored halo around the fill' }).toBe(0);
  await expect.poll(async () => countFillEdgeGaps(canvas, {
    left: center.x - radius - 16,
    top: center.y - radius - 16,
    width: radius * 2 + 32,
    height: radius * 2 + 32,
  }), { message: 'No light pixel may remain trapped between the fill and outline' }).toBe(0);
});

test('natural fill materials render stable grain, edge pooling, water control, and undo @critical', async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto('/');
  await page.getByRole('button', { name: 'Try as a Guest' }).click();
  await page.getByRole('textbox', { name: 'Display Name' }).fill(`Guest Watercolor ${Date.now()}`);
  await page.getByRole('button', { name: 'Enter Nét' }).click();
  await page.locator('.composer-modes').getByRole('button', { name: 'Draw' }).click();

  const studio = page.getByRole('dialog', { name: 'Nét Studio' });
  const canvas = studio.getByLabel('Advanced drawing area');
  await page.getByRole('button', { name: /Shape/ }).click();
  await page.getByRole('dialog', { name: 'Choose a Shape' }).getByRole('button', { name: 'Rectangle', exact: true }).click();
  const center = await drawRectangle(page, canvas);
  await studio.getByRole('button', { name: 'Choose color #d34d8b' }).click();
  await studio.locator('.tool-rail [data-tool-id="fill"]').click();

  const materialGroup = studio.getByRole('group', { name: 'Fill Material' });
  const watercolor = materialGroup.getByRole('button', { name: /Watercolor/ });
  await expect(watercolor).toBeVisible();
  const watercolorBox = await watercolor.boundingBox();
  expect(watercolorBox?.height).toBeGreaterThanOrEqual(44);
  await watercolor.click();
  await expect(watercolor).toHaveAttribute('aria-pressed', 'true');
  await expect(studio.getByLabel('Granulation')).toHaveValue('60');
  await expect(studio.getByLabel('Water')).toHaveValue('45');

  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  await canvas.click({ position: { x: center.x / CANVAS_WIDTH * box!.width, y: center.y / CANVAS_HEIGHT * box!.height } });
  await expect(studio.getByText('2 actions')).toBeVisible();
  const sample = { left: center.x - 50, top: center.y - 40, width: 100, height: 80 };
  await expect.poll(async () => {
    const signature = await readCanvasRegionSignature(canvas, sample);
    return signature.uniqueColors > 12 && signature.lightnessRange > 8;
  }).toBe(true);
  const paintedSignature = await readCanvasRegionSignature(canvas, sample);
  expect(paintedSignature.uniqueColors).toBeGreaterThan(12);
  expect(paintedSignature.lightnessRange).toBeGreaterThan(8);
  await expect.poll(async () => readCanvasPixel(canvas, { x: 60, y: 60 })).toEqual([255, 254, 251, 255]);

  await studio.getByRole('button', { name: 'Undo' }).click();
  await expect.poll(async () => readCanvasPixel(canvas, center)).toEqual([255, 254, 251, 255]);
  await studio.getByRole('button', { name: 'Redo' }).click();
  await expect.poll(async () => readCanvasRegionSignature(canvas, sample)).toEqual(paintedSignature);

  await studio.getByRole('button', { name: 'Undo' }).click();
  const pencil = materialGroup.getByRole('button', { name: /Colored Pencil/ });
  await pencil.click();
  await canvas.click({ position: { x: center.x / CANVAS_WIDTH * box!.width, y: center.y / CANVAS_HEIGHT * box!.height } });
  const pencilSignature = await readCanvasRegionSignature(canvas, sample);
  expect(pencilSignature.uniqueColors).toBeGreaterThan(20);
  expect(pencilSignature.lightnessRange).toBeGreaterThan(20);
  expect(pencilSignature.hash).not.toBe(paintedSignature.hash);
  await studio.getByRole('button', { name: 'Undo' }).click();
  await studio.getByRole('button', { name: 'Redo' }).click();
  await expect.poll(async () => readCanvasRegionSignature(canvas, sample)).toEqual(pencilSignature);

  await studio.getByRole('button', { name: 'Undo' }).click();
  const marker = materialGroup.getByRole('button', { name: /Marker/ });
  await marker.click();
  await canvas.click({ position: { x: center.x / CANVAS_WIDTH * box!.width, y: center.y / CANVAS_HEIGHT * box!.height } });
  const markerSignature = await readCanvasRegionSignature(canvas, sample);
  expect(markerSignature.uniqueColors).toBeGreaterThan(10);
  expect(markerSignature.lightnessRange).toBeGreaterThan(8);
  expect(markerSignature.hash).not.toBe(paintedSignature.hash);
  expect(markerSignature.hash).not.toBe(pencilSignature.hash);
  await studio.getByRole('button', { name: 'Undo' }).click();
  await studio.getByRole('button', { name: 'Redo' }).click();
  await expect.poll(async () => readCanvasRegionSignature(canvas, sample)).toEqual(markerSignature);

  await studio.getByRole('button', { name: 'Undo' }).click();
  const gouache = materialGroup.getByRole('button', { name: /Gouache/ });
  await gouache.click();
  await canvas.click({ position: { x: center.x / CANVAS_WIDTH * box!.width, y: center.y / CANVAS_HEIGHT * box!.height } });
  const gouacheSignature = await readCanvasRegionSignature(canvas, sample);
  expect(gouacheSignature.uniqueColors).toBeGreaterThan(10);
  expect(gouacheSignature.lightnessRange).toBeGreaterThanOrEqual(5);
  expect(gouacheSignature.hash).not.toBe(paintedSignature.hash);
  expect(gouacheSignature.hash).not.toBe(pencilSignature.hash);
  expect(gouacheSignature.hash).not.toBe(markerSignature.hash);
  await studio.getByRole('button', { name: 'Undo' }).click();
  await studio.getByRole('button', { name: 'Redo' }).click();
  await expect.poll(async () => readCanvasRegionSignature(canvas, sample)).toEqual(gouacheSignature);

  // A material is a glaze, so applying it over a solid fill of the same RGB
  // must still create a new visual action rather than being treated as a no-op.
  await studio.getByRole('button', { name: 'Undo' }).click();
  const solid = materialGroup.getByRole('button', { name: /Solid/ });
  await solid.click();
  await canvas.click({ position: { x: center.x / CANVAS_WIDTH * box!.width, y: center.y / CANVAS_HEIGHT * box!.height } });
  const solidSignature = await readCanvasRegionSignature(canvas, sample);
  await watercolor.click();
  await canvas.click({ position: { x: center.x / CANVAS_WIDTH * box!.width, y: center.y / CANVAS_HEIGHT * box!.height } });
  await expect(studio.getByText('3 actions')).toBeVisible();
  const glazedSignature = await readCanvasRegionSignature(canvas, sample);
  expect(glazedSignature.hash).not.toBe(solidSignature.hash);
  await studio.getByRole('button', { name: 'Undo' }).click();
  await expect.poll(async () => readCanvasRegionSignature(canvas, sample)).toEqual(solidSignature);
  await studio.getByRole('button', { name: 'Redo' }).click();
  await expect.poll(async () => readCanvasRegionSignature(canvas, sample)).toEqual(glazedSignature);

  // Repeated washes reuse the exact previous region mask. This models glazing
  // without the second click fragmenting into islands created by the first
  // wash's paper grain.
  await canvas.click({ position: { x: center.x / CANVAS_WIDTH * box!.width, y: center.y / CANVAS_HEIGHT * box!.height } });
  await expect(studio.getByText('4 actions')).toBeVisible();
  const secondGlazeSignature = await readCanvasRegionSignature(canvas, sample);
  expect(secondGlazeSignature.hash).not.toBe(glazedSignature.hash);
  await studio.getByRole('button', { name: 'Undo' }).click();
  await expect.poll(async () => readCanvasRegionSignature(canvas, sample)).toEqual(glazedSignature);

  for (const viewport of [{ width: 375, height: 812 }, { width: 844, height: 390 }]) {
    await page.setViewportSize(viewport);
    if (viewport.width <= 720 && !await studio.locator('.tool-inspector').isVisible()) {
      await studio.getByRole('button', { name: 'Color and tool settings' }).click();
    }
    for (const material of await materialGroup.getByRole('button').all()) {
      const materialBox = await material.boundingBox();
      expect(materialBox?.height).toBeGreaterThanOrEqual(44);
    }
    for (const sliderName of ['Granulation', 'Water', 'Color Tolerance']) {
      const sliderBox = await studio.getByLabel(sliderName).boundingBox();
      expect(sliderBox?.height).toBeGreaterThanOrEqual(44);
    }
    const widths = await page.locator('body').evaluate((body) => ({ client: body.clientWidth, scroll: body.scrollWidth }));
    expect(widths.scroll).toBe(widths.client);
  }
});
