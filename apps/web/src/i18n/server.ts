import { cookies } from 'next/headers';
import { LOCALE_COOKIE, resolveLocale, translate } from './messages';

export async function getRequestLanguage() {
  const cookieStore = await cookies();
  const locale = resolveLocale(cookieStore.get(LOCALE_COOKIE)?.value);
  return {
    locale,
    t: (message: string, params?: Record<string, string | number>) => translate(locale, message, params),
  };
}
