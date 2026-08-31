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
  firstUnreadSequence: number | null;
  lastReadSequence: number;
  muted: boolean;
  messageCount: number;
  mediaCount: number;
  inviteActive: boolean;
  inviteExpiresAt: number | null;
  inviteMaxUses: number | null;
  inviteUseCount: number;
  guestAdmissionPolicy: 'off' | 'approval' | 'link';
  pendingRequestCount: number;
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
  imageDescription: string | null;
  imagePurpose: 'creative' | 'reference';
  replyToId: string | null;
  canvasParentId: string | null;
  canvasRootId: string | null;
  canvasVersion: number | null;
  lineageRoot: { id: string; type: 'image' | 'canvas'; senderName: string; deletedAt: number | null } | null;
  continuationCount: number;
  createdAt: number;
  editedAt: number | null;
  deletedAt: number | null;
  readCount: number;
  reactions: ReactionView[];
  visualStatus: 'exploring' | 'needs_changes' | 'selected';
  decisionNote: string | null;
  decisionOwnerId: string | null;
  decidedAt: number | null;
  blockedAuthor: boolean;
};

export type CanvasLineageItem = Pick<MessageView,
  'id' | 'sequence' | 'roomId' | 'senderName' | 'type' | 'body' | 'assetKey' | 'assetUrl' | 'canvasParentId' | 'canvasVersion' | 'createdAt' | 'deletedAt' | 'visualStatus' | 'decisionNote' | 'decisionOwnerId' | 'decidedAt'
> & { voteCount: number; voted: boolean };

export type RoomPersonView = {
  id: string;
  kind: 'user' | 'guest';
  displayName: string;
  avatarColor: string | null;
  role: 'owner' | 'member' | 'guest';
  joinedAt: number;
};

export type RoomPeopleView = {
  members: RoomPersonView[];
  currentRole: 'owner' | 'member' | 'guest' | null;
  muted: boolean;
  allowGuests: boolean;
  guestAdmissionPolicy: 'off' | 'approval' | 'link';
  canManage: boolean;
  kind: string;
  inviteActive: boolean;
  inviteExpiresAt: number | null;
  inviteMaxUses: number | null;
  inviteUseCount: number;
  blockedAccounts?: Array<{ id: string; displayName: string; avatarColor: string }>;
};

export type GuestRequestView = {
  id: string;
  displayName: string;
  introduction: string | null;
  status: 'pending' | 'approved' | 'claimed' | 'rejected' | 'cancelled' | 'expired';
  requestedAt: number;
  expiresAt: number;
  grantExpiresAt: number | null;
  inviteCodeHint: string;
  decisionReason: string | null;
};

export type GuestRequestStatusView = GuestRequestView & {
  room: { name: string; hostedBy: string | null };
  canClaim: boolean;
};
