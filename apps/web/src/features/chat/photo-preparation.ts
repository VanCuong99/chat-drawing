export type PhotoCrop = 'original' | 'square' | 'landscape' | 'portrait';

const CROP_RATIOS: Record<Exclude<PhotoCrop, 'original'>, number> = {
  square: 1,
  landscape: 4 / 3,
  portrait: 3 / 4,
};

export async function preparePhoto(file: File, rotation: 0 | 90 | 180 | 270, crop: PhotoCrop) {
  const bitmap = await createImageBitmap(file);
  try {
    const rotatedWidth = rotation % 180 === 0 ? bitmap.width : bitmap.height;
    const rotatedHeight = rotation % 180 === 0 ? bitmap.height : bitmap.width;
    const rotated = document.createElement('canvas');
    rotated.width = rotatedWidth;
    rotated.height = rotatedHeight;
    const context = rotated.getContext('2d');
    if (!context) throw new Error('Photo preparation is unavailable in this browser.');
    context.translate(rotatedWidth / 2, rotatedHeight / 2);
    context.rotate(rotation * Math.PI / 180);
    context.drawImage(bitmap, -bitmap.width / 2, -bitmap.height / 2);

    let sourceX = 0;
    let sourceY = 0;
    let sourceWidth = rotatedWidth;
    let sourceHeight = rotatedHeight;
    if (crop !== 'original') {
      const ratio = CROP_RATIOS[crop];
      if (rotatedWidth / rotatedHeight > ratio) {
        sourceWidth = Math.round(rotatedHeight * ratio);
        sourceX = Math.round((rotatedWidth - sourceWidth) / 2);
      } else {
        sourceHeight = Math.round(rotatedWidth / ratio);
        sourceY = Math.round((rotatedHeight - sourceHeight) / 2);
      }
    }
    const scale = Math.min(1, 2400 / Math.max(sourceWidth, sourceHeight));
    const output = document.createElement('canvas');
    output.width = Math.max(1, Math.round(sourceWidth * scale));
    output.height = Math.max(1, Math.round(sourceHeight * scale));
    const outputContext = output.getContext('2d');
    if (!outputContext) throw new Error('Photo preparation is unavailable in this browser.');
    outputContext.drawImage(rotated, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, output.width, output.height);
    const blob = await new Promise<Blob>((resolve, reject) => output.toBlob((value) => value ? resolve(value) : reject(new Error('The prepared photo could not be created.')), 'image/jpeg', 0.92));
    return new File([blob], file.name.replace(/\.[^.]+$/, '') + '.jpg', { type: 'image/jpeg' });
  } finally {
    bitmap.close();
  }
}
