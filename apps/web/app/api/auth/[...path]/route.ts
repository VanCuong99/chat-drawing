import { auth } from '@/src/server/auth';

export const dynamic = 'force-dynamic';
export const { GET, POST, PUT, PATCH, DELETE } = auth.handler();
