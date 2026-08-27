export type ActorView = {
  kind: 'user' | 'guest';
  id: string;
  displayName: string;
  email?: string;
  expiresAt?: number;
};

export type RoomView = {
  id: string;
  name: string;
  kind: string;
  inviteCode: string;
  allowGuests: boolean;
  preview: string;
  lastActivity: number;
  unreadCount: number;
};

export type ReactionView = { emoji: string; count: number; reacted: boolean };
export type UserSummary = { id: string; displayName: string; email: string; avatarColor: string };
export type PaletteComponentView = { color: string; weight: number };
export type PaletteColorView = {
  id: string;
  name: string;
  color: string;
  sourceA: string;
  sourceB: string;
  ratio: number;
  components: PaletteComponentView[];
  model: { id: string; version: number; colorSpace: string; illuminant: string };
  createdAt: number;
};

export type MessageView = {
  id: string;
  sequence: number;
  roomId: string;
  senderId: string | null;
  guestSessionId: string | null;
  senderName: string;
  type: 'text' | 'image' | 'canvas' | 'system';
  body: string | null;
  assetKey: string | null;
  assetUrl: string | null;
  replyToId: string | null;
  canvasParentId: string | null;
  canvasVersion: number | null;
  createdAt: number;
  editedAt: number | null;
  readCount: number;
  reactions: ReactionView[];
};
