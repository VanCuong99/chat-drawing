'use server';

import { redirect } from 'next/navigation';
import { auth, safeReturnTo } from '@/src/server/auth';

function formText(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === 'string' ? value.trim() : '';
}

function errorRedirect(path: string, message: string, returnTo: string): never {
  const params = new URLSearchParams({ error: message, returnTo });
  redirect(`${path}?${params.toString()}`);
}

export async function signInAction(formData: FormData) {
  const email = formText(formData, 'email').toLowerCase();
  const password = formText(formData, 'password');
  const returnTo = safeReturnTo(formData.get('returnTo'));
  if (!email || !password) errorRedirect('/auth/sign-in', 'Vui lòng nhập email và mật khẩu.', returnTo);
  const { error } = await auth.signIn.email({ email, password });
  if (error) errorRedirect('/auth/sign-in', error.message || 'Không thể đăng nhập.', returnTo);
  redirect(returnTo);
}

export async function signUpAction(formData: FormData) {
  const name = formText(formData, 'name');
  const email = formText(formData, 'email').toLowerCase();
  const password = formText(formData, 'password');
  const returnTo = safeReturnTo(formData.get('returnTo'));
  if (name.length < 2 || !email || password.length < 8) {
    errorRedirect('/auth/sign-up', 'Tên phải có ít nhất 2 ký tự và mật khẩu ít nhất 8 ký tự.', returnTo);
  }
  const { error } = await auth.signUp.email({ name, email, password });
  if (error) errorRedirect('/auth/sign-up', error.message || 'Không thể tạo tài khoản.', returnTo);
  redirect(returnTo);
}
