import { Color, mix } from 'spectral.js';

export type PigmentComponent = { color: string; weight: number };

export const MIN_PIGMENT_COMPONENTS = 2;
export const MAX_PIGMENT_COMPONENTS = 12;
export const PIGMENT_MODEL = {
  id: 'spectral-kubelka-munk-rgb',
  version: 2,
  colorSpace: 'sRGB',
  illuminant: 'D65',
} as const;

export function mixPigmentHex(components: readonly PigmentComponent[]) {
  if (components.length < MIN_PIGMENT_COMPONENTS || components.length > MAX_PIGMENT_COMPONENTS) {
    throw new Error(`A pigment mix needs ${MIN_PIGMENT_COMPONENTS}-${MAX_PIGMENT_COMPONENTS} components.`);
  }
  const colors = components.map((component) => {
    const color = new Color(component.color.toUpperCase());
    // spectral.js derives concentration as factor^2 * tintingStrength^2 *
    // luminance. Invert that transform so normalized user parts are the
    // concentrations supplied to the multi-pigment K/S mixture.
    const factor = Math.sqrt(component.weight / (color.tintingStrength ** 2 * color.luminance));
    return [color, factor] as [Color, number];
  });
  return mix(...colors)
    .toString()
    .toUpperCase();
}

export function pigmentPercentages(components: readonly PigmentComponent[]) {
  const total = components.reduce((sum, component) => sum + component.weight, 0);
  if (total <= 0) return components.map(() => 0);
  const exactTenths = components.map((component) => component.weight / total * 1000);
  const allocatedTenths = exactTenths.map(Math.floor);
  const remainderOrder = exactTenths
    .map((value, index) => ({ index, remainder: value - allocatedTenths[index] }))
    .sort((left, right) => right.remainder - left.remainder || right.index - left.index);
  const remainingTenths = 1000 - allocatedTenths.reduce((sum, value) => sum + value, 0);
  for (let index = 0; index < remainingTenths; index += 1) {
    allocatedTenths[remainderOrder[index % remainderOrder.length].index] += 1;
  }
  return allocatedTenths.map((value) => value / 10);
}
