'use client';

import { useFormStatus } from 'react-dom';

export default function AuthSubmitButton({ idleLabel, pendingLabel }: { idleLabel: string; pendingLabel: string }) {
  const { pending } = useFormStatus();

  return (
    <button type="submit" disabled={pending} aria-disabled={pending}>
      <span aria-live="polite">{pending ? pendingLabel : idleLabel}</span>
    </button>
  );
}
