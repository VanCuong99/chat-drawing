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

const CANVAS_WIDTH = 1200;
const CANVAS_HEIGHT = 720;
const COLORS = ['#27242e', '#6f4ee8', '#ef7668', '#e19a3f', '#3aa694', '#3085c7', '#d34d8b', '#ffffff'];

type Point = { x: number; y: number; pressure: number };
type StrokeTool = 'pen' | 'marker' | 'eraser';
type ClosedShapeTool = 'rectangle' | 'roundedRectangle' | 'ellipse' | 'triangle' | 'trapezoid' | 'diamond' | 'star' | 'bubble';
type ShapeTool = 'line' | 'arrow' | ClosedShapeTool;
type Tool = 'hand' | StrokeTool | ShapeTool | 'text';
type SizedTool = Exclude<Tool, 'hand' | 'text'>;
type Paper = 'white' | 'cream' | 'grid' | 'dots';
type StyledAction = { color: string; size: number; opacity: number };
type StrokeAction = StyledAction & { kind: 'stroke'; tool: StrokeTool; points: Point[] };
type ShapeAction = StyledAction & { kind: 'shape'; tool: ShapeTool; from: Point; to: Point; filled: boolean };
type TextAction = StyledAction & { kind: 'text'; id: string; point: Point; text: string };
type DrawAction = StrokeAction | ShapeAction | TextAction;
type Scene = { actions: DrawAction[]; paper: Paper };
type History = { past: Scene[]; present: Scene; future: Scene[] };
type MixerPigment = PigmentComponent & { id: string };

const INITIAL_SCENE: Scene = { actions: [], paper: 'white' };
const INITIAL_MIXER_COMPONENTS: MixerPigment[] = [
  { id: 'pigment-1', color: '#FCF046', weight: 1 },
  { id: 'pigment-2', color: '#E53166', weight: 1 },
  { id: 'pigment-3', color: '#3375DA', weight: 1 },
];
const ADDED_PIGMENT_COLORS = ['#FCD200', '#002185', '#EF7668', '#3AA694', '#D34D8B', '#E19A3F'];
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
  { id: 'hand', label: 'Di chuyển', key: 'H' },
  { id: 'pen', label: 'Bút chì', key: 'P' },
  { id: 'marker', label: 'Bút highlight', key: 'M' },
  { id: 'eraser', label: 'Tẩy', key: 'E' },
  { id: 'line', label: 'Đường thẳng', key: 'L' },
  { id: 'arrow', label: 'Mũi tên', key: 'A' },
  { id: 'rectangle', label: 'Chữ nhật', key: 'R' },
  { id: 'roundedRectangle', label: 'Bo góc', key: 'U' },
  { id: 'ellipse', label: 'Ellipse', key: 'O' },
  { id: 'triangle', label: 'Tam giác', key: 'G' },
  { id: 'trapezoid', label: 'Hình thang', key: 'V' },
  { id: 'diamond', label: 'Hình thoi', key: 'D' },
  { id: 'star', label: 'Ngôi sao', key: 'S' },
  { id: 'bubble', label: 'Bong bóng', key: 'B' },
  { id: 'text', label: 'Chèn chữ', key: 'T' },
];

const RAIL_TOOLS = TOOLS.filter((tool) => ['hand', 'pen', 'marker', 'eraser', 'line', 'arrow'].includes(tool.id));
const MORE_TOOLS = RAIL_TOOLS.filter((tool) => ['marker', 'line', 'arrow'].includes(tool.id));
const SHAPE_TOOLS = TOOLS.filter((tool): tool is { id: ClosedShapeTool; label: string; key: string } => ['rectangle', 'roundedRectangle', 'ellipse', 'triangle', 'trapezoid', 'diamond', 'star', 'bubble'].includes(tool.id));
const TEXT_TOOL = TOOLS.find((tool) => tool.id === 'text')!;

const TOOL_BY_KEY = new Map(TOOLS.map((tool) => [tool.key.toLocaleLowerCase(), tool.id]));

function isSizedTool(tool: Tool): tool is SizedTool {
  return tool !== 'hand' && tool !== 'text';
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

function drawAction(context: CanvasRenderingContext2D, action: DrawAction) {
  if (action.kind === 'stroke') drawSmoothStroke(context, action);
  else if (action.kind === 'shape') drawShape(context, action);
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

export default function DrawingStudio({ sourceUrl, version, paletteColors, paletteLoading = false, paletteMutating = false, palettePersistence = 'session', onClose, onSend, onSavePalette, onDeletePalette }: {
  sourceUrl?: string | null;
  version?: number | null;
  paletteColors: PaletteColorView[];
  paletteLoading?: boolean;
  paletteMutating?: boolean;
  palettePersistence?: 'account' | 'session';
  onClose: () => void;
  onSend: (blob: Blob, caption: string) => Promise<void>;
  onSavePalette: (input: { name: string; components: PigmentComponent[] }) => Promise<void>;
  onDeletePalette: (id: string) => Promise<void>;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const eraserCursorRef = useRef<HTMLSpanElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const shapeButtonRef = useRef<HTMLButtonElement>(null);
  const moreToolsButtonRef = useRef<HTMLButtonElement>(null);
  const mixerToggleRef = useRef<HTMLButtonElement>(null);
  const mixerIdRef = useRef(4);
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
  const sendingRef = useRef(false);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const [history, setHistory] = useState<History>({ past: [], present: INITIAL_SCENE, future: [] });
  const [tool, setTool] = useState<Tool>('pen');
  const [selectedShape, setSelectedShape] = useState<ClosedShapeTool>('rectangle');
  const [shapeMenuOpen, setShapeMenuOpen] = useState(false);
  const [moreToolsOpen, setMoreToolsOpen] = useState(false);
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
  const [zoom, setZoom] = useState(100);
  const [caption, setCaption] = useState('');
  const [sending, setSending] = useState(false);
  const [sourceLoading, setSourceLoading] = useState(Boolean(sourceUrl));
  const [sourceError, setSourceError] = useState(false);
  const [sourceReady, setSourceReady] = useState(0);
  const [hint, setHint] = useState('Kéo trên giấy để bắt đầu');
  const actions = history.present.actions;
  const paper = history.present.paper;
  const size = tool === 'text' ? fontSize : isSizedTool(tool) ? toolSizes[tool] : toolSizes.pen;
  const sizeLimits = tool === 'text' ? { min: 20, max: 96 } : isSizedTool(tool) ? TOOL_SIZE_LIMITS[tool] : TOOL_SIZE_LIMITS.pen;
  const isDirty = history.past.length > 0 || history.future.length > 0 || actions.length > 0 || paper !== 'white' || Boolean(caption.trim()) || Boolean(textValue.trim());
  const canSendCanvas = Boolean(sourceUrl) || actions.length > 0 || paper !== 'white';
  const pigmentFormula = useMemo(() => mixerComponents.map(({ color: componentColor, weight }) => ({ color: componentColor, weight })), [mixerComponents]);
  const mixedColor = useMemo(() => mixPigmentHex(pigmentFormula), [pigmentFormula]);
  const mixerPercentages = useMemo(() => pigmentPercentages(pigmentFormula), [pigmentFormula]);

  useEffect(() => { actionsRef.current = actions; }, [actions]);

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
  }, []);

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

  const begin = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (sendingRef.current || sourceLoading || sourceError || event.button !== 0 || activePointerRef.current !== null) return;
    if (event.pointerType === 'touch' && !event.isPrimary) return;
    event.preventDefault();
    updateEraserCursor(event);
    if (tool === 'hand') {
      const viewport = viewportRef.current;
      if (!viewport) return;
      activePointerRef.current = event.pointerId;
      panRef.current = { x: event.clientX, y: event.clientY, left: viewport.scrollLeft, top: viewport.scrollTop };
      event.currentTarget.setPointerCapture(event.pointerId);
      setHint('Kéo để di chuyển quanh bản vẽ');
      return;
    }
    const point = getPoint(event);
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
      if (!existing && !textValue.trim()) { setHint('Nhập nội dung chữ ở bảng bên phải trước khi đặt lên giấy'); return; }
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
      setHint(existing ? 'Đang chọn chữ · kéo để đổi vị trí' : 'Giữ và kéo để chọn vị trí · thả để đặt chữ');
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
    updateEraserCursor(event);
    if (event.pointerId !== activePointerRef.current) return;
    event.preventDefault();
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
        ? `Đã di chuyển chữ tới X ${Math.round(textDrag.current.point.x)} · Y ${Math.round(textDrag.current.point.y)} · ⌘Z để hoàn tác`
        : 'Chữ đang được chọn · kéo trực tiếp để di chuyển');
      return;
    }
    const action = workingRef.current;
    workingRef.current = null;
    textDragRef.current = null;
    if (action) { commit(action); setHint('Đã lưu nét · ⌘Z để hoàn tác'); }
  };

  const cancelStroke = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (event.pointerId !== activePointerRef.current) return;
    if (textDragFrameRef.current !== null) {
      window.cancelAnimationFrame(textDragFrameRef.current);
      textDragFrameRef.current = null;
    }
    activePointerRef.current = null;
    panRef.current = null;
    workingRef.current = null;
    textDragRef.current = null;
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
    setHint('Đã xóa chữ · ⌘Z để khôi phục');
  }, []);

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
    setHint(sourceUrl ? 'Đã xoá các nét mới · bản gốc vẫn được giữ nguyên' : 'Canvas đã được làm sạch · có thể hoàn tác');
  };

  const changePaper = (nextPaper: Paper) => {
    if (nextPaper === paper) return;
    setHistory((current) => ({ past: [...current.past, current.present], present: { ...current.present, paper: nextPaper }, future: [] }));
  };

  const send = async () => {
    const canvas = canvasRef.current;
    if (!canvas || sendingRef.current || sourceLoading || sourceError || paletteMutating) return;
    if (!canSendCanvas) {
      setHint('Hãy vẽ ít nhất một nét hoặc chọn loại giấy trước khi gửi.');
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
      if (!blob) throw new Error('Không thể xuất bản vẽ.');
      await onSend(blob, caption.trim());
    } finally {
      selectedTextIdRef.current = selectedTextId;
      sendingRef.current = false;
      setSending(false);
    }
  };

  const requestClose = () => {
    if (paletteMutating) return;
    if (isDirty && !window.confirm('Bản vẽ chưa được gửi. Bạn vẫn muốn đóng Studio Nét?')) return;
    onClose();
  };

  const applyPaletteColor = (nextColor: string, name?: string) => {
    setColor(nextColor.toUpperCase());
    setHint(name ? `Đang dùng màu “${name}” từ bảng màu` : `Đang dùng màu pha ${nextColor.toUpperCase()}`);
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
    setHint(`Đã nạp công thức “${savedColor.name}” để pha tiếp`);
  };

  const saveMixedColor = async () => {
    if (paletteLoading || paletteMutating || paletteSaving) return;
    setPaletteSaving(true);
    setPaletteError('');
    try {
      await onSavePalette({ name: mixerName.trim(), components: pigmentFormula.map((component) => ({ ...component, color: component.color.toUpperCase() })) });
      setMixerName('');
      applyPaletteColor(mixedColor);
      setHint(`Đã lưu ${mixedColor} vào bảng màu`);
    } catch (saveError) {
      setPaletteError(saveError instanceof Error ? saveError.message : 'Không thể lưu màu vào bảng màu.');
    } finally {
      setPaletteSaving(false);
    }
  };

  const deletePaletteColor = async (savedColor: PaletteColorView) => {
    if (paletteLoading || paletteMutating) return;
    setPaletteError('');
    try { await onDeletePalette(savedColor.id); }
    catch (deleteError) { setPaletteError(deleteError instanceof Error ? deleteError.message : 'Không thể xóa màu này.'); }
  };

  const closeMixer = (restoreFocus = false) => {
    setMixerOpen(false);
    if (restoreFocus) requestAnimationFrame(() => mixerToggleRef.current?.focus());
  };

  const selectTool = (nextTool: Tool) => {
    const restoreShapeFocus = shapeMenuOpen;
    setShapeMenuOpen(false);
    setMoreToolsOpen(false);
    setTool(nextTool);
    if (isClosedShapeTool(nextTool)) setSelectedShape(nextTool);
    if (nextTool !== 'text') {
      selectedTextIdRef.current = null;
      setSelectedTextId(null);
    }
    if (restoreShapeFocus) requestAnimationFrame(() => shapeButtonRef.current?.focus());
  };

  const positionShapeMenu = useCallback(() => {
    const button = shapeButtonRef.current;
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
  }, []);

  const toggleShapeMenu = () => {
    if (!shapeMenuOpen) {
      positionShapeMenu();
      requestAnimationFrame(() => {
        positionShapeMenu();
        document.querySelector<HTMLElement>('#shape-picker .shape-options button')?.focus();
      });
    }
    setShapeMenuOpen((open) => !open);
  };

  useEffect(() => {
    if (!shapeMenuOpen) return;
    const reposition = () => positionShapeMenu();
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    return () => {
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
    };
  }, [positionShapeMenu, shapeMenuOpen]);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key === 'Tab') {
      const dialog = dialogRef.current;
      if (!dialog) return;
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), canvas[tabindex="0"], [tabindex]:not([tabindex="-1"])')).filter((element) => element.getClientRects().length > 0);
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
    if (event.key === 'Escape' && shapeMenuOpen) {
      event.preventDefault();
      setShapeMenuOpen(false);
      shapeButtonRef.current?.focus();
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
    ? 'Không tải được bản gốc'
    : sourceLoading
      ? 'Đang tải bản gốc…'
      : paletteMutating
        ? 'Đang lưu bảng màu…'
        : sending
          ? 'Đang gửi…'
          : canSendCanvas
            ? 'Gửi bản vẽ'
            : 'Vẽ trước khi gửi';

  return (
    <div className="studio-backdrop">
      <section ref={dialogRef} className="studio advanced-studio" role="dialog" aria-modal="true" aria-labelledby="studio-title" onKeyDown={onKeyDown} tabIndex={-1}>
        <header className="studio-header advanced-studio-header">
          <button className="plain-button" onClick={requestClose} disabled={paletteMutating} data-studio-initial-focus>Đóng <kbd>Esc</kbd></button>
          <div><small>{sourceUrl ? `Tiếp nối phiên bản ${version ?? 1}` : 'Canvas 1200 × 720'}</small><h2 id="studio-title">Studio Nét</h2></div>
          <button className="primary-button studio-header-send" onClick={() => void send()} disabled={!canSendCanvas || paletteMutating || sending || sourceLoading || sourceError} title={!canSendCanvas ? 'Hãy vẽ ít nhất một nét hoặc chọn loại giấy trước khi gửi' : undefined}>{sendLabel}</button>
        </header>

        <div className="studio-workspace">
          <div className="tool-rail-shell">
            <aside className="tool-rail" aria-label="Công cụ vẽ">
              {RAIL_TOOLS.map((item) => <button key={item.id} className={`${tool === item.id ? 'tool-button active' : 'tool-button'} ${MORE_TOOLS.some((moreTool) => moreTool.id === item.id) ? 'secondary-tool' : ''}`} data-tool-id={item.id} onClick={() => selectTool(item.id)} title={`${item.label} — phím ${item.key}`} aria-label={`${item.label} (${item.key})`} aria-pressed={tool === item.id}><b><ToolIcon tool={item.id} /></b><span className="desktop-tool-label">{item.label}</span><span className="mobile-tool-label">{item.id === 'hand' ? 'Di chuyển' : item.id === 'pen' ? 'Bút' : item.id === 'eraser' ? 'Tẩy' : item.label}</span></button>)}
              <button ref={shapeButtonRef} className={closedShapeTool ? 'tool-button active' : 'tool-button'} data-tool-id="shape" onClick={toggleShapeMenu} title={`Chọn hình dạng — đang dùng ${activeShape.label}`} aria-label={`Hình dạng (${activeShape.label})`} aria-pressed={closedShapeTool} aria-haspopup="dialog" aria-expanded={shapeMenuOpen} aria-controls="shape-picker"><b><ToolIcon tool={selectedShape} /></b><span className="desktop-tool-label">Hình dạng</span><span className="mobile-tool-label">Hình</span></button>
              <button className={tool === 'text' ? 'tool-button active' : 'tool-button'} data-tool-id="text" onClick={() => selectTool('text')} title={`${TEXT_TOOL.label} — phím ${TEXT_TOOL.key}`} aria-label={`${TEXT_TOOL.label} (${TEXT_TOOL.key})`} aria-pressed={tool === 'text'}><b><ToolIcon tool="text" /></b><span className="desktop-tool-label">{TEXT_TOOL.label}</span><span className="mobile-tool-label">Chữ</span></button>
              <button ref={moreToolsButtonRef} type="button" className={MORE_TOOLS.some((item) => item.id === tool) ? 'tool-button more-tools-button active' : 'tool-button more-tools-button'} onClick={() => { setShapeMenuOpen(false); setMoreToolsOpen((open) => !open); }} aria-label="Công cụ khác" aria-haspopup="dialog" aria-expanded={moreToolsOpen} aria-controls="more-tools-sheet"><b><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" aria-hidden="true"><circle cx="5" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /></svg></b><span className="mobile-tool-label">Thêm</span></button>
            </aside>
          </div>

          {moreToolsOpen ? <>
            <button type="button" className="more-tools-dismiss" onClick={() => { setMoreToolsOpen(false); moreToolsButtonRef.current?.focus(); }} aria-label="Đóng công cụ khác" />
            <section id="more-tools-sheet" className="more-tools-sheet" role="dialog" aria-modal="false" aria-labelledby="more-tools-title">
              <header><div><small>Studio Nét</small><strong id="more-tools-title">Công cụ khác</strong></div><button type="button" onClick={() => { setMoreToolsOpen(false); moreToolsButtonRef.current?.focus(); }} aria-label="Đóng công cụ khác">×</button></header>
              <div>{MORE_TOOLS.map((item) => <button key={item.id} type="button" className={tool === item.id ? 'active' : ''} onClick={() => selectTool(item.id)} aria-label={`${item.label} (${item.key})`} aria-pressed={tool === item.id}><ToolIcon tool={item.id} /><span><strong>{item.label}</strong><small>Phím {item.key}</small></span></button>)}</div>
            </section>
          </> : null}

          {shapeMenuOpen ? <>
            <div className="shape-popover-dismiss" aria-hidden="true" onPointerDown={() => { setShapeMenuOpen(false); shapeButtonRef.current?.focus(); }} />
            <section id="shape-picker" className="shape-popover" role="dialog" aria-modal="false" aria-labelledby="shape-picker-title" style={shapeMenuPosition}>
              <header><div><small>Hình học</small><strong id="shape-picker-title">Chọn hình dạng</strong></div><button type="button" onClick={() => { setShapeMenuOpen(false); shapeButtonRef.current?.focus(); }} aria-label="Đóng bộ chọn hình dạng" data-tooltip="Đóng" data-tooltip-placement="below">×</button></header>
              <div className="shape-options" role="group" aria-label="Chọn loại hình">{SHAPE_TOOLS.map((item) => <button key={item.id} type="button" className={selectedShape === item.id ? 'active' : ''} onClick={() => selectTool(item.id)} aria-label={item.label} aria-pressed={selectedShape === item.id}><ToolIcon tool={item.id} /><span>{item.label}</span><kbd>{item.key}</kbd></button>)}</div>
              <p className="shape-tool-help">Chọn xong là vẽ ngay. Giữ <kbd>Shift</kbd> khi kéo để cân đều hai chiều.</p>
            </section>
          </> : null}

          <div className="canvas-panel">
            <div className="canvas-commandbar">
              <div><button onClick={undo} disabled={!history.past.length} aria-label="Hoàn tác" data-tooltip="Hoàn tác" data-tooltip-placement="below">↶</button><button onClick={redo} disabled={!history.future.length} aria-label="Làm lại" data-tooltip="Làm lại" data-tooltip-placement="below">↷</button><button onClick={clear} disabled={!actions.length} aria-label="Xoá các nét mới" data-tooltip="Xoá các nét mới" data-tooltip-placement="below">⌫</button></div>
              <span><strong>{activeTool.label}</strong><kbd>{activeTool.key}</kbd><i aria-hidden="true">·</i>{actions.length} thao tác</span>
              <div className="zoom-control"><button onClick={() => setZoom((value) => Math.max(50, value - 10))} aria-label="Thu nhỏ" data-tooltip="Thu nhỏ" data-tooltip-placement="below">−</button><output>{zoom}%</output><button onClick={() => setZoom((value) => Math.min(180, value + 10))} aria-label="Phóng to" data-tooltip="Phóng to" data-tooltip-placement="below">＋</button></div>
            </div>
            <div ref={viewportRef} className="canvas-viewport" style={zoomStyle}>
              <div className="canvas-board">
                <canvas ref={canvasRef} width={CANVAS_WIDTH} height={CANVAS_HEIGHT} onPointerDown={begin} onPointerEnter={updateEraserCursor} onPointerMove={move} onPointerLeave={hideEraserCursor} onPointerUp={finish} onPointerCancel={cancelStroke} aria-label="Vùng vẽ nâng cao" aria-disabled={sending || sourceLoading || sourceError} data-tool={tool} data-text-selected={Boolean(selectedTextId)} data-sending={sending} tabIndex={0}>Canvas vẽ hỗ trợ chuột, bút cảm ứng và thao tác chạm.</canvas>
                <span ref={eraserCursorRef} className="eraser-size-cursor" data-visible="false" aria-hidden="true" />
                {sourceLoading ? <span className="canvas-loading">Đang tải bản gốc để vẽ tiếp…</span> : null}
                {sourceError ? <span className="canvas-loading canvas-error">Không thể tải bản gốc. Hãy đóng và thử lại.</span> : null}
              </div>
            </div>
            <div className="canvas-status"><span role="status" aria-live="polite"><i /> {hint}</span><span>⌘Z hoàn tác · Shift⌘Z làm lại</span></div>
          </div>

          <aside className="tool-inspector" aria-label="Thuộc tính công cụ">
            {editingTool ? <>
              {tool !== 'eraser' ? <section><div className="inspector-title"><span>Màu sắc</span><output>{color.toUpperCase()}</output></div><div className="advanced-color-row">{COLORS.map((item) => <button key={item} className={color.toUpperCase() === item.toUpperCase() ? 'color active' : 'color'} style={{ background: item }} onClick={() => setColor(item)} aria-label={`Chọn màu ${item}`} aria-pressed={color.toUpperCase() === item.toUpperCase()} />)}<label className="custom-color" title="Màu tuỳ chỉnh">＋<input type="color" name="custom-color" value={color} onChange={(event) => setColor(event.target.value.toUpperCase())} aria-label="Chọn màu tuỳ chỉnh" /></label></div>{paletteAvailable ? <button ref={mixerToggleRef} type="button" className="mixer-toggle" onClick={() => { setMixerOpen((open) => !open); setPaletteError(''); }} aria-label={mixerOpen ? 'Đóng pha màu nâng cao' : 'Mở pha màu nâng cao'} aria-expanded={mixerOpen} aria-controls="pigment-mixer"><span aria-hidden="true">◒</span>{mixerOpen ? 'Đóng pha màu' : 'Pha màu nâng cao'}</button> : null}</section> : null}
              {paletteAvailable && mixerOpen ? (
                <><button type="button" className="mixer-sheet-dismiss" onClick={() => closeMixer(true)} aria-label="Đóng pha màu nâng cao" />
                <section id="pigment-mixer" className="pigment-mixer" role="region" aria-label="Pha màu nâng cao">
                  <div className="mixer-heading"><div><small>Pha màu nâng cao</small><strong>Trộn nhiều màu</strong></div><button type="button" onClick={() => closeMixer(true)} aria-label="Đóng pha màu nâng cao" data-tooltip="Đóng pha màu" data-tooltip-placement="below">×</button></div>
                  <div className="mixer-preview-sticky">
                    <div className="mixed-result"><span style={{ background: mixedColor }} aria-hidden="true" /><div><small>Màu sau khi pha</small><strong>{mixedColor}</strong></div><output>{mixerComponents.length} thành phần</output></div>
                    <div className="mixture-composition" aria-label="Tỷ lệ đã chuẩn hóa">{mixerComponents.map((component, index) => <i key={component.id} style={{ background: component.color, width: `${mixerPercentages[index]}%` }} title={`Màu ${index + 1}: ${mixerPercentages[index]}%`} />)}</div>
                  </div>
                  <div className="pigment-components" role="list" aria-label="Các màu thành phần">
                    {mixerComponents.map((component, index) => (
                      <article key={component.id} className="pigment-component" role="listitem">
                        <header><strong>Màu {index + 1}</strong><output>{mixerPercentages[index]}%</output><button type="button" onClick={() => removeMixerComponent(component.id)} disabled={mixerComponents.length <= 2} aria-label={`Xóa màu ${index + 1}`}>×</button></header>
                        <div>
                          <label className="pigment-color-input"><input type="color" value={component.color} onChange={(event) => updateMixerComponent(component.id, { color: event.target.value.toUpperCase() })} aria-label={`Màu ${index + 1}`} /><span style={{ background: component.color }} aria-hidden="true" /><output>{component.color.toUpperCase()}</output></label>
                          <label className="pigment-weight-input"><span>Phần pha</span><input type="number" min="1" max="100" step="1" value={component.weight} onChange={(event) => updateMixerComponent(component.id, { weight: Math.max(1, Math.min(100, Math.round(Number(event.target.value) || 1))) })} aria-label={`Phần pha màu ${index + 1}`} /></label>
                        </div>
                      </article>
                    ))}
                  </div>
                  <button type="button" className="add-pigment" onClick={addMixerComponent} disabled={mixerComponents.length >= MAX_PIGMENT_COMPONENTS} aria-label="Thêm màu thành phần">＋ Thêm màu <span>{mixerComponents.length}/{MAX_PIGMENT_COMPONENTS}</span></button>
                  <p className="mix-parts-note">Thêm từ 2 đến 12 màu. Số phần cho biết mỗi màu góp bao nhiêu; Nét tự quy đổi thành tỷ lệ phần trăm.</p>
                  <div className="mixer-footer-actions">
                    <button type="button" className="use-mixed-color" onClick={() => applyPaletteColor(mixedColor)}>Dùng màu</button>
                    <label className="mix-name" htmlFor="mixed-color-name">Tên trong bảng màu<input id="mixed-color-name" name="mixed-color-name" autoComplete="off" value={mixerName} onChange={(event) => setMixerName(event.target.value)} maxLength={40} placeholder={`Màu pha ${paletteColors.length + 1}…`} aria-label="Tên màu đã pha" /></label>
                    <button type="button" className="save-mixed-color" onClick={() => void saveMixedColor()} disabled={paletteLoading || paletteMutating || paletteSaving || paletteColors.length >= 24}>{paletteLoading ? 'Đang mở bảng màu…' : paletteMutating || paletteSaving ? 'Đang lưu…' : paletteColors.length >= 24 ? 'Bảng màu đã đủ 24 màu' : palettePersistence === 'account' ? 'Lưu vào tài khoản' : 'Lưu trong phiên'}</button>
                  </div>
                  <details className="pigment-details"><summary>Thông tin mô phỏng màu</summary><p className="pigment-note">Mô phỏng gần đúng hỗn hợp nhiều màu bằng Kubelka–Munk từ sRGB/D65. Tỷ lệ là dữ liệu đầu vào của mô hình, không phải công thức vật liệu thật; muốn dự đoán sơn hoặc mực chính xác cần dữ liệu K/S đo cho từng sắc tố, chất kết dính và nền giấy.</p></details>
                  {paletteError ? <p className="palette-error" role="alert">{paletteError}</p> : null}
                </section></>
              ) : null}
              {paletteAvailable && (paletteLoading || paletteColors.length > 0 || Boolean(paletteError)) ? (
                <section className="palette-library">
                  <div className="inspector-title"><span>Bảng màu của bạn</span><output>{paletteLoading ? 'Đang tải…' : `${paletteColors.length}/24`}</output></div>
                  {paletteColors.length ? <div className="saved-palette">{paletteColors.map((savedColor) => (
                    <div key={savedColor.id} className="saved-color">
                      <button type="button" className={color.toUpperCase() === savedColor.color ? 'saved-color-use active' : 'saved-color-use'} onClick={() => applyPaletteColor(savedColor.color, savedColor.name)} aria-label={`Dùng màu ${savedColor.name}`} aria-pressed={color.toUpperCase() === savedColor.color}><i style={{ background: savedColor.color }} /><span><strong>{savedColor.name}</strong><small>{savedColor.color} · {savedColor.components.length} màu · công thức v{savedColor.model.version}</small></span></button>
                      <button type="button" className="saved-color-load" onClick={() => loadPaletteFormula(savedColor)} aria-label={`Nạp công thức ${savedColor.name}`} data-tooltip="Nạp công thức" disabled={paletteLoading || paletteMutating}>↗</button>
                      <button type="button" className="saved-color-delete" onClick={() => setPaletteDeleteTarget(savedColor)} aria-label={`Xóa màu ${savedColor.name}`} data-tooltip="Xoá màu" disabled={paletteLoading || paletteMutating}>×</button>
                    </div>
                  ))}</div> : <p className="empty-palette">{paletteLoading ? 'Đang mở bảng màu…' : 'Chưa có màu đã lưu.'}</p>}
                  {!mixerOpen && paletteError ? <p className="palette-error" role="alert">{paletteError}</p> : null}
                </section>
              ) : null}
              <section><label className="inspector-title" htmlFor="stroke-size"><span>{tool === 'text' ? 'Cỡ chữ' : tool === 'eraser' ? 'Kích thước tẩy' : 'Độ dày'}</span><output>{size}px</output></label><input id="stroke-size" name="stroke-size" type="range" min={sizeLimits.min} max={sizeLimits.max} value={size} style={rangeStyle(size, sizeLimits.min, sizeLimits.max)} onChange={(event) => { const nextSize = Number(event.target.value); if (tool === 'text') setFontSize(nextSize); else if (isSizedTool(tool)) setToolSizes((current) => ({ ...current, [tool]: nextSize })); }} /></section>
              {tool !== 'eraser' ? <section><label className="inspector-title" htmlFor="stroke-opacity"><span>{tool === 'marker' ? 'Độ phủ highlighter' : 'Độ trong suốt'}</span><output>{Math.round(opacity * (tool === 'marker' ? 34 : 100))}%</output></label><input id="stroke-opacity" name="stroke-opacity" type="range" min="10" max="100" value={Math.round(opacity * 100)} style={rangeStyle(Math.round(opacity * 100), 10, 100)} onChange={(event) => setOpacity(Number(event.target.value) / 100)} /></section> : null}
              {tool === 'text' ? <section><label className="text-tool-label" htmlFor="canvas-text">Nội dung chữ</label><textarea id="canvas-text" name="canvas-text" autoComplete="off" value={textValue} onChange={(event) => setTextValue(event.target.value)} placeholder="Nhập chữ rồi kéo lên giấy…" maxLength={160} /><p className="text-tool-help">Nhấn–kéo để đặt chữ. Click hoặc kéo lại chữ có khung tím để chỉnh vị trí.</p>{selectedTextId ? <button className="text-delete-button" onClick={deleteSelectedText}><span>⌫</span> Xóa chữ đã chọn <kbd>Delete</kbd></button> : null}</section> : null}
              {closedShapeTool ? <section><label className="fill-toggle"><input type="checkbox" name="shape-fill" checked={filled} onChange={(event) => setFilled(event.target.checked)} /><span><strong>Tô nền nhạt</strong><small>Giữ viền rõ, nền 16%</small></span></label></section> : null}
            </> : <section className="hand-tool-help"><strong>Di chuyển canvas</strong><p>Phóng to rồi kéo trên giấy để xem chi tiết. Công cụ này không tạo thêm nét.</p></section>}
            <section><div className="inspector-title"><span>Loại giấy</span><output>{sourceUrl ? 'Dưới bản gốc' : ''}</output></div><div className="paper-options">{([['white', 'Trắng'], ['cream', 'Kem'], ['grid', 'Lưới'], ['dots', 'Chấm']] as Array<[Paper, string]>).map(([id, label]) => <button key={id} className={paper === id ? `paper-${id} active` : `paper-${id}`} onClick={() => changePaper(id)} aria-pressed={paper === id}><i />{label}</button>)}</div></section>
          </aside>
        </div>

        <footer className="studio-footer"><label><span>Lời nhắn đi kèm</span><input name="drawing-caption" autoComplete="off" value={caption} onChange={(event) => setCaption(event.target.value)} placeholder="Thêm bối cảnh cho bản vẽ…" maxLength={2000} aria-label="Lời nhắn cho bản vẽ" /></label><div><span>{sourceUrl ? 'Bản gốc được giữ nguyên · ' : ''}PNG 1200 × 720</span><button className="primary-button" onClick={() => void send()} disabled={!canSendCanvas || paletteMutating || sending || sourceLoading || sourceError} title={!canSendCanvas ? 'Hãy vẽ ít nhất một nét hoặc chọn loại giấy trước khi gửi' : undefined}>{sendLabel}</button>{!canSendCanvas ? <small className="studio-send-help">Vẽ hoặc thêm chữ để bật Gửi</small> : null}</div></footer>
      </section>
      <AppDialog open={Boolean(paletteDeleteTarget)} onClose={() => setPaletteDeleteTarget(null)} labelledBy="delete-palette-title" describedBy="delete-palette-description" className="confirmation-backdrop">
        <section className="dialog-card confirmation-dialog">
          <span className="eyebrow destructive">Xoá khỏi bảng màu</span>
          <h2 id="delete-palette-title">Xoá “{paletteDeleteTarget?.name}”?</h2>
          <p id="delete-palette-description">Công thức pha màu đã lưu sẽ bị xoá. Các nét đã vẽ bằng màu này không thay đổi.</p>
          <div className="confirmation-actions"><button type="button" onClick={() => setPaletteDeleteTarget(null)}>Giữ lại màu</button><button type="button" className="danger-button" onClick={() => { const target = paletteDeleteTarget; setPaletteDeleteTarget(null); if (target) void deletePaletteColor(target); }}>Xoá màu</button></div>
        </section>
      </AppDialog>
    </div>
  );
}
