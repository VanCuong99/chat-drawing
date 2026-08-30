'use client';

import {
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { MAX_PIGMENT_COMPONENTS, mixPigmentHex, pigmentPercentages, type PigmentComponent } from '@net/pigment';
import type { PaletteColorView } from '@/src/shared/chat.types';
import AppDialog from '@/src/shared/app-dialog';
import { useLanguage } from '@/src/i18n/language-provider';
import { deleteStudioDraft, readStudioDraft, saveStudioDraft } from './studio-drafts';

const CANVAS_WIDTH = 1200;
const CANVAS_HEIGHT = 720;
const MIN_ZOOM = 50;
const MAX_ZOOM = 180;
const COLORS = ['#27242e', '#6f4ee8', '#ef7668', '#e19a3f', '#3aa694', '#3085c7', '#d34d8b', '#ffffff'];

const clampZoom = (value: number) => Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, value));
const contactDistance = (first: TouchContact, second: TouchContact) => Math.hypot(second.x - first.x, second.y - first.y);
const contactMidpoint = (first: TouchContact, second: TouchContact): TouchContact => ({ x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 });

type Point = { x: number; y: number; pressure: number };
type StrokeTool = 'pen' | 'marker' | 'eraser';
type ClosedShapeTool = 'rectangle' | 'roundedRectangle' | 'ellipse' | 'triangle' | 'trapezoid' | 'diamond' | 'star' | 'bubble';
type ShapeTool = 'line' | 'arrow' | ClosedShapeTool;
type Tool = 'hand' | StrokeTool | ShapeTool | 'fill' | 'text';
type SizedTool = Exclude<Tool, 'hand' | 'fill' | 'text'>;
type Paper = 'white' | 'cream' | 'grid' | 'dots';
type FillMaterial = 'solid' | 'marker' | 'pencil' | 'watercolor' | 'gouache';
type StyledAction = { color: string; size: number; opacity: number };
type StrokeAction = StyledAction & { kind: 'stroke'; tool: StrokeTool; points: Point[] };
type ShapeAction = StyledAction & { kind: 'shape'; tool: ShapeTool; from: Point; to: Point; filled: boolean };
type FillAction = Pick<StyledAction, 'color' | 'opacity'> & { kind: 'fill'; spans: Uint32Array; edgeSpans: Uint32Array; material: FillMaterial; texture: number; water: number; seed: number };
type TextAction = StyledAction & { kind: 'text'; id: string; point: Point; text: string };
type DrawAction = StrokeAction | ShapeAction | FillAction | TextAction;
type Scene = { actions: DrawAction[]; paper: Paper };
type History = { past: Scene[]; present: Scene; future: Scene[] };
type MixerPigment = PigmentComponent & { id: string };
type StoredDraft = { scene: Scene; caption: string; savedAt: number };
type TouchContact = { x: number; y: number };
type CanvasGesture = {
  pointerIds: [number, number];
  startDistance: number;
  startZoom: number;
  anchor: { x: number; y: number };
};

const INITIAL_SCENE: Scene = { actions: [], paper: 'white' };
const INITIAL_MIXER_COMPONENTS: MixerPigment[] = [
  { id: 'pigment-1', color: '#FCF046', weight: 1 },
  { id: 'pigment-2', color: '#E53166', weight: 1 },
  { id: 'pigment-3', color: '#3375DA', weight: 1 },
];
const ADDED_PIGMENT_COLORS = ['#FCD200', '#002185', '#EF7668', '#3AA694', '#D34D8B', '#E19A3F'];
const FILL_MATERIALS: Array<{ id: FillMaterial; label: string; description: string }> = [
  { id: 'solid', label: 'Solid', description: 'Even, clean color' },
  { id: 'marker', label: 'Marker', description: 'Layered ink' },
  { id: 'pencil', label: 'Colored Pencil', description: 'Catches the paper grain' },
  { id: 'watercolor', label: 'Watercolor', description: 'Wash and edge pooling' },
  { id: 'gouache', label: 'Gouache', description: 'Opaque, matte brushwork' },
];
const INITIAL_TOOL_SIZES: Record<SizedTool, number> = { pen: 7, marker: 18, eraser: 32, line: 5, arrow: 5, rectangle: 5, roundedRectangle: 5, ellipse: 5, triangle: 5, trapezoid: 5, diamond: 5, star: 5, bubble: 5 };
const TOOL_SIZE_LIMITS: Record<SizedTool, { min: number; max: number }> = {
  pen: { min: 2, max: 40 },
  marker: { min: 6, max: 60 },
  eraser: { min: 6, max: 100 },
  line: { min: 2, max: 24 },
  arrow: { min: 2, max: 24 },
  rectangle: { min: 2, max: 24 },
  roundedRectangle: { min: 2, max: 24 },
  ellipse: { min: 2, max: 24 },
  triangle: { min: 2, max: 24 },
  trapezoid: { min: 2, max: 24 },
  diamond: { min: 2, max: 24 },
  star: { min: 2, max: 24 },
  bubble: { min: 2, max: 24 },
};

const TOOLS: Array<{ id: Tool; label: string; key: string }> = [
  { id: 'hand', label: 'Pan', key: 'H' },
  { id: 'pen', label: 'Pencil', key: 'P' },
  { id: 'marker', label: 'Highlighter', key: 'M' },
  { id: 'eraser', label: 'Eraser', key: 'E' },
  { id: 'fill', label: 'Fill', key: 'F' },
  { id: 'line', label: 'Line', key: 'L' },
  { id: 'arrow', label: 'Arrow', key: 'A' },
  { id: 'rectangle', label: 'Rectangle', key: 'R' },
  { id: 'roundedRectangle', label: 'Rounded Rectangle', key: 'U' },
  { id: 'ellipse', label: 'Ellipse', key: 'O' },
  { id: 'triangle', label: 'Triangle', key: 'G' },
  { id: 'trapezoid', label: 'Trapezoid', key: 'V' },
  { id: 'diamond', label: 'Diamond', key: 'D' },
  { id: 'star', label: 'Star', key: 'S' },
  { id: 'bubble', label: 'Speech Bubble', key: 'B' },
  { id: 'text', label: 'Text', key: 'T' },
];

const RAIL_TOOLS = TOOLS.filter((tool) => ['hand', 'pen', 'marker', 'eraser', 'fill', 'line', 'arrow'].includes(tool.id));
const MORE_TOOLS = RAIL_TOOLS.filter((tool) => ['marker', 'fill', 'line', 'arrow'].includes(tool.id));
const MOBILE_MORE_TOOLS = RAIL_TOOLS.filter((tool) => ['hand', 'marker', 'fill', 'line', 'arrow'].includes(tool.id));
const SHAPE_TOOLS = TOOLS.filter((tool): tool is { id: ClosedShapeTool; label: string; key: string } => ['rectangle', 'roundedRectangle', 'ellipse', 'triangle', 'trapezoid', 'diamond', 'star', 'bubble'].includes(tool.id));
const TEXT_TOOL = TOOLS.find((tool) => tool.id === 'text')!;

const TOOL_BY_KEY = new Map(TOOLS.map((tool) => [tool.key.toLocaleLowerCase(), tool.id]));

function isSizedTool(tool: Tool): tool is SizedTool {
  return tool !== 'hand' && tool !== 'fill' && tool !== 'text';
}

function isClosedShapeTool(tool: Tool): tool is ClosedShapeTool {
  return SHAPE_TOOLS.some((item) => item.id === tool);
}

function rangeStyle(value: number, min: number, max: number) {
  return { '--range-progress': `${((value - min) / (max - min)) * 100}%` } as CSSProperties;
}

function ToolIcon({ tool }: { tool: Tool }) {
  let content;
  switch (tool) {
    case 'hand':
      content = <><path d="M12 3v18M3 12h18" /><path d="m9 6 3-3 3 3M9 18l3 3 3-3M6 9l-3 3 3 3M18 9l3 3-3 3" /></>;
      break;
    case 'pen':
      content = <><path d="m4 20 4.6-1.1L19 8.5 15.5 5 5.1 15.4 4 20Z" /><path d="m13.8 6.7 3.5 3.5M5.1 15.4l3.5 3.5" /><path d="M4 20h4" /></>;
      break;
    case 'marker':
      content = <><path d="M9 3h6v12H9z" /><path d="M10 6h4M9 15h6l-1 4h-4l-1-4Z" className="tool-icon-highlight" /><path d="M7 21h10" /></>;
      break;
    case 'eraser':
      content = <><path d="m5 15 7.8-8a2 2 0 0 1 2.8 0l2.5 2.5a2 2 0 0 1 0 2.8L10.5 20H8l-3-3a1.4 1.4 0 0 1 0-2Z" /><path d="m10 10 6 6M10.5 20H21" /></>;
      break;
    case 'fill':
      content = <><path d="m5.2 11.4 6.2-6.2 7.4 7.4-6.2 6.2a2.1 2.1 0 0 1-3 0l-4.4-4.4a2.1 2.1 0 0 1 0-3Z" /><path d="m8.1 8.5 7.4 7.4M4 20h11" /><path d="M19.3 15.5s2 2.3 2 3.5a2 2 0 0 1-4 0c0-1.2 2-3.5 2-3.5Z" className="tool-icon-fill-drop" /></>;
      break;
    case 'line':
      content = <><path d="M4 20 20 4" /><circle cx="4" cy="20" r="1.5" className="tool-icon-fill" /><circle cx="20" cy="4" r="1.5" className="tool-icon-fill" /></>;
      break;
    case 'arrow':
      content = <><path d="M4 20 20 4M12 4h8v8" /><circle cx="4" cy="20" r="1.5" className="tool-icon-fill" /></>;
      break;
    case 'rectangle':
      content = <><rect x="4" y="5" width="16" height="14" rx="1.5" /><path d="M4 9h16" opacity=".35" /></>;
      break;
    case 'roundedRectangle':
      content = <rect x="3.5" y="5" width="17" height="14" rx="4" />;
      break;
    case 'ellipse':
      content = <><ellipse cx="12" cy="12" rx="8" ry="6.5" /><circle cx="12" cy="12" r="1.5" className="tool-icon-fill" /></>;
      break;
    case 'triangle':
      content = <path d="m12 4 9 16H3L12 4Z" />;
      break;
    case 'trapezoid':
      content = <path d="M7 5h10l4 14H3L7 5Z" />;
      break;
    case 'diamond':
      content = <path d="m12 3 9 9-9 9-9-9 9-9Z" />;
      break;
    case 'star':
      content = <path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9L12 3Z" />;
      break;
    case 'bubble':
      content = <path d="M4 5h16v11H10l-5 4 1-4H4V5Z" />;
      break;
    case 'text':
      content = <><path d="M5 5h14M12 5v14M8.5 19h7" /><path d="M7 5v3M17 5v3" /></>;
      break;
  }
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" data-tool-icon={tool}>{content}</svg>;
}

function drawPaper(context: CanvasRenderingContext2D, paper: Paper) {
  context.save();
  context.fillStyle = paper === 'cream' ? '#fff8e9' : '#fffefb';
  context.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
  if (paper === 'grid') {
    context.strokeStyle = '#e8e4ee';
    context.lineWidth = 1;
    for (let x = 40; x < CANVAS_WIDTH; x += 40) {
      context.beginPath();
      context.moveTo(x, 0);
      context.lineTo(x, CANVAS_HEIGHT);
      context.stroke();
    }
    for (let y = 40; y < CANVAS_HEIGHT; y += 40) {
      context.beginPath();
      context.moveTo(0, y);
      context.lineTo(CANVAS_WIDTH, y);
      context.stroke();
    }
  }
  if (paper === 'dots') {
    context.fillStyle = '#dcd5e7';
    for (let x = 30; x < CANVAS_WIDTH; x += 30) {
      for (let y = 30; y < CANVAS_HEIGHT; y += 30) {
        context.beginPath();
        context.arc(x, y, 1.5, 0, Math.PI * 2);
        context.fill();
      }
    }
  }
  context.restore();
}

function drawStrokePath(context: CanvasRenderingContext2D, action: StrokeAction) {
  const points = action.points;
  if (!points.length) return;
  context.strokeStyle = action.color;
  context.fillStyle = action.color;
  context.lineCap = 'round';
  context.lineJoin = 'round';
  context.lineWidth = action.size;
  if (points.length === 1) {
    context.beginPath();
    const pressureScale = action.tool === 'pen' ? 0.35 + Math.min(1, points[0].pressure) * 0.9 : 1;
    context.arc(points[0].x, points[0].y, context.lineWidth * pressureScale / 2, 0, Math.PI * 2);
    context.fill();
  } else if (action.tool === 'pen') {
    for (let index = 1; index < points.length; index += 1) {
      const previous = points[index - 1];
      const current = points[index];
      const pressure = (Math.min(1, previous.pressure) + Math.min(1, current.pressure)) / 2;
      context.lineWidth = action.size * (0.35 + pressure * 0.9);
      context.beginPath();
      context.moveTo(previous.x, previous.y);
      context.lineTo(current.x, current.y);
      context.stroke();
    }
  } else {
    context.beginPath();
    context.moveTo(points[0].x, points[0].y);
    for (let index = 1; index < points.length - 1; index += 1) {
      const current = points[index];
      const next = points[index + 1];
      context.quadraticCurveTo(current.x, current.y, (current.x + next.x) / 2, (current.y + next.y) / 2);
    }
    const last = points[points.length - 1];
    context.lineTo(last.x, last.y);
    context.stroke();
  }
}

function strokeOpacity(action: StrokeAction) {
  return action.tool === 'eraser' ? 1 : action.tool === 'marker' ? action.opacity * 0.34 : action.opacity;
}

function drawSmoothStroke(context: CanvasRenderingContext2D, action: StrokeAction) {
  context.save();
  context.globalCompositeOperation = action.tool === 'eraser' ? 'destination-out' : 'source-over';
  context.globalAlpha = strokeOpacity(action);
  drawStrokePath(context, action);
  context.restore();
}

function drawShape(context: CanvasRenderingContext2D, action: ShapeAction) {
  const { from, to } = action;
  const left = Math.min(from.x, to.x);
  const top = Math.min(from.y, to.y);
  const width = Math.abs(to.x - from.x);
  const height = Math.abs(to.y - from.y);
  const right = left + width;
  const bottom = top + height;
  const centerX = left + width / 2;
  const centerY = top + height / 2;
  context.save();
  context.globalAlpha = action.opacity;
  context.strokeStyle = action.color;
  context.fillStyle = action.color;
  context.lineWidth = action.size;
  context.lineCap = 'round';
  context.lineJoin = 'round';
  context.beginPath();
  if (action.tool === 'line' || action.tool === 'arrow') {
    context.moveTo(from.x, from.y);
    context.lineTo(to.x, to.y);
  } else if (action.tool === 'rectangle') context.rect(left, top, width, height);
  else if (action.tool === 'roundedRectangle') context.roundRect(left, top, width, height, Math.min(28, width / 4, height / 4));
  else if (action.tool === 'ellipse') context.ellipse(centerX, centerY, width / 2, height / 2, 0, 0, Math.PI * 2);
  else if (action.tool === 'triangle') {
    context.moveTo(centerX, top);
    context.lineTo(right, bottom);
    context.lineTo(left, bottom);
    context.closePath();
  } else if (action.tool === 'diamond') {
    context.moveTo(centerX, top);
    context.lineTo(right, centerY);
    context.lineTo(centerX, bottom);
    context.lineTo(left, centerY);
    context.closePath();
  } else if (action.tool === 'trapezoid') {
    context.moveTo(left + width * 0.22, top);
    context.lineTo(right - width * 0.22, top);
    context.lineTo(right, bottom);
    context.lineTo(left, bottom);
    context.closePath();
  } else if (action.tool === 'star') {
    const outerX = width / 2;
    const outerY = height / 2;
    for (let index = 0; index < 10; index += 1) {
      const angle = -Math.PI / 2 + index * Math.PI / 5;
      const ratio = index % 2 === 0 ? 1 : 0.43;
      const x = centerX + Math.cos(angle) * outerX * ratio;
      const y = centerY + Math.sin(angle) * outerY * ratio;
      if (index === 0) context.moveTo(x, y); else context.lineTo(x, y);
    }
    context.closePath();
  } else {
    const radius = Math.min(24, width / 5, height / 5);
    const bodyBottom = top + height * 0.78;
    context.moveTo(left + radius, top);
    context.quadraticCurveTo(left, top, left, top + radius);
    context.lineTo(left, bodyBottom - radius);
    context.quadraticCurveTo(left, bodyBottom, left + radius, bodyBottom);
    context.lineTo(left + width * 0.25, bodyBottom);
    context.lineTo(left + width * 0.18, bottom);
    context.lineTo(left + width * 0.42, bodyBottom);
    context.lineTo(right - radius, bodyBottom);
    context.quadraticCurveTo(right, bodyBottom, right, bodyBottom - radius);
    context.lineTo(right, top + radius);
    context.quadraticCurveTo(right, top, right - radius, top);
    context.closePath();
  }
  if (action.filled && isClosedShapeTool(action.tool)) {
    context.save();
    context.globalAlpha = action.opacity * 0.16;
    context.fill();
    context.restore();
  }
  context.stroke();
  if (action.tool === 'arrow') {
    const angle = Math.atan2(to.y - from.y, to.x - from.x);
    const length = Math.max(16, action.size * 4.2);
    context.beginPath();
    context.moveTo(to.x, to.y);
    context.lineTo(to.x - length * Math.cos(angle - Math.PI / 6), to.y - length * Math.sin(angle - Math.PI / 6));
    context.moveTo(to.x, to.y);
    context.lineTo(to.x - length * Math.cos(angle + Math.PI / 6), to.y - length * Math.sin(angle + Math.PI / 6));
    context.stroke();
  }
  context.restore();
}

function wrapText(context: CanvasRenderingContext2D, text: string, maxWidth: number) {
  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    if (!paragraph.trim()) {
      lines.push('');
      continue;
    }
    let line = '';
    for (const rawWord of paragraph.trim().split(/\s+/)) {
      const chunks: string[] = [];
      let chunk = '';
      for (const character of rawWord) {
        if (chunk && context.measureText(`${chunk}${character}`).width > maxWidth) {
          chunks.push(chunk);
          chunk = character;
        } else chunk += character;
      }
      if (chunk) chunks.push(chunk);
      for (const word of chunks) {
        const candidate = line ? `${line} ${word}` : word;
        if (line && context.measureText(candidate).width > maxWidth) {
          lines.push(line);
          line = word;
        } else line = candidate;
      }
    }
    if (line) lines.push(line);
  }
  return lines;
}

function withEllipsis(context: CanvasRenderingContext2D, line: string, maxWidth: number) {
  let shortened = line;
  while (shortened && context.measureText(`${shortened}…`).width > maxWidth) shortened = shortened.slice(0, -1);
  return `${shortened}…`;
}

function getTextLayout(context: CanvasRenderingContext2D, action: TextAction) {
  context.save();
  context.font = `600 ${action.size}px ui-sans-serif, system-ui, sans-serif`;
  const maxWidth = Math.max(40, CANVAS_WIDTH - action.point.x - 24);
  const lineHeight = action.size * 1.25;
  const maxLines = Math.max(1, Math.floor((CANVAS_HEIGHT - action.point.y) / lineHeight));
  const allLines = wrapText(context, action.text, maxWidth);
  const lines = allLines.slice(0, maxLines);
  if (allLines.length > maxLines) lines[lines.length - 1] = withEllipsis(context, lines[lines.length - 1], maxWidth);
  const width = Math.min(maxWidth, Math.max(20, ...lines.map((line) => context.measureText(line || ' ').width)));
  context.restore();
  return { lines, maxWidth, lineHeight, width, height: Math.max(lineHeight, lines.length * lineHeight) };
}

function drawTextSelection(context: CanvasRenderingContext2D, action: TextAction) {
  const layout = getTextLayout(context, action);
  const padding = 12;
  context.save();
  context.fillStyle = 'rgba(111, 78, 232, 0.08)';
  context.strokeStyle = '#6f4ee8';
  context.lineWidth = 2;
  context.setLineDash([8, 6]);
  context.fillRect(action.point.x - padding, action.point.y - padding, layout.width + padding * 2, layout.height + padding * 2);
  context.strokeRect(action.point.x - padding, action.point.y - padding, layout.width + padding * 2, layout.height + padding * 2);
  context.setLineDash([]);
  context.fillStyle = '#6f4ee8';
  for (const [x, y] of [
    [action.point.x - padding, action.point.y - padding],
    [action.point.x + layout.width + padding, action.point.y - padding],
    [action.point.x - padding, action.point.y + layout.height + padding],
    [action.point.x + layout.width + padding, action.point.y + layout.height + padding],
  ]) {
    context.beginPath();
    context.arc(x, y, 5, 0, Math.PI * 2);
    context.fill();
  }
  context.restore();
}

function hexToRgb(hex: string) {
  const normalized = hex.replace('#', '');
  const value = Number.parseInt(normalized, 16);
  return { red: value >> 16 & 255, green: value >> 8 & 255, blue: value & 255 };
}

const MATERIAL_TILE_SIZE = 384;
const materialTileCache = new Map<string, HTMLCanvasElement>();

function textureNoise(x: number, y: number, seed: number) {
  let value = Math.imul(x + 1, 374761393) ^ Math.imul(y + 1, 668265263) ^ seed;
  value = Math.imul(value ^ value >>> 13, 1274126177);
  return ((value ^ value >>> 16) >>> 0) / 4294967295;
}

function seamlessNoise(x: number, y: number, seed: number, cells: number) {
  const cellSize = MATERIAL_TILE_SIZE / cells;
  const cellX = Math.floor(x / cellSize);
  const cellY = Math.floor(y / cellSize);
  const localX = (x - cellX * cellSize) / cellSize;
  const localY = (y - cellY * cellSize) / cellSize;
  const smoothX = localX * localX * (3 - 2 * localX);
  const smoothY = localY * localY * (3 - 2 * localY);
  const wrap = (value: number) => (value + cells) % cells;
  const topLeft = textureNoise(wrap(cellX), wrap(cellY), seed);
  const topRight = textureNoise(wrap(cellX + 1), wrap(cellY), seed);
  const bottomLeft = textureNoise(wrap(cellX), wrap(cellY + 1), seed);
  const bottomRight = textureNoise(wrap(cellX + 1), wrap(cellY + 1), seed);
  const top = topLeft + (topRight - topLeft) * smoothX;
  const bottom = bottomLeft + (bottomRight - bottomLeft) * smoothX;
  return top + (bottom - top) * smoothY;
}

function clampChannel(value: number) {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function fillContainsPoint(action: FillAction, point: Point) {
  const targetY = Math.floor(point.y);
  const targetX = Math.floor(point.x);
  for (let index = 0; index < action.spans.length; index += 3) {
    const y = action.spans[index];
    if (y > targetY) return false;
    if (y === targetY && targetX >= action.spans[index + 1] && targetX <= action.spans[index + 2]) return true;
  }
  return false;
}

function layerFillAction(previous: FillAction, color: string, opacity: number, material: FillMaterial, texture: number, water: number, seed: number): FillAction {
  return {
    kind: 'fill',
    spans: previous.spans,
    edgeSpans: previous.edgeSpans,
    color,
    opacity,
    material,
    texture,
    water,
    seed,
  };
}

function materialTile(action: FillAction) {
  const cacheKey = `${action.material}:${action.color}:${action.texture}:${action.water}:${action.seed}`;
  const cached = materialTileCache.get(cacheKey);
  if (cached) return cached;
  const tile = document.createElement('canvas');
  tile.width = MATERIAL_TILE_SIZE;
  tile.height = MATERIAL_TILE_SIZE;
  const context = tile.getContext('2d');
  if (!context) return tile;
  const image = context.createImageData(MATERIAL_TILE_SIZE, MATERIAL_TILE_SIZE);
  const { red, green, blue } = hexToRgb(action.color);
  const strength = action.texture / 100;
  const water = action.water / 100;
  const phase = action.seed % MATERIAL_TILE_SIZE;
  for (let y = 0; y < MATERIAL_TILE_SIZE; y += 1) {
    for (let x = 0; x < MATERIAL_TILE_SIZE; x += 1) {
      const grain = textureNoise(x, y, action.seed);
      const fineFiber = textureNoise(x * 3, y * 5, action.seed ^ 0x27d4eb2d);
      const paperHeight = seamlessNoise(x, y, action.seed ^ 0x9e3779b9, 16) * 0.72 + fineFiber * 0.28;
      let alpha = 255;
      let outputRed = red;
      let outputGreen = green;
      let outputBlue = blue;
      if (action.material === 'marker') {
        const band = (Math.sin((x + y * 2 + phase) * Math.PI / 22) + 1) / 2;
        const overlap = Math.pow(seamlessNoise(x, y, action.seed ^ 0x85ebca6b, 7), 2.2);
        alpha = 158 + band * 24 * strength + overlap * 38 * strength + (grain - 0.5) * 10;
      } else if (action.material === 'pencil') {
        const pressureField = seamlessNoise(x, y, action.seed ^ 0x165667b1, 32);
        const abrasion = seamlessNoise(x, y, action.seed ^ 0xd3a2646c, 96);
        const pencilTooth = fineFiber * 0.58 + seamlessNoise(x, y, action.seed ^ 0x51ed270b, 72) * 0.42;
        const pressure = 0.48 + strength * 0.32 + pressureField * 0.08;
        const catchesTooth = pencilTooth < pressure + abrasion * 0.04;
        alpha = catchesTooth ? 78 + pressureField * 72 + abrasion * 40 + fineFiber * 24 : 8 + abrasion * 10;
      } else if (action.material === 'watercolor') {
        const broadWash = seamlessNoise(x, y, action.seed, 5);
        const wetFlow = seamlessNoise(x, y, action.seed ^ 0x85ebca6b, 9);
        const bloomField = seamlessNoise(x, y, action.seed ^ 0xc2b2ae35, 12);
        const bloomRing = Math.exp(-Math.abs(bloomField - 0.52) * 18);
        const valleyDeposit = Math.pow(1 - paperHeight, 1.7);
        const pigmentLoad = 0.32 + broadWash * 0.22 + wetFlow * (0.08 + water * 0.1) + valleyDeposit * 0.24 * strength + bloomRing * 0.12 * strength * water;
        const concentration = 1 - water * 0.42;
        alpha = 42 + pigmentLoad * 184 * concentration - grain * (10 + water * 12);
        const sedimentShade = 0.9 + (1 - valleyDeposit) * 0.1;
        outputRed *= sedimentShade;
        outputGreen *= sedimentShade;
        outputBlue *= sedimentShade;
      } else if (action.material === 'gouache') {
        const body = seamlessNoise(x, y, action.seed ^ 0x165667b1, 7);
        const brushPressure = seamlessNoise(x, y, action.seed ^ 0xd3a2646c, 3);
        const fineBrush = (Math.sin((y + phase) * Math.PI / 17) + 1) / 2;
        const dryGap = water < 0.38 && strength > 0.68 && paperHeight > 0.94 && grain > 0.86;
        const dilution = water * 0.34;
        alpha = dryGap ? 130 + strength * 70 : (235 + (brushPressure - 0.5) * 24 + fineBrush * 5) * (1 - dilution);
        const matteVariation = 0.965 + body * 0.055;
        outputRed *= matteVariation;
        outputGreen *= matteVariation;
        outputBlue *= matteVariation;
      }
      const offset = (y * MATERIAL_TILE_SIZE + x) * 4;
      image.data[offset] = clampChannel(outputRed);
      image.data[offset + 1] = clampChannel(outputGreen);
      image.data[offset + 2] = clampChannel(outputBlue);
      image.data[offset + 3] = clampChannel(alpha);
    }
  }
  context.putImageData(image, 0, 0);
  if (action.material === 'pencil') {
    let randomState = action.seed || 1;
    const random = () => {
      randomState = Math.imul(randomState ^ randomState >>> 15, 1 | randomState);
      randomState ^= randomState + Math.imul(randomState ^ randomState >>> 7, 61 | randomState);
      return ((randomState ^ randomState >>> 14) >>> 0) / 4294967296;
    };
    context.save();
    context.strokeStyle = action.color;
    context.lineWidth = 0.65;
    context.globalAlpha = 0.13 + strength * 0.2;
    for (let index = 0; index < 1250; index += 1) {
      const startX = random() * MATERIAL_TILE_SIZE;
      const startY = random() * MATERIAL_TILE_SIZE;
      const length = 3 + random() * 12;
      const angle = -0.42 + (random() - 0.5) * 0.24;
      context.beginPath();
      context.moveTo(startX, startY);
      context.lineTo(startX + Math.cos(angle) * length, startY + Math.sin(angle) * length);
      context.stroke();
    }
    context.restore();
  }
  materialTileCache.set(cacheKey, tile);
  if (materialTileCache.size > 24) {
    const oldest = materialTileCache.keys().next().value;
    if (oldest) materialTileCache.delete(oldest);
  }
  return tile;
}

function appendFillSpans(context: CanvasRenderingContext2D, spans: Uint32Array) {
  for (let index = 0; index < spans.length; index += 3) {
    const y = spans[index];
    const startX = spans[index + 1];
    const endX = spans[index + 2];
    context.rect(startX, y, endX - startX + 1, 1);
  }
}

function drawWatercolorEdge(context: CanvasRenderingContext2D, action: FillAction) {
  if (!action.edgeSpans.length) return;
  context.save();
  context.globalCompositeOperation = 'multiply';
  context.globalAlpha = action.opacity * (0.1 + action.texture / 100 * 0.12 + action.water / 100 * 0.12);
  context.fillStyle = action.color;
  context.beginPath();
  appendFillSpans(context, action.edgeSpans);
  context.fill();
  context.restore();
}

function drawFill(context: CanvasRenderingContext2D, action: FillAction) {
  context.save();
  context.globalAlpha = action.opacity;
  context.beginPath();
  appendFillSpans(context, action.spans);
  if (action.material === 'solid') {
    context.fillStyle = action.color;
    context.fill();
  } else {
    context.clip();
    context.globalCompositeOperation = action.material === 'gouache' ? 'source-over' : 'multiply';
    const pattern = context.createPattern(materialTile(action), 'repeat');
    if (pattern) {
      context.fillStyle = pattern;
      context.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
    }
  }
  context.restore();
  if (action.material === 'watercolor') drawWatercolorEdge(context, action);
}

function makeFillAction(image: ImageData, point: Point, color: string, opacity: number, tolerance: number, material: FillMaterial, texture: number, water: number, seed: number): FillAction | null {
  const width = image.width;
  const height = image.height;
  const startX = Math.max(0, Math.min(width - 1, Math.floor(point.x)));
  const startY = Math.max(0, Math.min(height - 1, Math.floor(point.y)));
  const startIndex = startY * width + startX;
  const startOffset = startIndex * 4;
  const target = [image.data[startOffset], image.data[startOffset + 1], image.data[startOffset + 2], image.data[startOffset + 3]];
  const fill = hexToRgb(color);
  if (material === 'solid' && target[3] === 255 && Math.max(Math.abs(target[0] - fill.red), Math.abs(target[1] - fill.green), Math.abs(target[2] - fill.blue)) <= 1) return null;

  const visited = new Uint8Array(width * height);
  const queue = new Int32Array(width * height);
  let head = 0;
  let tail = 1;
  let minX = startX;
  let maxX = startX;
  let minY = startY;
  let maxY = startY;
  queue[0] = startIndex;
  visited[startIndex] = 2;

  const enqueue = (index: number) => {
    if (visited[index]) return;
    const offset = index * 4;
    const difference = Math.max(
      Math.abs(image.data[offset] - target[0]),
      Math.abs(image.data[offset + 1] - target[1]),
      Math.abs(image.data[offset + 2] - target[2]),
      Math.abs(image.data[offset + 3] - target[3]),
    );
    if (difference <= tolerance) {
      visited[index] = 2;
      queue[tail++] = index;
    } else visited[index] = 1;
  };

  while (head < tail) {
    const index = queue[head++];
    const x = index % width;
    const y = Math.floor(index / width);
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
    if (x > 0) enqueue(index - 1);
    if (x + 1 < width) enqueue(index + 1);
    if (y > 0) enqueue(index - width);
    if (y + 1 < height) enqueue(index + width);
  }

  // Flood fill must stop at the outline, but canvas anti-aliasing leaves a thin
  // band of background-tinted pixels immediately before the solid stroke. Seal
  // that single band without enqueueing it, so the fill reaches the visible
  // edge while never using the softer threshold to leak through the boundary.
  const edgeTolerance = Math.min(96, tolerance + 72);
  const edgeMinX = Math.max(0, minX - 1);
  const edgeMaxX = Math.min(width - 1, maxX + 1);
  const edgeMinY = Math.max(0, minY - 1);
  const edgeMaxY = Math.min(height - 1, maxY + 1);
  for (let y = edgeMinY; y <= edgeMaxY; y += 1) {
    for (let x = edgeMinX; x <= edgeMaxX; x += 1) {
      const index = y * width + x;
      if (visited[index] === 2) continue;
      const touchesFill = (x > 0 && visited[index - 1] === 2)
        || (x + 1 < width && visited[index + 1] === 2)
        || (y > 0 && visited[index - width] === 2)
        || (y + 1 < height && visited[index + width] === 2);
      if (!touchesFill) continue;
      const offset = index * 4;
      const difference = Math.max(
        Math.abs(image.data[offset] - target[0]),
        Math.abs(image.data[offset + 1] - target[1]),
        Math.abs(image.data[offset + 2] - target[2]),
        Math.abs(image.data[offset + 3] - target[3]),
      );
      if (difference <= edgeTolerance) visited[index] = 3;
    }
  }

  const spans: number[] = [];
  const edgeSpans: number[] = [];
  const isFillEdge = (x: number, y: number) => {
    const index = y * width + x;
    return visited[index] >= 2 && (
      x === 0 || y === 0 || x + 1 === width || y + 1 === height
      || visited[index - 1] < 2 || visited[index + 1] < 2
      || visited[index - width] < 2 || visited[index + width] < 2
    );
  };
  for (let y = edgeMinY; y <= edgeMaxY; y += 1) {
    let x = edgeMinX;
    while (x <= edgeMaxX) {
      while (x <= edgeMaxX && visited[y * width + x] < 2) x += 1;
      if (x > edgeMaxX) break;
      const start = x;
      while (x + 1 <= edgeMaxX && visited[y * width + x + 1] >= 2) x += 1;
      spans.push(y, start, x);
      x += 1;
    }
    x = edgeMinX;
    while (x <= edgeMaxX) {
      if (!isFillEdge(x, y)) { x += 1; continue; }
      const start = x;
      while (x + 1 <= edgeMaxX && isFillEdge(x + 1, y)) x += 1;
      edgeSpans.push(y, start, x);
      x += 1;
    }
  }
  return { kind: 'fill', spans: Uint32Array.from(spans), edgeSpans: Uint32Array.from(edgeSpans), color, opacity, material, texture, water, seed };
}

function drawAction(context: CanvasRenderingContext2D, action: DrawAction) {
  if (action.kind === 'stroke') drawSmoothStroke(context, action);
  else if (action.kind === 'shape') drawShape(context, action);
  else if (action.kind === 'fill') drawFill(context, action);
  else {
    context.save();
    context.globalAlpha = action.opacity;
    context.fillStyle = action.color;
    context.font = `600 ${action.size}px ui-sans-serif, system-ui, sans-serif`;
    context.textBaseline = 'top';
    const layout = getTextLayout(context, action);
    for (const [index, line] of layout.lines.entries()) {
      context.fillText(line, action.point.x, action.point.y + index * layout.lineHeight, layout.maxWidth);
    }
    context.restore();
  }
}

function makeLayer() {
  const layer = document.createElement('canvas');
  layer.width = CANVAS_WIDTH;
  layer.height = CANVAS_HEIGHT;
  return layer;
}

export default function DrawingStudio({ sourceUrl, sourceIsDraft = false, version, draftKey, paletteColors, paletteLoading = false, paletteMutating = false, palettePersistence = 'session', onClose, onSend, onSavePalette, onDeletePalette }: {
  sourceUrl?: string | null;
  sourceIsDraft?: boolean;
  version?: number | null;
  draftKey: string;
  paletteColors: PaletteColorView[];
  paletteLoading?: boolean;
  paletteMutating?: boolean;
  palettePersistence?: 'account' | 'session';
  onClose: () => void;
  onSend: (blob: Blob, caption: string) => Promise<void>;
  onSavePalette: (input: { name: string; components: PigmentComponent[] }) => Promise<void>;
  onDeletePalette: (id: string) => Promise<void>;
}) {
  const { t } = useLanguage();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const eraserCursorRef = useRef<HTMLSpanElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const shapeButtonRef = useRef<HTMLButtonElement>(null);
  const moreToolsButtonRef = useRef<HTMLButtonElement>(null);
  const moreToolsSheetRef = useRef<HTMLElement>(null);
  const mobileInspectorTriggerRef = useRef<HTMLButtonElement | null>(null);
  const mixerToggleRef = useRef<HTMLButtonElement>(null);
  const mixerIdRef = useRef(4);
  const fillSeedRef = useRef(1);
  const committedLayerRef = useRef<HTMLCanvasElement | null>(null);
  const previewLayerRef = useRef<HTMLCanvasElement | null>(null);
  const textDragFrameRef = useRef<number | null>(null);
  const sourceImageRef = useRef<HTMLImageElement | null>(null);
  const workingRef = useRef<DrawAction | null>(null);
  const actionsRef = useRef<DrawAction[]>([]);
  const selectedTextIdRef = useRef<string | null>(null);
  const textDragRef = useRef<{ id: string; start: Point; origin: Point; current: TextAction; isNew: boolean; moved: boolean } | null>(null);
  const activePointerRef = useRef<number | null>(null);
  const panRef = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const touchContactsRef = useRef(new Map<number, TouchContact>());
  const gestureRef = useRef<CanvasGesture | null>(null);
  const gestureFrameRef = useRef<number | null>(null);
  const pendingGestureRef = useRef<{ zoom: number; midpoint: TouchContact } | null>(null);
  const pendingTouchFillRef = useRef<{ pointerId: number; point: Point } | null>(null);
  const zoomRef = useRef(100);
  const zoomOutputRef = useRef<HTMLOutputElement>(null);
  const sendingRef = useRef(false);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const [history, setHistory] = useState<History>({ past: [], present: INITIAL_SCENE, future: [] });
  const [tool, setTool] = useState<Tool>('pen');
  const [selectedShape, setSelectedShape] = useState<ClosedShapeTool>('rectangle');
  const [shapeMenuOpen, setShapeMenuOpen] = useState(false);
  const [moreToolsOpen, setMoreToolsOpen] = useState(false);
  const [mobileInspectorOpen, setMobileInspectorOpen] = useState(false);
  const [shapeMenuPosition, setShapeMenuPosition] = useState({ left: 0, top: 0 });
  const [color, setColor] = useState('#6f4ee8');
  const [toolSizes, setToolSizes] = useState<Record<SizedTool, number>>(INITIAL_TOOL_SIZES);
  const [opacity, setOpacity] = useState(1);
  const [mixerOpen, setMixerOpen] = useState(false);
  const [mixerComponents, setMixerComponents] = useState<MixerPigment[]>(() => INITIAL_MIXER_COMPONENTS.map((component) => ({ ...component })));
  const [mixerName, setMixerName] = useState('');
  const [paletteSaving, setPaletteSaving] = useState(false);
  const [paletteError, setPaletteError] = useState('');
  const [paletteDeleteTarget, setPaletteDeleteTarget] = useState<PaletteColorView | null>(null);
  const [fontSize, setFontSize] = useState(46);
  const [textValue, setTextValue] = useState('');
  const [selectedTextId, setSelectedTextId] = useState<string | null>(null);
  const [filled, setFilled] = useState(false);
  const [fillTolerance, setFillTolerance] = useState(24);
  const [fillMaterial, setFillMaterial] = useState<FillMaterial>('solid');
  const [fillTexture, setFillTexture] = useState(60);
  const [fillWater, setFillWater] = useState(45);
  const [zoom, setZoom] = useState(100);
  const [caption, setCaption] = useState('');
  const [draftReady, setDraftReady] = useState(false);
  const [draftStatus, setDraftStatus] = useState<'idle' | 'saving' | 'saved' | 'restored'>('idle');
  const [sending, setSending] = useState(false);
  const [sourceLoading, setSourceLoading] = useState(Boolean(sourceUrl));
  const [sourceError, setSourceError] = useState(false);
  const [sourceReady, setSourceReady] = useState(0);
  const [hint, setHint] = useState(() => t('Drag on the paper to begin'));
  const actions = history.present.actions;
  const paper = history.present.paper;
  const size = tool === 'text' ? fontSize : isSizedTool(tool) ? toolSizes[tool] : toolSizes.pen;
  const sizeLimits = tool === 'text' ? { min: 20, max: 96 } : isSizedTool(tool) ? TOOL_SIZE_LIMITS[tool] : TOOL_SIZE_LIMITS.pen;
  const isDirty = history.past.length > 0 || history.future.length > 0 || actions.length > 0 || paper !== 'white' || Boolean(caption.trim()) || Boolean(textValue.trim());
  const canSendCanvas = Boolean(sourceUrl) || actions.length > 0 || paper !== 'white';
  const pigmentFormula = useMemo(() => mixerComponents.map(({ color: componentColor, weight }) => ({ color: componentColor, weight })), [mixerComponents]);
  const mixedColor = useMemo(() => mixPigmentHex(pigmentFormula), [pigmentFormula]);
  const mixerPercentages = useMemo(() => pigmentPercentages(pigmentFormula), [pigmentFormula]);
  const activeFillMaterial = FILL_MATERIALS.find((item) => item.id === fillMaterial) ?? FILL_MATERIALS[0];

  useEffect(() => { actionsRef.current = actions; }, [actions]);

  useEffect(() => { zoomRef.current = zoom; }, [zoom]);

  useEffect(() => () => {
    if (gestureFrameRef.current !== null) window.cancelAnimationFrame(gestureFrameRef.current);
    touchContactsRef.current.clear();
  }, []);

  useEffect(() => {
    let cancelled = false;
    void readStudioDraft<StoredDraft>(draftKey)
      .then((draft) => {
        if (cancelled || !draft || !Array.isArray(draft.scene?.actions)) return;
        setHistory({ past: [], present: draft.scene, future: [] });
        setCaption(draft.caption);
        setDraftStatus('restored');
        setHint(t('Draft restored'));
      })
      .catch(() => undefined)
      .finally(() => { if (!cancelled) setDraftReady(true); });
    return () => { cancelled = true; };
  }, [draftKey, t]);

  useEffect(() => {
    if (!draftReady) return;
    const timeout = window.setTimeout(() => {
      if (!isDirty) {
        void deleteStudioDraft(draftKey).catch(() => undefined);
        setDraftStatus('idle');
        return;
      }
      setDraftStatus('saving');
      void saveStudioDraft<StoredDraft>(draftKey, { scene: history.present, caption, savedAt: Date.now() })
        .then(() => setDraftStatus('saved'))
        .catch(() => setDraftStatus('idle'));
    }, 700);
    return () => window.clearTimeout(timeout);
  }, [caption, draftKey, draftReady, history.present, isDirty]);

  const paintPreview = useCallback((preview?: DrawAction | null, paperOverride?: Paper, selectedText?: TextAction | null) => {
    const canvas = canvasRef.current;
    const committedLayer = committedLayerRef.current;
    if (!canvas || !committedLayer) return;
    if (!previewLayerRef.current) previewLayerRef.current = makeLayer();
    const previewLayer = previewLayerRef.current;
    const previewContext = previewLayer.getContext('2d');
    const context = canvas.getContext('2d');
    if (!previewContext || !context) return;
    previewContext.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
    previewContext.drawImage(committedLayer, 0, 0);
    if (preview) drawAction(previewContext, preview);
    context.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
    drawPaper(context, paperOverride ?? paper);
    context.drawImage(previewLayer, 0, 0);
    const selected = selectedText === undefined
      ? actionsRef.current.find((action): action is TextAction => action.kind === 'text' && action.id === selectedTextIdRef.current)
      : selectedText;
    if (selected) drawTextSelection(context, selected);
  }, [paper]);

  const paintTextDrag = useCallback((dragged: TextAction) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext('2d');
    if (!context) return;
    if (!previewLayerRef.current) previewLayerRef.current = makeLayer();
    const layer = previewLayerRef.current;
    const layerContext = layer.getContext('2d');
    if (!layerContext) return;
    layerContext.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
    if (sourceImageRef.current) layerContext.drawImage(sourceImageRef.current, 0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
    let found = false;
    for (const action of actionsRef.current) {
      if (action.kind === 'text' && action.id === dragged.id) {
        drawAction(layerContext, dragged);
        found = true;
      } else drawAction(layerContext, action);
    }
    if (!found) drawAction(layerContext, dragged);
    context.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
    drawPaper(context, paper);
    context.drawImage(layer, 0, 0);
    drawTextSelection(context, dragged);
  }, [paper]);

  const rebuildScene = useCallback((sceneActions: DrawAction[], paperOverride?: Paper) => {
    if (!committedLayerRef.current) committedLayerRef.current = makeLayer();
    const committedLayer = committedLayerRef.current;
    const context = committedLayer.getContext('2d');
    if (!context) return;
    context.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
    if (sourceImageRef.current) context.drawImage(sourceImageRef.current, 0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
    for (const action of sceneActions) drawAction(context, action);
    paintPreview(null, paperOverride);
  }, [paintPreview]);

  const paintStrokeSegment = useCallback((action: StrokeAction) => {
    const canvas = canvasRef.current;
    const previewLayer = previewLayerRef.current;
    if (!canvas || !previewLayer || action.points.length < 2) return;
    const previewContext = previewLayer.getContext('2d');
    const context = canvas.getContext('2d');
    if (!previewContext || !context) return;
    drawSmoothStroke(previewContext, { ...action, points: action.points.slice(-2) });
    context.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
    drawPaper(context, paper);
    context.drawImage(previewLayer, 0, 0);
  }, [paper]);

  useEffect(() => { rebuildScene(actions); }, [actions, rebuildScene, sourceReady]);

  useEffect(() => {
    selectedTextIdRef.current = selectedTextId;
    if (selectedTextId && textDragRef.current?.id !== selectedTextId && !actions.some((action) => action.kind === 'text' && action.id === selectedTextId)) {
      setSelectedTextId(null);
      selectedTextIdRef.current = null;
      return;
    }
    paintPreview(null);
  }, [actions, paintPreview, selectedTextId]);

  useEffect(() => {
    if (!sourceUrl) return;
    const image = new Image();
    image.crossOrigin = 'anonymous';
    image.decoding = 'async';
    image.onload = () => {
      sourceImageRef.current = image;
      setSourceLoading(false);
      setSourceReady((current) => current + 1);
    };
    image.onerror = () => {
      setSourceLoading(false);
      setSourceError(true);
    };
    image.src = sourceUrl;
    return () => { image.onload = null; image.onerror = null; };
  }, [sourceUrl]);

  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
      if (textDragFrameRef.current !== null) window.cancelAnimationFrame(textDragFrameRef.current);
    };
  }, []);

  useEffect(() => {
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    const backdrop = dialog?.parentElement;
    const parent = backdrop?.parentElement;
    const hiddenSiblings = parent && backdrop
      ? Array.from(parent.children).filter((element): element is HTMLElement => element instanceof HTMLElement && element !== backdrop)
      : [];
    const previousStates = hiddenSiblings.map((element) => ({ element, inert: element.inert, ariaHidden: element.getAttribute('aria-hidden') }));
    for (const element of hiddenSiblings) {
      element.inert = true;
      element.setAttribute('aria-hidden', 'true');
    }
    const frame = window.requestAnimationFrame(() => {
      dialog?.querySelector<HTMLElement>('[data-studio-initial-focus]')?.focus();
    });
    return () => {
      window.cancelAnimationFrame(frame);
      for (const state of previousStates) {
        state.element.inert = state.inert;
        if (state.ariaHidden === null) state.element.removeAttribute('aria-hidden');
        else state.element.setAttribute('aria-hidden', state.ariaHidden);
      }
      previousFocusRef.current?.focus();
    };
  }, [t]);

  useEffect(() => {
    if (!isDirty) return;
    const warnBeforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warnBeforeUnload);
    return () => window.removeEventListener('beforeunload', warnBeforeUnload);
  }, [isDirty]);

  const getPoint = (event: ReactPointerEvent<HTMLCanvasElement>): Point => {
    const rect = event.currentTarget.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(CANVAS_WIDTH, ((event.clientX - rect.left) / rect.width) * CANVAS_WIDTH)),
      y: Math.max(0, Math.min(CANVAS_HEIGHT, ((event.clientY - rect.top) / rect.height) * CANVAS_HEIGHT)),
      pressure: event.pressure || 0.5,
    };
  };

  const updateEraserCursor = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const cursor = eraserCursorRef.current;
    if (!cursor) return;
    if (tool !== 'eraser' || sendingRef.current || sourceLoading || sourceError) {
      cursor.dataset.visible = 'false';
      return;
    }
    const rect = event.currentTarget.getBoundingClientRect();
    const diameter = Math.max(4, size * rect.width / CANVAS_WIDTH);
    cursor.style.width = `${diameter}px`;
    cursor.style.height = `${diameter}px`;
    cursor.style.transform = `translate3d(${event.clientX - rect.left}px,${event.clientY - rect.top}px,0) translate(-50%,-50%)`;
    cursor.dataset.visible = 'true';
  };

  const hideEraserCursor = () => {
    if (eraserCursorRef.current) eraserCursorRef.current.dataset.visible = 'false';
  };

  const commit = useCallback((action: DrawAction) => {
    setHistory((current) => ({ past: [...current.past, current.present], present: { ...current.present, actions: [...current.present.actions, action] }, future: [] }));
  }, []);

  const applyFillAt = (canvas: HTMLCanvasElement, point: Point) => {
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) return;
    paintPreview(null, paper, null);
    try {
      const seed = (Math.imul(fillSeedRef.current++, 2654435761)
        ^ Math.imul(Math.floor(point.x), 374761393)
        ^ Math.imul(Math.floor(point.y), 668265263)) >>> 0;
      const previousAction = actionsRef.current.at(-1);
      const action = previousAction?.kind === 'fill' && fillContainsPoint(previousAction, point)
        ? layerFillAction(previousAction, color, opacity, fillMaterial, fillTexture, fillWater, seed)
        : makeFillAction(context.getImageData(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT), point, color, opacity, fillTolerance, fillMaterial, fillTexture, fillWater, seed);
      if (!action) {
        setHint(t('This region already uses the selected color'));
        return;
      }
      commit(action);
      setHint(t('Filled with {material} · tolerance {tolerance} · ⌘Z to undo', { material: t(activeFillMaterial.label).toLocaleLowerCase(), tolerance: fillTolerance }));
    } catch {
      setHint(t('This image region could not be read. Try again on a new drawing.'));
    }
  };

  const discardWorkingInteraction = (canvas: HTMLCanvasElement) => {
    if (textDragFrameRef.current !== null) {
      window.cancelAnimationFrame(textDragFrameRef.current);
      textDragFrameRef.current = null;
    }
    activePointerRef.current = null;
    panRef.current = null;
    workingRef.current = null;
    textDragRef.current = null;
    pendingTouchFillRef.current = null;
    hideEraserCursor();
    paintPreview(null);
    canvas.dataset.gesture = 'true';
  };

  const applyPendingGesture = () => {
    gestureFrameRef.current = null;
    const pending = pendingGestureRef.current;
    const gesture = gestureRef.current;
    const viewport = viewportRef.current;
    const board = canvasRef.current?.parentElement;
    if (!pending || !gesture || !viewport || !board) return;
    pendingGestureRef.current = null;
    viewport.style.setProperty('--canvas-zoom', `${pending.zoom}%`);
    zoomRef.current = pending.zoom;
    if (zoomOutputRef.current) zoomOutputRef.current.textContent = `${Math.round(pending.zoom)}%`;
    const boardBounds = board.getBoundingClientRect();
    const anchoredClientX = boardBounds.left + boardBounds.width * gesture.anchor.x;
    const anchoredClientY = boardBounds.top + boardBounds.height * gesture.anchor.y;
    viewport.scrollLeft += anchoredClientX - pending.midpoint.x;
    viewport.scrollTop += anchoredClientY - pending.midpoint.y;
  };

  const scheduleGestureFrame = () => {
    const gesture = gestureRef.current;
    if (!gesture) return;
    const first = touchContactsRef.current.get(gesture.pointerIds[0]);
    const second = touchContactsRef.current.get(gesture.pointerIds[1]);
    if (!first || !second) return;
    pendingGestureRef.current = {
      zoom: clampZoom(gesture.startZoom * contactDistance(first, second) / gesture.startDistance),
      midpoint: contactMidpoint(first, second),
    };
    if (gestureFrameRef.current === null) gestureFrameRef.current = window.requestAnimationFrame(applyPendingGesture);
  };

  const startCanvasGesture = (canvas: HTMLCanvasElement) => {
    const contacts = Array.from(touchContactsRef.current.entries()).slice(0, 2);
    if (contacts.length < 2) return;
    const [[firstId, first], [secondId, second]] = contacts;
    const boardBounds = canvas.parentElement?.getBoundingClientRect();
    if (!boardBounds) return;
    const midpoint = contactMidpoint(first, second);
    discardWorkingInteraction(canvas);
    gestureRef.current = {
      pointerIds: [firstId, secondId],
      startDistance: Math.max(1, contactDistance(first, second)),
      startZoom: zoomRef.current,
      anchor: {
        x: Math.max(0, Math.min(1, (midpoint.x - boardBounds.left) / boardBounds.width)),
        y: Math.max(0, Math.min(1, (midpoint.y - boardBounds.top) / boardBounds.height)),
      },
    };
    setHint(t('Pinch to zoom · move two fingers to pan'));
  };

  const finishCanvasGesturePointer = (canvas: HTMLCanvasElement, pointerId: number) => {
    touchContactsRef.current.delete(pointerId);
    const gesture = gestureRef.current;
    if (!gesture) return false;
    const gestureEnded = gesture.pointerIds.includes(pointerId)
      || gesture.pointerIds.some((id) => !touchContactsRef.current.has(id));
    if (gestureEnded) {
      if (gestureFrameRef.current !== null) window.cancelAnimationFrame(gestureFrameRef.current);
      if (pendingGestureRef.current) applyPendingGesture();
      gestureRef.current = null;
      pendingGestureRef.current = null;
      canvas.dataset.gesture = 'false';
      const settledZoom = Math.round(zoomRef.current);
      setZoom(settledZoom);
      setHint(t('Zoom {zoom}% · use two fingers to move around', { zoom: settledZoom }));
    }
    return true;
  };

  const begin = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (sendingRef.current || sourceLoading || sourceError || event.button !== 0) return;
    event.preventDefault();
    if (event.pointerType === 'touch') {
      touchContactsRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
      event.currentTarget.setPointerCapture(event.pointerId);
      if (touchContactsRef.current.size >= 2) {
        if (!gestureRef.current) startCanvasGesture(event.currentTarget);
        return;
      }
    }
    if (activePointerRef.current !== null) return;
    updateEraserCursor(event);
    if (tool === 'hand') {
      const viewport = viewportRef.current;
      if (!viewport) return;
      activePointerRef.current = event.pointerId;
      panRef.current = { x: event.clientX, y: event.clientY, left: viewport.scrollLeft, top: viewport.scrollTop };
      event.currentTarget.setPointerCapture(event.pointerId);
      setHint(t('Drag to move around the drawing'));
      return;
    }
    const point = getPoint(event);
    if (tool === 'fill') {
      if (event.pointerType === 'touch') {
        activePointerRef.current = event.pointerId;
        pendingTouchFillRef.current = { pointerId: event.pointerId, point };
      } else applyFillAt(event.currentTarget, point);
      return;
    }
    if (tool === 'text') {
      const textContext = event.currentTarget.getContext('2d');
      if (!textContext) return;
      const existing = [...actionsRef.current].reverse().find((action): action is TextAction => {
        if (action.kind !== 'text') return false;
        const layout = getTextLayout(textContext, action);
        const padding = 18;
        return point.x >= action.point.x - padding && point.x <= action.point.x + layout.width + padding
          && point.y >= action.point.y - padding && point.y <= action.point.y + layout.height + padding;
      });
      if (!existing && !textValue.trim()) { setHint(t('Enter text in the right panel before placing it on the paper')); return; }
      const draft = existing ?? (() => {
        const safeX = Math.max(24, Math.min(point.x, CANVAS_WIDTH - 260));
        const lineHeight = fontSize * 1.25;
        let visibleLineCount = 1;
        textContext.save();
        textContext.font = `600 ${fontSize}px ui-sans-serif, system-ui, sans-serif`;
        const lineCount = wrapText(textContext, textValue.trim(), CANVAS_WIDTH - safeX - 24).length;
        const maximumLines = Math.max(1, Math.floor((CANVAS_HEIGHT - 48) / lineHeight));
        visibleLineCount = Math.min(lineCount, maximumLines);
        textContext.restore();
        const safeY = Math.max(24, Math.min(point.y, CANVAS_HEIGHT - visibleLineCount * lineHeight - 24));
        return { kind: 'text' as const, id: crypto.randomUUID(), point: { ...point, x: safeX, y: safeY }, text: textValue.trim(), color, size: fontSize, opacity };
      })();
      activePointerRef.current = event.pointerId;
      event.currentTarget.setPointerCapture(event.pointerId);
      selectedTextIdRef.current = draft.id;
      setSelectedTextId(draft.id);
      textDragRef.current = { id: draft.id, start: point, origin: draft.point, current: draft, isNew: !existing, moved: false };
      paintTextDrag(draft);
      setHint(existing ? t('Text selected · drag to reposition') : t('Press and drag to choose a position · release to place text'));
      return;
    }
    activePointerRef.current = event.pointerId;
    event.currentTarget.setPointerCapture(event.pointerId);
    const action: DrawAction = tool === 'pen' || tool === 'marker' || tool === 'eraser'
      ? { kind: 'stroke', tool, points: [point], color, size, opacity }
      : { kind: 'shape', tool, from: point, to: point, color, size, opacity, filled };
    workingRef.current = action;
    paintPreview(action);
  };

  const move = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (event.pointerType === 'touch') {
      touchContactsRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (gestureRef.current) {
        event.preventDefault();
        scheduleGestureFrame();
        return;
      }
    }
    updateEraserCursor(event);
    if (event.pointerId !== activePointerRef.current) return;
    event.preventDefault();
    if (pendingTouchFillRef.current?.pointerId === event.pointerId) {
      const point = getPoint(event);
      if (Math.hypot(point.x - pendingTouchFillRef.current.point.x, point.y - pendingTouchFillRef.current.point.y) > 8) {
        pendingTouchFillRef.current = null;
        setHint(t('Tap without dragging to fill a region'));
      }
      return;
    }
    if (panRef.current) {
      const viewport = viewportRef.current;
      if (!viewport) return;
      viewport.scrollLeft = panRef.current.left - (event.clientX - panRef.current.x);
      viewport.scrollTop = panRef.current.top - (event.clientY - panRef.current.y);
      return;
    }
    if (textDragRef.current) {
      const point = getPoint(event);
      const drag = textDragRef.current;
      const context = event.currentTarget.getContext('2d');
      if (!context) return;
      const layout = getTextLayout(context, drag.current);
      const nextPoint = {
        ...drag.current.point,
        x: Math.max(16, Math.min(CANVAS_WIDTH - layout.width - 16, drag.origin.x + point.x - drag.start.x)),
        y: Math.max(16, Math.min(CANVAS_HEIGHT - layout.height - 16, drag.origin.y + point.y - drag.start.y)),
      };
      drag.current = { ...drag.current, point: nextPoint };
      drag.moved ||= Math.hypot(point.x - drag.start.x, point.y - drag.start.y) > 2;
      if (textDragFrameRef.current === null) {
        textDragFrameRef.current = window.requestAnimationFrame(() => {
          textDragFrameRef.current = null;
          const latest = textDragRef.current;
          if (latest) paintTextDrag(latest.current);
        });
      }
      return;
    }
    if (!workingRef.current) return;
    let point = getPoint(event);
    const current = workingRef.current;
    if (current.kind === 'stroke') {
      const previous = current.points[current.points.length - 1];
      if (Math.hypot(point.x - previous.x, point.y - previous.y) < 1.5) return;
      current.points.push(point);
      paintStrokeSegment(current);
    } else if (current.kind === 'shape') {
      if (event.shiftKey && isClosedShapeTool(current.tool)) {
        const deltaX = point.x - current.from.x;
        const deltaY = point.y - current.from.y;
        const side = Math.max(Math.abs(deltaX), Math.abs(deltaY));
        point = { ...point, x: current.from.x + (Math.sign(deltaX) || 1) * side, y: current.from.y + (Math.sign(deltaY) || 1) * side };
      }
      workingRef.current = { ...current, to: point };
      paintPreview(workingRef.current);
    }
  };

  const finish = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (event.pointerType === 'touch') {
      const wasGesture = finishCanvasGesturePointer(event.currentTarget, event.pointerId);
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      hideEraserCursor();
      if (wasGesture) return;
    }
    if (event.pointerId !== activePointerRef.current) return;
    if (textDragFrameRef.current !== null) {
      window.cancelAnimationFrame(textDragFrameRef.current);
      textDragFrameRef.current = null;
    }
    event.preventDefault();
    activePointerRef.current = null;
    panRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (event.pointerType === 'touch') hideEraserCursor();
    const pendingFill = pendingTouchFillRef.current;
    pendingTouchFillRef.current = null;
    if (pendingFill?.pointerId === event.pointerId) {
      applyFillAt(event.currentTarget, pendingFill.point);
      return;
    }
    const textDrag = textDragRef.current;
    textDragRef.current = null;
    if (textDrag) {
      paintTextDrag(textDrag.current);
      if (textDrag.isNew) commit(textDrag.current);
      else if (textDrag.moved) {
        setHistory((current) => ({
          past: [...current.past, current.present],
          present: { ...current.present, actions: current.present.actions.map((action) => action.kind === 'text' && action.id === textDrag.id ? textDrag.current : action) },
          future: [],
        }));
      } else paintPreview(null);
      setHint(textDrag.moved
        ? t('Moved text to X {x} · Y {y} · ⌘Z to undo', { x: Math.round(textDrag.current.point.x), y: Math.round(textDrag.current.point.y) })
        : t('Text is selected · drag it directly to move'));
      return;
    }
    const action = workingRef.current;
    workingRef.current = null;
    textDragRef.current = null;
    if (action) { commit(action); setHint(t('Stroke saved · ⌘Z to undo')); }
  };

  const cancelStroke = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (event.pointerType === 'touch' && finishCanvasGesturePointer(event.currentTarget, event.pointerId)) {
      hideEraserCursor();
      return;
    }
    if (event.pointerId !== activePointerRef.current) return;
    if (textDragFrameRef.current !== null) {
      window.cancelAnimationFrame(textDragFrameRef.current);
      textDragFrameRef.current = null;
    }
    activePointerRef.current = null;
    panRef.current = null;
    workingRef.current = null;
    textDragRef.current = null;
    pendingTouchFillRef.current = null;
    hideEraserCursor();
    paintPreview(null);
  };

  const deleteSelectedText = useCallback(() => {
    const textId = selectedTextIdRef.current;
    if (!textId) return;
    setHistory((current) => {
      if (!current.present.actions.some((action) => action.kind === 'text' && action.id === textId)) return current;
      return {
        past: [...current.past, current.present],
        present: { ...current.present, actions: current.present.actions.filter((action) => action.kind !== 'text' || action.id !== textId) },
        future: [],
      };
    });
    selectedTextIdRef.current = null;
    setSelectedTextId(null);
    setHint(t('Text deleted · ⌘Z to restore'));
  }, [t]);

  const undo = useCallback(() => {
    setHistory((current) => {
      const previous = current.past[current.past.length - 1];
      if (!previous) return current;
      return { past: current.past.slice(0, -1), present: previous, future: [current.present, ...current.future] };
    });
  }, []);

  const redo = useCallback(() => {
    setHistory((current) => {
      const next = current.future[0];
      if (!next) return current;
      return { past: [...current.past, current.present], present: next, future: current.future.slice(1) };
    });
  }, []);

  const clear = () => {
    if (!actions.length) return;
    setHistory((current) => ({ past: [...current.past, current.present], present: { ...current.present, actions: [] }, future: [] }));
    setHint(sourceUrl ? t('New marks cleared · the original is unchanged') : t('Canvas cleared · you can undo'));
  };

  const changePaper = (nextPaper: Paper) => {
    if (nextPaper === paper) return;
    setHistory((current) => ({ past: [...current.past, current.present], present: { ...current.present, paper: nextPaper }, future: [] }));
  };

  const send = async () => {
    const canvas = canvasRef.current;
    if (!canvas || sendingRef.current || sourceLoading || sourceError || paletteMutating) return;
    if (!canSendCanvas) {
      setHint(t('Draw at least one mark or choose a paper before sending.'));
      return;
    }
    if (textDragFrameRef.current !== null) {
      window.cancelAnimationFrame(textDragFrameRef.current);
      textDragFrameRef.current = null;
    }
    sendingRef.current = true;
    setSending(true);
    const pending = workingRef.current;
    const exportActions = pending ? [...actions, pending] : actions;
    if (pending) {
      const pointerId = activePointerRef.current;
      if (pointerId !== null && canvas.hasPointerCapture(pointerId)) canvas.releasePointerCapture(pointerId);
      activePointerRef.current = null;
      panRef.current = null;
      workingRef.current = null;
      commit(pending);
    }
    selectedTextIdRef.current = null;
    rebuildScene(exportActions, paper);
    try {
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png', 0.95));
      if (!blob) throw new Error(t('The drawing could not be exported.'));
      await onSend(blob, caption.trim());
      await deleteStudioDraft(draftKey).catch(() => undefined);
    } finally {
      selectedTextIdRef.current = selectedTextId;
      sendingRef.current = false;
      setSending(false);
    }
  };

  const requestClose = () => {
    if (paletteMutating) return;
    if (isDirty && !window.confirm(t('This drawing has not been sent. Close Nét Studio anyway?'))) return;
    onClose();
  };

  const applyPaletteColor = (nextColor: string, name?: string) => {
    setColor(nextColor.toUpperCase());
    setHint(name ? t('Using “{name}” from your palette', { name }) : t('Using mixed color {color}', { color: nextColor.toUpperCase() }));
  };

  const updateMixerComponent = (id: string, update: Partial<PigmentComponent>) => {
    setMixerComponents((current) => current.map((component) => component.id === id ? { ...component, ...update } : component));
  };

  const addMixerComponent = () => {
    setMixerComponents((current) => {
      if (current.length >= MAX_PIGMENT_COMPONENTS) return current;
      const colorIndex = (current.length - INITIAL_MIXER_COMPONENTS.length) % ADDED_PIGMENT_COLORS.length;
      return [...current, { id: `pigment-${mixerIdRef.current++}`, color: ADDED_PIGMENT_COLORS[Math.max(0, colorIndex)], weight: 1 }];
    });
  };

  const removeMixerComponent = (id: string) => {
    setMixerComponents((current) => current.length <= 2 ? current : current.filter((component) => component.id !== id));
  };

  const loadPaletteFormula = (savedColor: PaletteColorView) => {
    setMixerComponents(savedColor.components.map((component) => ({ ...component, id: `pigment-${mixerIdRef.current++}` })));
    setMixerOpen(true);
    setPaletteError('');
    setHint(t('Loaded “{name}” to continue mixing', { name: savedColor.name }));
  };

  const saveMixedColor = async () => {
    if (paletteLoading || paletteMutating || paletteSaving) return;
    setPaletteSaving(true);
    setPaletteError('');
    try {
      await onSavePalette({ name: mixerName.trim(), components: pigmentFormula.map((component) => ({ ...component, color: component.color.toUpperCase() })) });
      setMixerName('');
      applyPaletteColor(mixedColor);
      setHint(t('Saved {color} to your palette', { color: mixedColor }));
    } catch (saveError) {
      setPaletteError(saveError instanceof Error ? saveError.message : t('The color could not be saved to your palette.'));
    } finally {
      setPaletteSaving(false);
    }
  };

  const deletePaletteColor = async (savedColor: PaletteColorView) => {
    if (paletteLoading || paletteMutating) return;
    setPaletteError('');
    try { await onDeletePalette(savedColor.id); }
    catch (deleteError) { setPaletteError(deleteError instanceof Error ? deleteError.message : t('This color could not be deleted.')); }
  };

  const closeMixer = (restoreFocus = false) => {
    setMixerOpen(false);
    if (restoreFocus) requestAnimationFrame(() => mixerToggleRef.current?.focus());
  };

  const shapeTrigger = useCallback(() => typeof window !== 'undefined' && window.matchMedia('(max-width: 720px)').matches
    ? moreToolsButtonRef.current
    : shapeButtonRef.current, []);

  const focusShapeTrigger = useCallback(() => shapeTrigger()?.focus(), [shapeTrigger]);

  const selectTool = (nextTool: Tool) => {
    const restoreShapeFocus = shapeMenuOpen;
    const moveFocusToCanvas = moreToolsOpen;
    const openMobileProperties = moreToolsOpen
      && typeof window !== 'undefined'
      && window.matchMedia('(max-width: 720px)').matches
      && nextTool !== 'hand';
    if (openMobileProperties) mobileInspectorTriggerRef.current = moreToolsButtonRef.current;
    setShapeMenuOpen(false);
    setMoreToolsOpen(false);
    setMobileInspectorOpen(openMobileProperties);
    setTool(nextTool);
    if (isClosedShapeTool(nextTool)) setSelectedShape(nextTool);
    if (nextTool !== 'text') {
      selectedTextIdRef.current = null;
      setSelectedTextId(null);
    }
    if (nextTool === 'fill') setHint(t('Tap a closed region on the paper to fill it'));
    if (restoreShapeFocus) requestAnimationFrame(focusShapeTrigger);
    else if (moveFocusToCanvas && !openMobileProperties) requestAnimationFrame(() => canvasRef.current?.focus());
  };

  const selectDockTool = (nextTool: Tool) => {
    const reopenProperties = typeof window !== 'undefined'
      && window.matchMedia('(max-width: 720px)').matches
      && tool === nextTool;
    if (reopenProperties && document.activeElement instanceof HTMLButtonElement) mobileInspectorTriggerRef.current = document.activeElement;
    selectTool(nextTool);
    if (reopenProperties) setMobileInspectorOpen(true);
  };

  const closeMobileInspector = () => {
    setMobileInspectorOpen(false);
    const trigger = mobileInspectorTriggerRef.current;
    requestAnimationFrame(() => (trigger?.isConnected ? trigger : canvasRef.current)?.focus());
  };

  const toggleMoreTools = () => {
    setShapeMenuOpen(false);
    if (moreToolsOpen) {
      setMoreToolsOpen(false);
      return;
    }
    setMoreToolsOpen(true);
  };

  useEffect(() => {
    if (!moreToolsOpen) return;
    const frame = requestAnimationFrame(() => moreToolsSheetRef.current?.querySelector<HTMLButtonElement>('[data-more-tool]')?.focus());
    return () => cancelAnimationFrame(frame);
  }, [moreToolsOpen]);

  useEffect(() => {
    if (!mobileInspectorOpen) return;
    const frame = requestAnimationFrame(() => document.querySelector<HTMLButtonElement>('#tool-properties .mobile-inspector-header button')?.focus());
    return () => cancelAnimationFrame(frame);
  }, [mobileInspectorOpen]);

  useEffect(() => {
    const desktop = window.matchMedia('(min-width: 721px)');
    const leaveMobileSheetMode = () => {
      if (desktop.matches) setMobileInspectorOpen(false);
    };
    leaveMobileSheetMode();
    desktop.addEventListener('change', leaveMobileSheetMode);
    return () => desktop.removeEventListener('change', leaveMobileSheetMode);
  }, []);

  const positionShapeMenu = useCallback(() => {
    const button = shapeTrigger();
    if (!button) return;
    const bounds = button.getBoundingClientRect();
    const viewportPadding = 8;
    const menuWidth = Math.min(292, window.innerWidth - viewportPadding * 2);
    const menu = document.getElementById('shape-picker');
    const menuHeight = Math.min(menu?.getBoundingClientRect().height ?? 294, window.innerHeight - viewportPadding * 2);
    const rail = button.closest<HTMLElement>('.tool-rail');
    const railStyle = rail ? window.getComputedStyle(rail) : null;
    const horizontalRail = railStyle ? railStyle.display === 'grid' || railStyle.flexDirection === 'row' : window.innerWidth <= 720;
    const preferredLeft = horizontalRail ? bounds.left : bounds.right + 10;
    const fallbackLeft = bounds.left - menuWidth - 10;
    const left = Math.max(
      viewportPadding,
      Math.min(
        horizontalRail || preferredLeft + menuWidth <= window.innerWidth - viewportPadding ? preferredLeft : fallbackLeft,
        window.innerWidth - menuWidth - viewportPadding,
      ),
    );
    const preferredTop = horizontalRail ? bounds.bottom + 8 : bounds.top - 104;
    const top = Math.max(viewportPadding, Math.min(preferredTop, window.innerHeight - menuHeight - viewportPadding));
    setShapeMenuPosition({ left, top });
  }, [shapeTrigger]);

  const toggleShapeMenu = () => {
    if (!shapeMenuOpen) positionShapeMenu();
    setShapeMenuOpen((open) => !open);
  };

  useEffect(() => {
    if (!shapeMenuOpen) return;
    const reposition = () => positionShapeMenu();
    const frame = requestAnimationFrame(() => {
      reposition();
      const picker = document.getElementById('shape-picker');
      if (picker && !picker.contains(document.activeElement)) picker.querySelector<HTMLElement>('.shape-options button')?.focus();
    });
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
    };
  }, [positionShapeMenu, shapeMenuOpen]);

  useEffect(() => {
    if (!shapeMenuOpen) return;
    const dismissShapePicker = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      setShapeMenuOpen(false);
      requestAnimationFrame(focusShapeTrigger);
    };
    document.addEventListener('keydown', dismissShapePicker, true);
    return () => document.removeEventListener('keydown', dismissShapePicker, true);
  }, [focusShapeTrigger, shapeMenuOpen]);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key === 'Tab') {
      const dialog = dialogRef.current;
      if (!dialog) return;
      const focusRoot = mobileInspectorOpen ? dialog.querySelector<HTMLElement>('#tool-properties') : dialog;
      if (!focusRoot) return;
      const focusable = Array.from(focusRoot.querySelectorAll<HTMLElement>('button:not(:disabled):not([tabindex="-1"]), input:not(:disabled), textarea:not(:disabled), canvas[tabindex="0"], [tabindex]:not([tabindex="-1"])')).filter((element) => element.getClientRects().length > 0);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      return;
    }
    if (event.key === 'Escape' && moreToolsOpen) {
      event.preventDefault();
      setMoreToolsOpen(false);
      moreToolsButtonRef.current?.focus();
      return;
    }
    if (event.key === 'Escape' && mobileInspectorOpen) {
      event.preventDefault();
      closeMobileInspector();
      return;
    }
    if (event.key === 'Escape' && shapeMenuOpen) {
      event.preventDefault();
      setShapeMenuOpen(false);
      focusShapeTrigger();
      return;
    }
    if (event.key === 'Escape') { requestClose(); return; }
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); void send(); return; }
    const editingText = event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement;
    if (editingText) return;
    if ((event.key === 'Delete' || event.key === 'Backspace') && selectedTextIdRef.current) {
      event.preventDefault();
      deleteSelectedText();
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase() === 'z') {
      event.preventDefault();
      if (event.shiftKey) redo(); else undo();
      return;
    }
    const shortcut = TOOL_BY_KEY.get(event.key.toLocaleLowerCase());
    if (shortcut) selectTool(shortcut);
  };

  const zoomStyle = { '--canvas-zoom': `${zoom}%` } as CSSProperties;
  const activeTool = TOOLS.find((item) => item.id === tool) ?? TOOLS[1];
  const activeShape = SHAPE_TOOLS.find((item) => item.id === selectedShape) ?? SHAPE_TOOLS[0];
  const closedShapeTool = isClosedShapeTool(tool);
  const editingTool = tool !== 'hand';
  const paletteAvailable = tool !== 'hand' && tool !== 'eraser';
  const sendLabel = sourceError
    ? t('Original could not be loaded')
    : sourceLoading
      ? t('Loading original…')
      : paletteMutating
        ? t('Saving palette…')
        : sending
          ? t('Sending…')
          : canSendCanvas
            ? t('Send Drawing')
            : t('Draw Before Sending');

  return (
    <div className="studio-backdrop">
      <section ref={dialogRef} className="studio advanced-studio" role="dialog" aria-modal="true" aria-labelledby="studio-title" onKeyDown={onKeyDown} tabIndex={-1}>
        <header className="studio-header advanced-studio-header" inert={mobileInspectorOpen ? true : undefined}>
          <button type="button" className="plain-button" onClick={requestClose} disabled={paletteMutating} data-studio-initial-focus>{t('Close')} <kbd>Esc</kbd></button>
          <div><small className={sourceUrl ? 'studio-source-label' : ''}>{sourceIsDraft ? t('Starting from your first mark') : sourceUrl ? t('Continuing version {version}', { version: version ?? 1 }) : 'Canvas 1200 × 720'}</small><h2 id="studio-title">Nét Studio</h2></div>
          <button type="button" className="primary-button studio-header-send" onClick={() => void send()} disabled={!canSendCanvas || paletteMutating || sending || sourceLoading || sourceError} title={!canSendCanvas ? t('Draw at least one mark or choose a paper before sending') : undefined}>{sendLabel}</button>
        </header>

        <div className="studio-workspace">
          <div className="tool-rail-shell" inert={mobileInspectorOpen ? true : undefined}>
            <aside className="tool-rail" aria-label={t('Drawing tools')}>
              {RAIL_TOOLS.map((item) => <button type="button" key={item.id} className={`${tool === item.id ? 'tool-button active' : 'tool-button'} ${MORE_TOOLS.some((moreTool) => moreTool.id === item.id) ? 'secondary-tool' : ''}`} data-tool-id={item.id} onClick={() => item.id === 'pen' || item.id === 'eraser' ? selectDockTool(item.id) : selectTool(item.id)} title={t('{tool} — key {key}', { tool: t(item.label), key: item.key })} aria-label={`${t(item.label)} (${item.key})`} aria-pressed={tool === item.id}><b><ToolIcon tool={item.id} /></b><span className="desktop-tool-label">{t(item.label)}</span><span className="mobile-tool-label">{item.id === 'hand' ? t('Pan') : item.id === 'pen' ? t('Pencil') : item.id === 'eraser' ? t('Eraser') : t(item.label)}</span></button>)}
              <button type="button" ref={shapeButtonRef} className={closedShapeTool ? 'tool-button active' : 'tool-button'} data-tool-id="shape" onClick={toggleShapeMenu} title={t('Choose shape — currently {shape}', { shape: t(activeShape.label) })} aria-label={t('Shape ({shape})', { shape: t(activeShape.label) })} aria-pressed={closedShapeTool} aria-haspopup="dialog" aria-expanded={shapeMenuOpen} aria-controls="shape-picker"><b><ToolIcon tool={selectedShape} /></b><span className="desktop-tool-label">{t('Shapes')}</span><span className="mobile-tool-label">{t('Shape')}</span></button>
              <button type="button" className={tool === 'text' ? 'tool-button active' : 'tool-button'} data-tool-id="text" onClick={() => selectTool('text')} title={t('{tool} — key {key}', { tool: t(TEXT_TOOL.label), key: TEXT_TOOL.key })} aria-label={`${t(TEXT_TOOL.label)} (${TEXT_TOOL.key})`} aria-pressed={tool === 'text'}><b><ToolIcon tool="text" /></b><span className="desktop-tool-label">{t(TEXT_TOOL.label)}</span><span className="mobile-tool-label">{t('Text')}</span></button>
              <button type="button" className="tool-button mobile-color-tool" onClick={(event) => { if (mobileInspectorOpen) closeMobileInspector(); else { mobileInspectorTriggerRef.current = event.currentTarget; setMobileInspectorOpen(true); } }} aria-label={t('Color and tool settings')} aria-expanded={mobileInspectorOpen} aria-controls="tool-properties"><b><i style={{ background: color }} /></b><span className="mobile-tool-label">{t('Color')}</span></button>
              <button type="button" className="tool-button mobile-undo-tool" onClick={undo} disabled={!history.past.length} aria-label={t('Undo')}><b>↶</b><span className="mobile-tool-label">{t('Undo')}</span></button>
              <button type="button" ref={moreToolsButtonRef} className={MORE_TOOLS.some((item) => item.id === tool) ? 'tool-button more-tools-button active' : 'tool-button more-tools-button'} onClick={toggleMoreTools} aria-label={t('More tools')} aria-haspopup="dialog" aria-expanded={moreToolsOpen} aria-controls="more-tools-sheet"><b><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" aria-hidden="true"><circle cx="5" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /></svg></b><span className="mobile-tool-label">{t('More')}</span></button>
            </aside>
          </div>

          {moreToolsOpen ? <>
            <div className="more-tools-dismiss" aria-hidden="true" onPointerDown={() => { setMoreToolsOpen(false); moreToolsButtonRef.current?.focus(); }} />
            <section ref={moreToolsSheetRef} id="more-tools-sheet" className="more-tools-sheet" role="dialog" aria-modal="false" aria-labelledby="more-tools-title">
              <header><div><small>Nét Studio</small><strong id="more-tools-title">{t('More Tools')}</strong></div><button type="button" onClick={() => { setMoreToolsOpen(false); moreToolsButtonRef.current?.focus(); }} aria-label={t('Close more tools')}>×</button></header>
              <div>{MOBILE_MORE_TOOLS.map((item) => <button type="button" key={item.id} data-more-tool className={tool === item.id ? 'active' : ''} onClick={() => selectTool(item.id)} aria-label={`${t(item.label)} (${item.key})`} aria-pressed={tool === item.id}><ToolIcon tool={item.id} /><span><strong>{t(item.label)}</strong><small>{t('Key {key}', { key: item.key })}</small></span></button>)}<button type="button" data-more-tool className={closedShapeTool ? 'active' : ''} onClick={() => { setMoreToolsOpen(false); requestAnimationFrame(toggleShapeMenu); }} aria-label={t('Choose a Shape')}><ToolIcon tool={selectedShape} /><span><strong>{t('Shapes')}</strong><small>{t(activeShape.label)}</small></span></button><button type="button" data-more-tool className={tool === 'text' ? 'active' : ''} onClick={() => selectTool('text')} aria-label={t('Text')}><ToolIcon tool="text" /><span><strong>{t('Text')}</strong><small>{t('Place movable text')}</small></span></button></div>
            </section>
          </> : null}

          {shapeMenuOpen ? <>
            <div className="shape-popover-dismiss" aria-hidden="true" onPointerDown={() => { setShapeMenuOpen(false); focusShapeTrigger(); }} />
            <section id="shape-picker" className="shape-popover" role="dialog" aria-modal="false" aria-labelledby="shape-picker-title" style={shapeMenuPosition}>
              <header><div><small>{t('Geometry')}</small><strong id="shape-picker-title">{t('Choose a Shape')}</strong></div><button type="button" onClick={() => { setShapeMenuOpen(false); focusShapeTrigger(); }} aria-label={t('Close shape picker')} data-tooltip={t('Close')} data-tooltip-placement="below">×</button></header>
              <div className="shape-options" role="group" aria-label={t('Choose shape type')}>{SHAPE_TOOLS.map((item) => <button type="button" key={item.id} className={selectedShape === item.id ? 'active' : ''} onClick={() => selectTool(item.id)} aria-label={t(item.label)} aria-pressed={selectedShape === item.id}><ToolIcon tool={item.id} /><span>{t(item.label)}</span><kbd>{item.key}</kbd></button>)}</div>
              <p className="shape-tool-help">{t('Draw immediately after choosing. Hold')} <kbd>Shift</kbd> {t('while dragging to keep both dimensions even.')}</p>
            </section>
          </> : null}

          <div className="canvas-panel" inert={mobileInspectorOpen ? true : undefined}>
            <div className="canvas-commandbar">
              <div><button type="button" onClick={undo} disabled={!history.past.length} aria-label={t('Undo')} data-tooltip={t('Undo')} data-tooltip-placement="below">↶</button><button type="button" onClick={redo} disabled={!history.future.length} aria-label={t('Redo')} data-tooltip={t('Redo')} data-tooltip-placement="below">↷</button><button type="button" onClick={clear} disabled={!actions.length} aria-label={t('Clear new marks')} data-tooltip={t('Clear new marks')} data-tooltip-placement="below">⌫</button></div>
              <span><strong>{t(activeTool.label)}</strong><kbd>{activeTool.key}</kbd><i aria-hidden="true">·</i>{t('{count} actions', { count: actions.length })}</span>
              <div className="zoom-control"><button type="button" onClick={() => setZoom((value) => { const next = clampZoom(value - 10); zoomRef.current = next; return next; })} aria-label={t('Zoom out')} data-tooltip={t('Zoom out')} data-tooltip-placement="below">−</button><output ref={zoomOutputRef} aria-label={t('Zoom level')}>{zoom}%</output><button type="button" onClick={() => setZoom((value) => { const next = clampZoom(value + 10); zoomRef.current = next; return next; })} aria-label={t('Zoom in')} data-tooltip={t('Zoom in')} data-tooltip-placement="below">＋</button></div>
            </div>
            <div ref={viewportRef} className="canvas-viewport" style={zoomStyle}>
              <div className="canvas-board">
                <canvas ref={canvasRef} width={CANVAS_WIDTH} height={CANVAS_HEIGHT} onPointerDown={begin} onPointerEnter={updateEraserCursor} onPointerMove={move} onPointerLeave={hideEraserCursor} onPointerUp={finish} onPointerCancel={cancelStroke} aria-label={t('Advanced drawing area')} aria-disabled={sending || sourceLoading || sourceError} data-tool={tool} data-text-selected={Boolean(selectedTextId)} data-sending={sending} tabIndex={0}>{t('Canvas supports mouse, stylus, and touch input.')}</canvas>
                <span ref={eraserCursorRef} className="eraser-size-cursor" data-visible="false" aria-hidden="true" />
                {sourceLoading ? <span className="canvas-loading">{t('Loading the original to continue drawing…')}</span> : null}
                {sourceError ? <span className="canvas-loading canvas-error">{t('The original could not be loaded. Close Studio and try again.')}</span> : null}
              </div>
            </div>
            <div className="canvas-status"><span role="status" aria-live="polite"><i /> {hint}{draftStatus !== 'idle' ? <b className="draft-status"> · {draftStatus === 'saving' ? t('Saving draft…') : draftStatus === 'restored' ? t('Draft restored') : t('Draft saved')}</b> : null}</span><span className="canvas-shortcuts">⌘Z {t('undo')} · Shift⌘Z {t('redo')}</span><span className="canvas-gesture-help">{t('One finger draws · two fingers zoom and pan')}</span></div>
          </div>

          {mobileInspectorOpen && <button type="button" tabIndex={-1} className="mobile-inspector-dismiss" onClick={closeMobileInspector} aria-label={t('Close tool settings')} />}
          <aside id="tool-properties" className={mobileInspectorOpen ? 'tool-inspector mobile-open' : 'tool-inspector'} role={mobileInspectorOpen ? 'dialog' : undefined} aria-modal={mobileInspectorOpen ? true : undefined} aria-labelledby={mobileInspectorOpen ? 'mobile-tool-settings-title' : undefined} aria-label={mobileInspectorOpen ? undefined : t('Tool properties')}>
            <header className="mobile-inspector-header"><span><small>{t(activeTool.label)}</small><strong id="mobile-tool-settings-title">{t('Tool Settings')}</strong></span><button type="button" onClick={closeMobileInspector} aria-label={t('Close tool settings')}>×</button></header>
            {editingTool ? <>
              {tool !== 'eraser' ? <section><div className="inspector-title"><span>{t('Color')}</span><output>{color.toUpperCase()}</output></div><div className="advanced-color-row">{COLORS.map((item) => <button type="button" key={item} className={color.toUpperCase() === item.toUpperCase() ? 'color active' : 'color'} style={{ background: item }} onClick={() => setColor(item)} aria-label={t('Choose color {color}', { color: item })} aria-pressed={color.toUpperCase() === item.toUpperCase()} />)}<label className="custom-color" title={t('Custom color')}>＋<input type="color" name="custom-color" value={color} onChange={(event) => setColor(event.target.value.toUpperCase())} aria-label={t('Choose a custom color')} /></label></div>{paletteAvailable ? <button type="button" ref={mixerToggleRef} className="mixer-toggle" onClick={() => { setMixerOpen((open) => !open); setPaletteError(''); }} aria-label={mixerOpen ? t('Close advanced color mixing') : t('Open advanced color mixing')} aria-expanded={mixerOpen} aria-controls="pigment-mixer"><span aria-hidden="true">◒</span>{mixerOpen ? t('Close Mixer') : t('Advanced Color Mixing')}</button> : null}</section> : null}
              {paletteAvailable && mixerOpen ? (
                <><button type="button" className="mixer-sheet-dismiss" onClick={() => closeMixer(true)} aria-label={t('Close advanced color mixing')} />
                <section id="pigment-mixer" className="pigment-mixer" role="region" aria-label={t('Advanced Color Mixing')}>
                  <div className="mixer-heading"><div><small>{t('Advanced Color Mixing')}</small><strong>{t('Mix Multiple Colors')}</strong></div><button type="button" onClick={() => closeMixer(true)} aria-label={t('Close advanced color mixing')} data-tooltip={t('Close Mixer')} data-tooltip-placement="below">×</button></div>
                  <div className="mixer-preview-sticky">
                    <div className="mixed-result"><span style={{ background: mixedColor }} aria-hidden="true" /><div><small>{t('Mixed Color')}</small><strong>{mixedColor}</strong></div><output>{t('{count} components', { count: mixerComponents.length })}</output></div>
                    <div className="mixture-composition" aria-label={t('Normalized proportions')}>{mixerComponents.map((component, index) => <i key={component.id} style={{ background: component.color, width: `${mixerPercentages[index]}%` }} title={t('Color {number}: {percentage}%', { number: index + 1, percentage: mixerPercentages[index] })} />)}</div>
                  </div>
                  <div className="pigment-components" role="list" aria-label={t('Component colors')}>
                    {mixerComponents.map((component, index) => (
                      <article key={component.id} className="pigment-component" role="listitem">
                        <header><strong>{t('Color {number}', { number: index + 1 })}</strong><output>{mixerPercentages[index]}%</output><button type="button" onClick={() => removeMixerComponent(component.id)} disabled={mixerComponents.length <= 2} aria-label={t('Remove color {number}', { number: index + 1 })}>×</button></header>
                        <div>
                          <label className="pigment-color-input"><input type="color" value={component.color} onChange={(event) => updateMixerComponent(component.id, { color: event.target.value.toUpperCase() })} aria-label={t('Color {number}', { number: index + 1 })} /><span style={{ background: component.color }} aria-hidden="true" /><output>{component.color.toUpperCase()}</output></label>
                          <label className="pigment-weight-input"><span>{t('Parts')}</span><input type="number" min="1" max="100" step="1" value={component.weight} onChange={(event) => updateMixerComponent(component.id, { weight: Math.max(1, Math.min(100, Math.round(Number(event.target.value) || 1))) })} aria-label={t('Parts for color {number}', { number: index + 1 })} /></label>
                        </div>
                      </article>
                    ))}
                  </div>
                  <button type="button" className="add-pigment" onClick={addMixerComponent} disabled={mixerComponents.length >= MAX_PIGMENT_COMPONENTS} aria-label={t('Add component color')}>＋ {t('Add Color')} <span>{mixerComponents.length}/{MAX_PIGMENT_COMPONENTS}</span></button>
                  <p className="mix-parts-note">{t('Add 2 to 12 colors. Parts describe each color’s contribution; Nét converts them to percentages automatically.')}</p>
                  <div className="mixer-footer-actions">
                    <button type="button" className="use-mixed-color" onClick={() => applyPaletteColor(mixedColor)}>{t('Use Color')}</button>
                    <label className="mix-name" htmlFor="mixed-color-name">{t('Palette Name')}<input id="mixed-color-name" name="mixed-color-name" autoComplete="off" value={mixerName} onChange={(event) => setMixerName(event.target.value)} maxLength={40} placeholder={t('Mixed color {number}…', { number: paletteColors.length + 1 })} aria-label={t('Mixed color name')} /></label>
                    <button type="button" className="save-mixed-color" onClick={() => void saveMixedColor()} disabled={paletteLoading || paletteMutating || paletteSaving || paletteColors.length >= 24}>{paletteLoading ? t('Opening palette…') : paletteMutating || paletteSaving ? t('Saving…') : paletteColors.length >= 24 ? t('Palette is full at 24 colors') : palettePersistence === 'account' ? t('Save to Account') : t('Save for Session')}</button>
                  </div>
                  <details className="pigment-details"><summary>{t('About Color Simulation')}</summary><p className="pigment-note">{t('This is an approximate multi-color Kubelka–Munk simulation derived from sRGB/D65. Ratios are model inputs, not physical recipes. Accurate paint or ink prediction requires measured K/S data for each pigment, binder, and paper.')}</p></details>
                  {paletteError ? <p className="palette-error" role="alert">{paletteError}</p> : null}
                </section></>
              ) : null}
              {paletteAvailable && (paletteLoading || paletteColors.length > 0 || Boolean(paletteError)) ? (
                <section className="palette-library">
                  <div className="inspector-title"><span>{t('Your Palette')}</span><output>{paletteLoading ? t('Loading…') : `${paletteColors.length}/24`}</output></div>
                  {paletteColors.length ? <div className="saved-palette">{paletteColors.map((savedColor) => (
                    <div key={savedColor.id} className="saved-color">
                      <button type="button" className={color.toUpperCase() === savedColor.color ? 'saved-color-use active' : 'saved-color-use'} onClick={() => applyPaletteColor(savedColor.color, savedColor.name)} aria-label={t('Use color {name}', { name: savedColor.name })} aria-pressed={color.toUpperCase() === savedColor.color}><i style={{ background: savedColor.color }} /><span><strong>{savedColor.name}</strong><small>{t('{color} · {count} colors · formula v{version}', { color: savedColor.color, count: savedColor.components.length, version: savedColor.model.version })}</small></span></button>
                      <button type="button" className="saved-color-load" onClick={() => loadPaletteFormula(savedColor)} aria-label={t('Load formula {name}', { name: savedColor.name })} data-tooltip={t('Load Formula')} disabled={paletteLoading || paletteMutating}>↗</button>
                      <button type="button" className="saved-color-delete" onClick={() => setPaletteDeleteTarget(savedColor)} aria-label={t('Delete color {name}', { name: savedColor.name })} data-tooltip={t('Delete Color')} disabled={paletteLoading || paletteMutating}>×</button>
                    </div>
                  ))}</div> : <p className="empty-palette">{paletteLoading ? t('Opening palette…') : t('No saved colors yet.')}</p>}
                  {!mixerOpen && paletteError ? <p className="palette-error" role="alert">{paletteError}</p> : null}
                </section>
              ) : null}
              {tool !== 'fill' ? <section><label className="inspector-title" htmlFor="stroke-size"><span>{tool === 'text' ? t('Text Size') : tool === 'eraser' ? t('Eraser Size') : t('Thickness')}</span><output>{size}px</output></label><input id="stroke-size" name="stroke-size" type="range" min={sizeLimits.min} max={sizeLimits.max} value={size} style={rangeStyle(size, sizeLimits.min, sizeLimits.max)} onChange={(event) => { const nextSize = Number(event.target.value); if (tool === 'text') setFontSize(nextSize); else if (isSizedTool(tool)) setToolSizes((current) => ({ ...current, [tool]: nextSize })); }} /></section> : null}
              {tool === 'fill' ? <section className="fill-tool-settings">
                <div className="fill-tool-intro"><ToolIcon tool="fill" /><span><strong>{fillMaterial === 'solid' ? t('Tap a closed region to fill') : t('Tap a closed region to fill with {material}', { material: t(activeFillMaterial.label).toLocaleLowerCase() })}</strong><small>{fillMaterial === 'solid' ? t('Color spreads only through pixels with a similar tone.') : t(activeFillMaterial.description)}</small></span></div>
                <div className="inspector-title"><span>{t('Fill Material')}</span><output>{t(activeFillMaterial.label)}</output></div>
                <div className="fill-material-options" role="group" aria-label={t('Fill Material')} style={{ '--fill-preview-color': color } as CSSProperties}>
                  {FILL_MATERIALS.map((material) => <button type="button" key={material.id} className={fillMaterial === material.id ? `fill-material-${material.id} active` : `fill-material-${material.id}`} onClick={() => setFillMaterial(material.id)} aria-pressed={fillMaterial === material.id}><i aria-hidden="true" /><span><strong>{t(material.label)}</strong><small>{t(material.description)}</small></span></button>)}
                </div>
                {fillMaterial !== 'solid' ? <><label className="inspector-title fill-texture-title" htmlFor="fill-texture"><span>{t(fillMaterial === 'marker' ? 'Ink Load' : fillMaterial === 'pencil' ? 'Pencil Pressure' : fillMaterial === 'watercolor' ? 'Granulation' : 'Paint Body')}</span><output>{fillTexture}%</output></label><input id="fill-texture" name="fill-texture" type="range" min="10" max="100" value={fillTexture} style={rangeStyle(fillTexture, 10, 100)} onChange={(event) => setFillTexture(Number(event.target.value))} /></> : null}
                {fillMaterial === 'watercolor' || fillMaterial === 'gouache' ? <><label className="inspector-title fill-water-title" htmlFor="fill-water"><span>{t('Water')}</span><output>{fillWater}%</output></label><input id="fill-water" name="fill-water" type="range" min="0" max="100" value={fillWater} style={rangeStyle(fillWater, 0, 100)} onChange={(event) => setFillWater(Number(event.target.value))} /><p>{t('More water increases transparency and movement; less water keeps the pigment concentrated.')}</p></> : null}
                <label className="inspector-title fill-tolerance-title" htmlFor="fill-tolerance"><span>{t('Color Tolerance')}</span><output>{fillTolerance}</output></label><input id="fill-tolerance" name="fill-tolerance" type="range" min="0" max="72" value={fillTolerance} style={rangeStyle(fillTolerance, 0, 72)} onChange={(event) => setFillTolerance(Number(event.target.value))} />
                <p>{t('Solid covers the region completely. Natural materials intentionally preserve paper grain.')}</p>
                <p>{t('Increase tolerance when the background has varied tones or compression artifacts.')}</p>
              </section> : null}
              {tool !== 'eraser' ? <section><label className="inspector-title" htmlFor="stroke-opacity"><span>{tool === 'marker' ? t('Highlighter Coverage') : t('Opacity')}</span><output>{Math.round(opacity * (tool === 'marker' ? 34 : 100))}%</output></label><input id="stroke-opacity" name="stroke-opacity" type="range" min="10" max="100" value={Math.round(opacity * 100)} style={rangeStyle(Math.round(opacity * 100), 10, 100)} onChange={(event) => setOpacity(Number(event.target.value) / 100)} /></section> : null}
              {tool === 'text' ? <section><label className="text-tool-label" htmlFor="canvas-text">{t('Text Content')}</label><textarea id="canvas-text" name="canvas-text" autoComplete="off" value={textValue} onChange={(event) => setTextValue(event.target.value)} placeholder={t('Enter text, then drag it onto the paper…')} maxLength={160} /><p className="text-tool-help">{t('Press and drag to place text. Click or drag text with a purple frame to reposition it.')}</p>{selectedTextId ? <button type="button" className="text-delete-button" onClick={deleteSelectedText}><span>⌫</span> {t('Delete Selected Text')} <kbd>Delete</kbd></button> : null}</section> : null}
              {closedShapeTool ? <section><label className="fill-toggle"><input type="checkbox" name="shape-fill" checked={filled} onChange={(event) => setFilled(event.target.checked)} /><span><strong>{t('Light Fill')}</strong><small>{t('Keep a clear outline with a 16% fill')}</small></span></label></section> : null}
            </> : <section className="hand-tool-help"><strong>{t('Pan Canvas')}</strong><p>{t('Zoom in, then drag the paper to inspect details. This tool does not create marks.')}</p></section>}
            <section><div className="inspector-title"><span>{t('Paper')}</span><output>{sourceUrl ? t('Below Original') : ''}</output></div><div className="paper-options">{([['white', 'White'], ['cream', 'Cream'], ['grid', 'Grid'], ['dots', 'Dots']] as Array<[Paper, string]>).map(([id, label]) => <button type="button" key={id} className={paper === id ? `paper-${id} active` : `paper-${id}`} onClick={() => changePaper(id)} aria-pressed={paper === id}><i />{t(label)}</button>)}</div></section>
          </aside>
        </div>

        <footer className="studio-footer" inert={mobileInspectorOpen ? true : undefined}><label><span>{t('Message')}</span><input name="drawing-caption" autoComplete="off" value={caption} onChange={(event) => setCaption(event.target.value)} placeholder={t('Add context for this drawing…')} maxLength={2000} aria-label={t('Drawing message')} /></label><div><span>{sourceUrl && !sourceIsDraft ? `${t('Original remains unchanged')} · ` : ''}PNG 1200 × 720</span><button type="button" className="primary-button" onClick={() => void send()} disabled={!canSendCanvas || paletteMutating || sending || sourceLoading || sourceError} title={!canSendCanvas ? t('Draw at least one mark or choose a paper before sending') : undefined}>{sendLabel}</button>{!canSendCanvas ? <small className="studio-send-help">{t('Draw or add text to enable Send')}</small> : null}</div></footer>
      </section>
      <AppDialog open={Boolean(paletteDeleteTarget)} onClose={() => setPaletteDeleteTarget(null)} labelledBy="delete-palette-title" describedBy="delete-palette-description" className="confirmation-backdrop">
        <section className="dialog-card confirmation-dialog">
          <span className="eyebrow destructive">{t('Remove from Palette')}</span>
          <h2 id="delete-palette-title">{t('Delete “{name}”?', { name: paletteDeleteTarget?.name ?? '' })}</h2>
          <p id="delete-palette-description">{t('The saved mixing formula will be deleted. Existing marks using this color will not change.')}</p>
          <div className="confirmation-actions"><button type="button" onClick={() => setPaletteDeleteTarget(null)}>{t('Keep Color')}</button><button type="button" className="danger-button" onClick={() => { const target = paletteDeleteTarget; setPaletteDeleteTarget(null); if (target) void deletePaletteColor(target); }}>{t('Delete Color')}</button></div>
        </section>
      </AppDialog>
    </div>
  );
}
