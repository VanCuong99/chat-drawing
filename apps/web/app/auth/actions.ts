'use server';

import { redirect } from 'next/navigation';
import { auth, safeReturnTo } from '@/src/server/auth';
import { getRequestLanguage } from '@/src/i18n/server';

function formText(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === 'string' ? value.trim() : '';
}

function errorRedirect(path: string, message: string, returnTo: string): never {
  const params = new URLSearchParams({ error: message, returnTo });
  redirect(`${path}?${params.toString()}`);
}

function authErrorMessage(error: { code?: string; message?: string } | null, fallback: string, invalidOrigin: string) {
  if (error?.code === 'INVALID_ORIGIN' || error?.message?.toLowerCase().includes('invalid origin')) {
    return invalidOrigin;
  }
  return error?.message || fallback;
}

export async function signInAction(formData: FormData) {
  const { t } = await getRequestLanguage();
  const email = formText(formData, 'email').toLowerCase();
  const password = formText(formData, 'password');
  const returnTo = safeReturnTo(formData.get('returnTo'));
  if (!email || !password) errorRedirect('/auth/sign-in', t('Enter your email and password.'), returnTo);
  const { error } = await auth.signIn.email({ email, password });
  if (error) errorRedirect('/auth/sign-in', authErrorMessage(error, t('Could not sign in.'), t('Authentication is unavailable on this domain. Reload the page and try again.')), returnTo);
  redirect(returnTo);
}

export async function signUpAction(formData: FormData) {
  const { t } = await getRequestLanguage();
  const name = formText(formData, 'name');
  const email = formText(formData, 'email').toLowerCase();
  const password = formText(formData, 'password');
  const returnTo = safeReturnTo(formData.get('returnTo'));
  if (name.length < 2 || !email || password.length < 8) {
    errorRedirect('/auth/sign-up', t('Name must be at least 2 characters and password at least 8 characters.'), returnTo);
  }
  const { error } = await auth.signUp.email({ name, email, password });
  if (error) errorRedirect('/auth/sign-up', authErrorMessage(error, t('Could not create the account.'), t('Authentication is unavailable on this domain. Reload the page and try again.')), returnTo);

  // Explicitly sign in after creating the user. Some Neon Auth configurations
  // create the account without issuing a browser session on the sign-up call.
  const { error: signInError } = await auth.signIn.email({ email, password });
  if (signInError) {
    errorRedirect('/auth/sign-in', t('Your account was created. Sign in to open your chat space.'), returnTo);
  }
  redirect(returnTo);
}
