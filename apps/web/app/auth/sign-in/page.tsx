import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getAuthenticatedUser, safeReturnTo } from '@/src/server/auth';
import { signInAction } from '../actions';
import AuthSubmitButton from '../auth-submit-button';
import LanguageSwitcher from '@/src/shared/language-switcher';
import { getRequestLanguage } from '@/src/i18n/server';
import AuthInviteContext from '../invite-context';
import PasswordField from '../password-field';

export const dynamic = 'force-dynamic';

export default async function SignInPage({ searchParams }: { searchParams?: Promise<{ error?: string; returnTo?: string }> }) {
  const parameters = await searchParams;
  const { t } = await getRequestLanguage();
  const returnTo = safeReturnTo(parameters?.returnTo);
  if (await getAuthenticatedUser()) redirect(returnTo);
  return (
    <main className="auth-shell">
      <section className="auth-card" aria-labelledby="auth-title">
        <div className="auth-card-top"><Link className="auth-brand" href="/" aria-label={t('Back to Nét home')}><span className="logo-mark" aria-hidden="true"><i /><i /><i /></span> Nét</Link><LanguageSwitcher compact /></div>
        <p className="auth-kicker">{t('Draw what words cannot say')}</p>
        <h1 id="auth-title">{t('Sign In')}</h1>
        <p className="auth-lead">{t('Keep your conversations, drawings, and palette for the long term.')}</p>
        <AuthInviteContext returnTo={returnTo} />
        {parameters?.error ? <p className="auth-error" role="alert">{parameters.error}</p> : null}
        <form action={signInAction} className="auth-form">
          <input type="hidden" name="returnTo" value={returnTo} />
          <label>Email<input required type="email" name="email" autoComplete="email" spellCheck={false} placeholder="you@example.com…" /></label>
          <PasswordField autoComplete="current-password" />
          <AuthSubmitButton idleLabel={t('Sign In')} pendingLabel={t('Signing in…')} />
        </form>
        <p className="auth-switch">{t('New to Nét?')} <Link href={`/auth/sign-up?returnTo=${encodeURIComponent(returnTo)}`}>{t('Create a free account')}</Link></p>
        <Link className="auth-guest" href={returnTo}>{t('Continue as a Guest')}</Link>
      </section>
    </main>
  );
}
