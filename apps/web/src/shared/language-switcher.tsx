'use client';

import { useSyncExternalStore } from 'react';
import { useLanguage } from '@/src/i18n/language-provider';

const subscribeToHydration = () => () => undefined;

export default function LanguageSwitcher({ compact = false }: { compact?: boolean }) {
  const { locale, setLocale, t } = useLanguage();
  const interactive = useSyncExternalStore(subscribeToHydration, () => true, () => false);
  return (
    <div className={compact ? 'language-switcher compact' : 'language-switcher'} role="group" aria-label={t('Switch language')}>
      <button type="button" disabled={!interactive} onClick={() => setLocale('en')} aria-pressed={locale === 'en'} lang="en">EN<span>{compact ? '' : t('English')}</span></button>
      <button type="button" disabled={!interactive} onClick={() => setLocale('vi')} aria-pressed={locale === 'vi'} lang="vi">VI<span>{compact ? '' : t('Vietnamese')}</span></button>
    </div>
  );
}
