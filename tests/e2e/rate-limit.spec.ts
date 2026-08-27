import { expect, test } from '@playwright/test';

const API_URL = 'http://localhost:3001/api';

test('rate limit message dùng counter Postgres nguyên tử khi request đồng thời @critical', async ({ request }) => {
  test.setTimeout(60_000);
  const created = await request.post(`${API_URL}/guest`, { data: { displayName: `Rate E2E ${Date.now()}` } });
  expect(created.status()).toBe(200);
  const guest = await created.json() as { sessionId: string; roomId: string };
  const headers = { 'x-net-guest-session': guest.sessionId };

  try {
    const responses = await Promise.all(Array.from({ length: 121 }, (_, index) => request.post(`${API_URL}/rooms/${guest.roomId}/messages`, {
      headers,
      data: { type: 'text', text: `Tin giới hạn ${index + 1}` },
    })));
    expect(responses.filter((response) => response.status() === 200)).toHaveLength(120);
    expect(responses.filter((response) => response.status() === 429)).toHaveLength(1);
    await expect(responses.find((response) => response.status() === 429)!.json()).resolves.toMatchObject({ error: expect.stringContaining('thao tác quá nhanh') });
  } finally {
    await request.delete(`${API_URL}/guest`, { headers });
  }
});
