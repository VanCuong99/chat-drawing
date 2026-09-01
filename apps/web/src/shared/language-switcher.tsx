'use client';

import { useSyncExternalStore } from 'react';
import { useLanguage } from '@/src/i18n/language-provider';

const subscribeToHydration = () => () => undefined;

export default function LanguageSwitcher({ compact = false }: { compact?: boolean }) {
  const { locale, setLocale, t } = useLanguage();
  const interactive = useSyncExternalStore(subscribeToHydration, () => true, () => false);
  return (
    <label className={compact ? 'language-switcher compact' : 'language-switcher'}>
      <span className="sr-only">{t('Switch language')}</span>
      <svg aria-hidden="true" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" /></svg>
      <span className="language-value" aria-hidden="true">{compact ? locale.toUpperCase() : locale === 'en' ? t('English') : t('Vietnamese')}</span>
      <svg className="language-chevron" aria-hidden="true" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="m4 6 4 4 4-4" /></svg>
      <select disabled={!interactive} value={locale} onChange={(event) => setLocale(event.target.value as 'en' | 'vi')} aria-label={t('Switch language')}>
        <option value="en" lang="en">{compact ? 'EN' : `EN · ${t('English')}`}</option>
        <option value="vi" lang="vi">{compact ? 'VI' : `VI · ${t('Vietnamese')}`}</option>
      </select>
    </label>
  );
}
