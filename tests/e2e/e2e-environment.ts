function requiredOrigin(name: 'NET_E2E_API_ORIGIN' | 'NET_E2E_WEB_ORIGIN') {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is managed by the E2E runner. Run \`pnpm test:e2e\`.`);
  return value;
}

export const e2eApiOrigin = requiredOrigin('NET_E2E_API_ORIGIN');
export const e2eApiUrl = `${e2eApiOrigin}/api`;
export const e2eWebOrigin = requiredOrigin('NET_E2E_WEB_ORIGIN');
