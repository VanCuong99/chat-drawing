import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getAuthenticatedUser, safeReturnTo } from '@/src/server/auth';
import { signInAction } from '../actions';
import AuthSubmitButton from '../auth-submit-button';

export const dynamic = 'force-dynamic';

export default async function SignInPage({ searchParams }: { searchParams?: Promise<{ error?: string; returnTo?: string }> }) {
  const parameters = await searchParams;
  const returnTo = safeReturnTo(parameters?.returnTo);
  if (await getAuthenticatedUser()) redirect(returnTo);
  return (
    <main className="auth-shell">
      <section className="auth-card" aria-labelledby="auth-title">
        <Link className="auth-brand" href="/" aria-label="Về trang chủ Nét"><span aria-hidden="true">〽</span> Nét</Link>
        <p className="auth-kicker">Vẽ điều khó nói</p>
        <h1 id="auth-title">Đăng nhập</h1>
        <p className="auth-lead">Giữ cuộc trò chuyện, bản vẽ và bảng màu của bạn lâu dài.</p>
        {parameters?.error ? <p className="auth-error" role="alert">{parameters.error}</p> : null}
        <form action={signInAction} className="auth-form">
          <input type="hidden" name="returnTo" value={returnTo} />
          <label>Email<input required type="email" name="email" autoComplete="email" spellCheck={false} placeholder="ban@example.com…" /></label>
          <label>Mật khẩu<input required type="password" name="password" autoComplete="current-password" /></label>
          <AuthSubmitButton idleLabel="Đăng nhập" pendingLabel="Đang đăng nhập…" />
        </form>
        <p className="auth-switch">Chưa có tài khoản? <Link href={`/auth/sign-up?returnTo=${encodeURIComponent(returnTo)}`}>Tạo tài khoản miễn phí</Link></p>
        <Link className="auth-guest" href={returnTo}>Tiếp tục với tư cách khách</Link>
      </section>
    </main>
  );
}
