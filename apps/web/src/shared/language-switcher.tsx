'use client';

import { useLanguage } from '@/src/i18n/language-provider';

export default function LanguageSwitcher({ compact = false }: { compact?: boolean }) {
  const { locale, setLocale, t } = useLanguage();
  return (
    <div className={compact ? 'language-switcher compact' : 'language-switcher'} role="group" aria-label={t('Switch language')}>
      <button type="button" onClick={() => setLocale('en')} aria-pressed={locale === 'en'} lang="en">EN<span>{compact ? '' : t('English')}</span></button>
      <button type="button" onClick={() => setLocale('vi')} aria-pressed={locale === 'vi'} lang="vi">VI<span>{compact ? '' : t('Vietnamese')}</span></button>
    </div>
  );
}
