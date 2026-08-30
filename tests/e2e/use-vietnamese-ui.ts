import type { BrowserContext } from '@playwright/test';
import { e2eWebOrigin } from './e2e-environment';

export async function setVietnameseUi(context: BrowserContext) {
  await context.addCookies([{
    name: 'net_locale',
    value: 'vi',
    url: e2eWebOrigin,
    sameSite: 'Lax',
  }]);
}
