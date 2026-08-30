export type UserActor = {
  kind: 'user';
  id: string;
  actorKey: string;
  displayName: string;
  email: string;
  expiresAt: null;
};

export type GuestActor = {
  kind: 'guest';
  id: string;
  actorKey: string;
  displayName: string;
  email: null;
  expiresAt: number;
  roomId: string;
};

export type Actor = UserActor | GuestActor;

export type RealtimeClaims = {
  sub: string;
  kind: Actor['kind'];
  actorKey: string;
  displayName: string;
  email?: string;
  roomId?: string;
  exp?: number;
};

export type AssetReadClaims = Pick<RealtimeClaims, 'sub' | 'kind' | 'exp'> & {
  purpose: 'asset-read';
  assetKey: string;
  roomId: string;
};
