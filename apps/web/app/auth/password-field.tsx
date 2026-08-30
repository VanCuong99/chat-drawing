'use client';

import { useId, useState } from 'react';
import { useLanguage } from '@/src/i18n/language-provider';

export default function PasswordField({ autoComplete, minLength }: { autoComplete: 'current-password' | 'new-password'; minLength?: number }) {
  const { t } = useLanguage();
  const [visible, setVisible] = useState(false);
  const requirementsId = useId();
  return (
    <label>{t('Password')}<span className="password-input">
      <input required minLength={minLength} type={visible ? 'text' : 'password'} name="password" autoComplete={autoComplete} aria-describedby={minLength ? requirementsId : undefined} />
      <button type="button" onClick={() => setVisible((value) => !value)} aria-label={visible ? t('Hide password') : t('Show password')} aria-pressed={visible}>
        <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z" /><circle cx="12" cy="12" r="2.6" />{visible ? null : <path d="m4 4 16 16" />}</svg>
      </button>
    </span>{minLength ? <small id={requirementsId} className="password-requirements">{t('Use at least {count} characters. You can paste from a password manager.', { count: minLength })}</small> : null}</label>
  );
}
