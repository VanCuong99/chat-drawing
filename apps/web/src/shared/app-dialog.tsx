'use client';

import { type MouseEvent, type ReactNode, useEffect, useRef } from 'react';

export default function AppDialog({
  open,
  onClose,
  labelledBy,
  describedBy,
  children,
  className = '',
}: {
  open: boolean;
  onClose: () => void;
  labelledBy: string;
  describedBy?: string;
  children: ReactNode;
  className?: string;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog || !open) return;
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!dialog.open) dialog.showModal();
    return () => {
      if (dialog.open) dialog.close();
      requestAnimationFrame(() => returnFocusRef.current?.focus());
    };
  }, [open]);

  if (!open) return null;

  const dismissFromBackdrop = (event: MouseEvent<HTMLDialogElement>) => {
    if (event.target === event.currentTarget) onClose();
  };

  return (
    <dialog
      ref={dialogRef}
      className={`modal-backdrop ${className}`.trim()}
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      aria-modal="true"
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      onMouseDown={dismissFromBackdrop}
    >
      {children}
    </dialog>
  );
}
