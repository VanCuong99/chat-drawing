import { AsyncLocalStorage } from 'node:async_hooks';

export type RequestContext = {
  requestId: string;
  startedAt: number;
};

export const requestContext = new AsyncLocalStorage<RequestContext>();

export function currentRequestId() { return requestContext.getStore()?.requestId; }
