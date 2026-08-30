import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getAuthenticatedUser, safeReturnTo } from '@/src/server/auth';
import { signUpAction } from '../actions';
import AuthSubmitButton from '../auth-submit-button';
import LanguageSwitcher from '@/src/shared/language-switcher';
import { getRequestLanguage } from '@/src/i18n/server';
import AuthInviteContext from '../invite-context';
import PasswordField from '../password-field';

export const dynamic = 'force-dynamic';

export default async function SignUpPage({ searchParams }: { searchParams?: Promise<{ error?: string; returnTo?: string }> }) {
  const parameters = await searchParams;
  const { t } = await getRequestLanguage();
  const returnTo = safeReturnTo(parameters?.returnTo);
  if (await getAuthenticatedUser()) redirect(returnTo);
  return (
    <main className="auth-shell">
      <section className="auth-card" aria-labelledby="auth-title">
        <div className="auth-card-top"><Link className="auth-brand" href="/" aria-label={t('Back to Nét home')}><span className="logo-mark" aria-hidden="true"><i /><i /><i /></span> Nét</Link><LanguageSwitcher compact /></div>
        <p className="auth-kicker">{t('A lasting space for your ideas')}</p>
        <h1 id="auth-title">{t('Create an Account')}</h1>
        <p className="auth-lead">{t('A free account keeps your content after a chat session ends.')}</p>
        <AuthInviteContext returnTo={returnTo} />
        {parameters?.error ? <p className="auth-error" role="alert">{parameters.error}</p> : null}
        <form action={signUpAction} className="auth-form">
          <input type="hidden" name="returnTo" value={returnTo} />
          <label>{t('Display Name')}<input required minLength={2} maxLength={60} name="name" autoComplete="name" /></label>
          <label>Email<input required type="email" name="email" autoComplete="email" spellCheck={false} placeholder="you@example.com…" /></label>
          <PasswordField autoComplete="new-password" minLength={8} />
          <AuthSubmitButton idleLabel={t('Create Account')} pendingLabel={t('Creating account…')} />
        </form>
        <p className="auth-switch">{t('Already have an account?')} <Link href={`/auth/sign-in?returnTo=${encodeURIComponent(returnTo)}`}>{t('Sign In')}</Link></p>
        <Link className="auth-guest" href={returnTo}>{t('Continue as a Guest')}</Link>
      </section>
    </main>
  );
}
