'use client';

import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { useLanguage } from '@/src/i18n/language-provider';

const WIDTH = 900;
const HEIGHT = 540;

function pointOnCanvas(canvas: HTMLCanvasElement, event: ReactPointerEvent<HTMLCanvasElement>) {
  const bounds = canvas.getBoundingClientRect();
  return {
    x: (event.clientX - bounds.left) * (canvas.width / bounds.width),
    y: (event.clientY - bounds.top) * (canvas.height / bounds.height),
  };
}

export default function LandingDoodle({ onUse }: { onUse: (dataUrl: string) => void }) {
  const { t } = useLanguage();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const lastPointRef = useRef<{ x: number; y: number } | null>(null);
  const [hasMark, setHasMark] = useState(false);

  const begin = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.setPointerCapture(event.pointerId);
    lastPointRef.current = pointOnCanvas(canvas, event);
  };

  const draw = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    const previous = lastPointRef.current;
    if (!canvas || !previous || !canvas.hasPointerCapture(event.pointerId)) return;
    const next = pointOnCanvas(canvas, event);
    const context = canvas.getContext('2d');
    if (!context) return;
    context.strokeStyle = '#6f4ee8';
    context.lineWidth = Math.max(7, event.pressure ? 7 + event.pressure * 8 : 10);
    context.lineCap = 'round';
    context.lineJoin = 'round';
    context.beginPath();
    context.moveTo(previous.x, previous.y);
    context.lineTo(next.x, next.y);
    context.stroke();
    lastPointRef.current = next;
    setHasMark(true);
  };

  const finish = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    lastPointRef.current = null;
    if (canvas?.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
  };

  const clear = () => {
    const canvas = canvasRef.current;
    canvas?.getContext('2d')?.clearRect(0, 0, WIDTH, HEIGHT);
    setHasMark(false);
    canvas?.focus();
  };

  const addSuggestedMark = () => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !context) return;
    context.strokeStyle = '#6f4ee8';
    context.lineWidth = 11;
    context.lineCap = 'round';
    context.lineJoin = 'round';
    context.beginPath();
    context.moveTo(WIDTH * 0.22, HEIGHT * 0.58);
    context.bezierCurveTo(WIDTH * 0.33, HEIGHT * 0.2, WIDTH * 0.58, HEIGHT * 0.82, WIDTH * 0.78, HEIGHT * 0.4);
    context.stroke();
    setHasMark(true);
    canvas.focus();
  };

  return (
    <section className="landing-doodle" aria-labelledby="landing-doodle-title">
      <header>
        <div><small>{t('Try It Now')}</small><strong id="landing-doodle-title">{t('Make Your First Mark')}</strong></div>
        <span>{t('No account needed')}</span>
      </header>
      <div className="landing-doodle-paper">
        <canvas
          ref={canvasRef}
          id="landing-doodle"
          width={WIDTH}
          height={HEIGHT}
          tabIndex={0}
          aria-label={t('A small canvas for trying Nét')}
          aria-describedby="landing-doodle-help"
          onKeyDown={(event) => {
            if (event.key !== ' ' && event.key !== 'Enter') return;
            event.preventDefault();
            addSuggestedMark();
          }}
          onPointerDown={begin}
          onPointerMove={draw}
          onPointerUp={finish}
          onPointerCancel={finish}
        />
        {!hasMark && <span aria-hidden="true">{t('Draw anything here…')}</span>}
      </div>
      <p id="landing-doodle-help">{t('Draw with a pointer, or press Space to add a suggested mark.')}</p>
      <footer>
        <button type="button" onClick={clear} disabled={!hasMark}>{t('Clear')}</button>
        <button type="button" className="landing-doodle-use" disabled={!hasMark} onClick={() => {
          const canvas = canvasRef.current;
          if (canvas) onUse(canvas.toDataURL('image/png'));
        }}>{t('Continue This Mark')} <span aria-hidden="true">→</span></button>
      </footer>
    </section>
  );
}
