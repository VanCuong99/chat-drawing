import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getAuthenticatedUser, safeReturnTo } from '@/src/server/auth';
import { signUpAction } from '../actions';
import AuthSubmitButton from '../auth-submit-button';

export const dynamic = 'force-dynamic';

export default async function SignUpPage({ searchParams }: { searchParams?: Promise<{ error?: string; returnTo?: string }> }) {
  const parameters = await searchParams;
  const returnTo = safeReturnTo(parameters?.returnTo);
  if (await getAuthenticatedUser()) redirect(returnTo);
  return (
    <main className="auth-shell">
      <section className="auth-card" aria-labelledby="auth-title">
        <Link className="auth-brand" href="/" aria-label="Về trang chủ Nét"><span aria-hidden="true">〽</span> Nét</Link>
        <p className="auth-kicker">Một góc riêng cho nét của bạn</p>
        <h1 id="auth-title">Tạo tài khoản</h1>
        <p className="auth-lead">Tài khoản miễn phí giúp nội dung không biến mất khi phiên chat kết thúc.</p>
        {parameters?.error ? <p className="auth-error" role="alert">{parameters.error}</p> : null}
        <form action={signUpAction} className="auth-form">
          <input type="hidden" name="returnTo" value={returnTo} />
          <label>Tên hiển thị<input required minLength={2} maxLength={60} name="name" autoComplete="name" /></label>
          <label>Email<input required type="email" name="email" autoComplete="email" spellCheck={false} placeholder="ban@example.com…" /></label>
          <label>Mật khẩu<input required minLength={8} type="password" name="password" autoComplete="new-password" /></label>
          <AuthSubmitButton idleLabel="Tạo tài khoản" pendingLabel="Đang tạo tài khoản…" />
        </form>
        <p className="auth-switch">Đã có tài khoản? <Link href={`/auth/sign-in?returnTo=${encodeURIComponent(returnTo)}`}>Đăng nhập</Link></p>
        <Link className="auth-guest" href={returnTo}>Tiếp tục với tư cách khách</Link>
      </section>
    </main>
  );
}
