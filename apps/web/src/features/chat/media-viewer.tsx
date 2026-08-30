'use client';

import { type CSSProperties, type KeyboardEvent, type MouseEvent as ReactMouseEvent, useEffect, useState } from 'react';
import AppDialog from '@/src/shared/app-dialog';
import type { MessageView } from '@/src/shared/chat.types';
import { useLanguage } from '@/src/i18n/language-provider';

const MIN_ZOOM = 50;
const MAX_ZOOM = 300;
const ZOOM_STEP = 25;

function MediaIcon({ name }: { name: 'close' | 'download' | 'minus' | 'plus' | 'reset' }) {
  const paths = {
    close: <><path d="m6 6 12 12" /><path d="M18 6 6 18" /></>,
    download: <><path d="M12 3v12" /><path d="m7 10 5 5 5-5" /><path d="M5 21h14" /></>,
    minus: <path d="M5 12h14" />,
    plus: <><path d="M12 5v14" /><path d="M5 12h14" /></>,
    reset: <><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5" /></>,
  };
  return <svg aria-hidden="true" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">{paths[name]}</svg>;
}

export default function MediaViewer({
  message,
  downloading,
  onClose,
  onDownload,
  onRefresh,
}: {
  message: MessageView | null;
  downloading: boolean;
  onClose: () => void;
  onDownload: (message: MessageView) => Promise<void>;
  onRefresh: (assetKey: string) => void;
}) {
  const { t } = useLanguage();
  const [zoom, setZoom] = useState(100);
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });
  const [imageSize, setImageSize] = useState({ width: 1200, height: 720 });

  useEffect(() => {
    let frame = requestAnimationFrame(() => setViewportSize({ width: window.innerWidth, height: window.innerHeight }));
    const updateViewport = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setViewportSize({ width: window.innerWidth, height: window.innerHeight }));
    };
    window.addEventListener('resize', updateViewport);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', updateViewport);
    };
  }, []);

  if (!message?.assetUrl) return null;
  const title = message.type === 'canvas' ? t('Drawing Version {version}', { version: message.canvasVersion ?? 1 }) : t('Image in the Conversation');
  const desktopMaxWidth = Math.min(viewportSize.width * 0.56, 800);
  const desktopMaxHeight = Math.min(viewportSize.height * 0.56, 560);
  const imageRatio = imageSize.width / imageSize.height;
  const fittedDesktopWidth = Math.min(desktopMaxWidth, desktopMaxHeight * imageRatio);
  const desktopWidth = fittedDesktopWidth * zoom / 100;
  const stageStyle = {
    '--media-zoom': `${zoom}%`,
    '--media-desktop-zoom': viewportSize.width > 0 ? `${desktopWidth}px` : `min(${zoom * 0.56}%, ${zoom * 8}px)`,
  } as CSSProperties;
  const changeZoom = (next: number) => setZoom(Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, next)));
  const dismissFromDarkArea = (event: ReactMouseEvent<HTMLElement>) => {
    if (event.target === event.currentTarget) onClose();
  };
  const handleKeyboard = (event: KeyboardEvent<HTMLElement>) => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key === '+' || event.key === '=') {
      event.preventDefault();
      changeZoom(zoom + ZOOM_STEP);
    } else if (event.key === '-') {
      event.preventDefault();
      changeZoom(zoom - ZOOM_STEP);
    } else if (event.key === '0') {
      event.preventDefault();
      changeZoom(100);
    }
  };

  return (
    <AppDialog open onClose={onClose} labelledBy="media-viewer-title" className="media-viewer-backdrop">
      <section className="media-viewer" onKeyDown={handleKeyboard}>
        <header className="media-viewer-header">
          <div>
            <h2 id="media-viewer-title" tabIndex={-1} autoFocus>{title}</h2>
            <p>{message.senderName} · {t('use +/− to zoom')}</p>
          </div>
          <div className="media-viewer-actions">
            <button type="button" onClick={() => changeZoom(zoom - ZOOM_STEP)} disabled={zoom <= MIN_ZOOM} aria-label={t('Zoom image out')} data-tooltip={t('Zoom Out')} data-tooltip-placement="below"><MediaIcon name="minus" /></button>
            <output aria-label={t('Zoom level')} aria-live="polite">{zoom}%</output>
            <button type="button" onClick={() => changeZoom(zoom + ZOOM_STEP)} disabled={zoom >= MAX_ZOOM} aria-label={t('Zoom image in')} data-tooltip={t('Zoom In')} data-tooltip-placement="below"><MediaIcon name="plus" /></button>
            <button type="button" onClick={() => changeZoom(100)} disabled={zoom === 100} aria-label={t('Reset image size')} data-tooltip={t('Fit to Screen')} data-tooltip-placement="below"><MediaIcon name="reset" /></button>
            <button type="button" className="media-download-button" onClick={() => void onDownload(message)} disabled={downloading} aria-label={downloading ? t('Downloading image') : t('Download image')} data-tooltip={downloading ? t('Downloading…') : t('Download Image')} data-tooltip-placement="below"><MediaIcon name="download" /><span>{downloading ? t('Downloading…') : t('Download')}</span></button>
            <button type="button" className="media-close-button" onClick={onClose} aria-label={t('Close image viewer')} data-tooltip={t('Close')} data-tooltip-placement="below"><MediaIcon name="close" /></button>
          </div>
        </header>
        <div className="media-viewer-viewport" onClick={dismissFromDarkArea}>
          <div className="media-viewer-stage" style={stageStyle} onClick={dismissFromDarkArea}>
            <button type="button" className={zoom === 100 ? 'media-viewer-image-button' : 'media-viewer-image-button zoomed'} onClick={() => changeZoom(zoom === 100 ? 200 : 100)} aria-label={zoom === 100 ? t('Zoom image to 200%') : t('Reset image to 100%')}>
              {/* Signed asset URLs are intentionally rendered as plain images. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={message.assetUrl} width="1200" height="720" alt={title} draggable="false" onLoad={(event) => { const image = event.currentTarget; setImageSize({ width: image.naturalWidth || 1200, height: image.naturalHeight || 720 }); }} onError={() => { if (message.assetKey) onRefresh(message.assetKey); }} />
            </button>
          </div>
        </div>
        <footer className="media-viewer-footer"><span>{t('Tap the image to zoom · tap the dark area to close.')}</span><span>{MIN_ZOOM}%–{MAX_ZOOM}%</span></footer>
      </section>
    </AppDialog>
  );
}
