import type { BrowserContext } from '@playwright/test';

export async function setVietnameseUi(context: BrowserContext) {
  await context.addCookies([{
    name: 'net_locale',
    value: 'vi',
    url: 'http://localhost:3000',
    sameSite: 'Lax',
  }]);
}
