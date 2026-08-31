'use client';

import {
  type ChangeEvent,
  type CSSProperties,
  type FormEvent,
  Fragment,
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import Image from 'next/image';
import type { ActorView, CanvasLineageItem, GuestRequestStatusView, GuestRequestView, MessageView, PaletteColorView, RoomPeopleView, RoomPersonView, RoomView, UserSummary } from '@/src/shared/chat.types';
import { io, type Socket } from 'socket.io-client';
import AppDialog from '@/src/shared/app-dialog';
import LandingDoodle from '@/src/features/chat/landing-doodle';
import { deleteStudioDraftsForPrefix } from '@/src/features/drawing/studio-drafts';
import MediaViewer from '@/src/features/chat/media-viewer';
import { deleteOutboxBlob, deleteOutboxBlobsForPrefix, readOutboxBlob, saveOutboxBlob } from '@/src/features/chat/outbox-blobs';
import { preparePhoto, type PhotoCrop } from '@/src/features/chat/photo-preparation';
import { useLanguage } from '@/src/i18n/language-provider';
import { localeTag, translateApiMessage, type Locale } from '@/src/i18n/messages';
import LanguageSwitcher from '@/src/shared/language-switcher';

const DrawingStudio = lazy(() => import('@/src/features/drawing/drawing-studio'));
const DrawingLineage = lazy(() => import('@/src/features/chat/drawing-lineage'));

type InitialUser = { id: string; displayName: string; email: string } | null;
type Phase = 'loading' | 'landing' | 'app';
type InviteStatus = 'none' | 'checking' | 'guest' | 'approval' | 'auth-only' | 'invalid' | 'unavailable';
type InvitePreview = {
  name: string;
  hostedBy: string | null;
  participants: Array<{ displayName: string; avatarColor: string | null }>;
  participantCount: number;
  recentActivity: { type: 'text' | 'image' | 'canvas'; createdAt: number } | null;
  createdAt: number;
};
type InstallPromptEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> };
type StoredGuestRequest = { id: string; requestToken: string };
type ActiveGuestRequest = GuestRequestStatusView & { requestToken: string };
type GovernanceConfirmation = {
  patch: Record<string, unknown>;
  title: string;
  description: string;
  confirmLabel: string;
};

function relativeTime(timestamp: number, locale: Locale, now = Date.now()) {
  const seconds = Math.round((timestamp - now) / 1000);
  const formatter = new Intl.RelativeTimeFormat(localeTag(locale), { numeric: 'auto' });
  if (Math.abs(seconds) < 60) return formatter.format(0, 'minute');
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return formatter.format(minutes, 'minute');
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return formatter.format(hours, 'hour');
  return formatter.format(Math.round(hours / 24), 'day');
}

function guestRequestStorageKey(inviteCode: string) {
  return `net_guest_request:v1:${inviteCode}`;
}

function readStoredGuestRequest(inviteCode: string): StoredGuestRequest | null {
  if (!inviteCode || typeof window === 'undefined') return null;
  try {
    const value = JSON.parse(localStorage.getItem(guestRequestStorageKey(inviteCode)) ?? 'null') as Partial<StoredGuestRequest> | null;
    return value && typeof value.id === 'string' && typeof value.requestToken === 'string' ? { id: value.id, requestToken: value.requestToken } : null;
  } catch {
    return null;
  }
}

class ApiRequestError extends Error {
  constructor(public status: number, message: string, public requestId: string | null = null) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

function isRetryableSendError(error: unknown) {
  return error instanceof TypeError || (error instanceof ApiRequestError && (error.status === 429 || error.status >= 500));
}

async function clearStoredGuestOutbox(sessionId: string) {
  const legacyStorageKey = `net_message_outbox:v2:guest:${sessionId}`;
  const storagePrefix = `net_message_outbox:v3:guest:${sessionId}:`;
  let legacyBlobKeys: string[] = [];
  try {
    const legacy = JSON.parse(localStorage.getItem(legacyStorageKey) ?? '[]') as unknown;
    if (Array.isArray(legacy)) {
      legacyBlobKeys = legacy.flatMap((item) => item && typeof item === 'object' && typeof (item as { blobKey?: unknown; id?: unknown }).blobKey === 'string'
        ? [(item as { blobKey: string }).blobKey]
        : item && typeof item === 'object' && (item as { hasBlob?: unknown }).hasBlob === true && typeof (item as { id?: unknown }).id === 'string'
          ? [(item as { id: string }).id]
          : []);
    }
    const keys = Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index))
      .filter((key): key is string => Boolean(key && (key === legacyStorageKey || key.startsWith(storagePrefix))));
    for (const key of keys) localStorage.removeItem(key);
  } catch {
    // IndexedDB cleanup below does not depend on readable local metadata.
  }
  await Promise.all(legacyBlobKeys.map((key) => deleteOutboxBlob(key).catch(() => undefined)));
  await deleteOutboxBlobsForPrefix(`guest:${sessionId}:`).catch(() => undefined);
}

type GuestRecovery = {
  message: string;
  requestId: string | null;
};

type SendableMessage = {
  type: 'text' | 'image' | 'canvas';
  text?: string;
  assetKey?: string;
  canvasParentId?: string | null;
  imageDescription?: string;
  imagePurpose?: 'creative' | 'reference';
};

type PendingMessage = {
  id: string;
  roomId: string;
  type: 'text' | 'image' | 'canvas';
  text: string | null;
  assetKey: string | null;
  canvasParentId: string | null;
  imageDescription?: string | null;
  imagePurpose?: 'creative' | 'reference';
  fileName: string | null;
  blobKey: string | null;
  replyToId: string | null;
  createdAt: number;
  status: 'waiting' | 'sending' | 'failed' | 'blocked';
  error: string | null;
};

function restorePendingMessage(item: unknown): PendingMessage | null {
  if (!item || typeof item !== 'object') return null;
  const candidate = item as Partial<PendingMessage> & { hasBlob?: boolean };
  const type = candidate.type === 'image' || candidate.type === 'canvas' ? candidate.type : 'text';
  if (typeof candidate.id !== 'string' || typeof candidate.roomId !== 'string' || typeof candidate.createdAt !== 'number') return null;
  if (type === 'text' && typeof candidate.text !== 'string') return null;
  return {
    id: candidate.id,
    roomId: candidate.roomId,
    type,
    text: typeof candidate.text === 'string' ? candidate.text : null,
    assetKey: typeof candidate.assetKey === 'string' ? candidate.assetKey : null,
    canvasParentId: typeof candidate.canvasParentId === 'string' ? candidate.canvasParentId : null,
    imageDescription: typeof candidate.imageDescription === 'string' ? candidate.imageDescription : null,
    imagePurpose: candidate.imagePurpose === 'reference' ? 'reference' : 'creative',
    fileName: typeof candidate.fileName === 'string' ? candidate.fileName : null,
    blobKey: typeof candidate.blobKey === 'string' ? candidate.blobKey : candidate.hasBlob === true ? candidate.id : null,
    replyToId: typeof candidate.replyToId === 'string' ? candidate.replyToId : null,
    createdAt: candidate.createdAt,
    status: candidate.status === 'blocked' ? 'blocked' : 'waiting',
    error: typeof candidate.error === 'string' ? candidate.error : null,
  };
}

function serializePendingMessage(message: PendingMessage) {
  return JSON.stringify({ ...message, status: message.status === 'blocked' ? 'blocked' : 'waiting' });
}

function readStoredOutbox(storagePrefix: string) {
  const recovered = new Map<string, PendingMessage>();
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index);
    if (!key?.startsWith(storagePrefix)) continue;
    try {
      const item = restorePendingMessage(JSON.parse(localStorage.getItem(key) ?? 'null'));
      if (item) recovered.set(item.id, item);
    } catch {
      // Corrupt per-item metadata is ignored without affecting other queued items.
    }
  }
  const legacyKey = storagePrefix.replace('net_message_outbox:v3:', 'net_message_outbox:v2:').slice(0, -1);
  try {
    const legacy = JSON.parse(localStorage.getItem(legacyKey) ?? '[]') as unknown;
    if (Array.isArray(legacy)) {
      for (const value of legacy) {
        const item = restorePendingMessage(value);
        if (item && !recovered.has(item.id)) recovered.set(item.id, item);
      }
    }
  } catch {
    // A corrupt legacy queue must not hide valid v3 items.
  }
  return { messages: [...recovered.values()].sort((left, right) => left.createdAt - right.createdAt), legacyKey };
}

const API_REQUEST_ORIGIN = (process.env.NEXT_PUBLIC_API_REQUEST_URL ?? '').replace(/\/$/, '');

const EMOJIS = ['❤️', '👍', '✨', '😂', '👀'];

type UiIconName = 'arrow' | 'check' | 'close' | 'download' | 'draw' | 'external' | 'group' | 'history' | 'info' | 'install' | 'link' | 'lock' | 'menu' | 'message' | 'more' | 'plus' | 'reply' | 'search' | 'send' | 'user';

function UiIcon({ name, size = 20 }: { name: UiIconName; size?: number }) {
  const normalizedSize = ([14, 16, 18, 20, 24] as const).reduce((closest, token) => Math.abs(token - size) < Math.abs(closest - size) ? token : closest, 20);
  const paths = {
    arrow: <><path d="M5 12h14" /><path d="m13 6 6 6-6 6" /></>,
    check: <path d="m5 12 4 4L19 6" />,
    close: <><path d="m6 6 12 12" /><path d="M18 6 6 18" /></>,
    download: <><path d="M12 3v12" /><path d="m7 10 5 5 5-5" /><path d="M5 21h14" /></>,
    draw: <><path d="m4 20 4.6-1.1L19 8.5 15.5 5 5.1 15.4 4 20Z" /><path d="m13.8 6.7 3.5 3.5" /></>,
    external: <><path d="M14 4h6v6" /><path d="M20 4 11 13" /><path d="M18 13v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h6" /></>,
    group: <><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" /></>,
    history: <><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5" /><path d="M12 7v5l3 2" /></>,
    info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v6" /><path d="M12 7h.01" /></>,
    install: <><path d="M12 3v12" /><path d="m7 10 5 5 5-5" /><path d="M5 21h14" /></>,
    link: <><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" /><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" /></>,
    lock: <><rect x="5" y="10" width="14" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></>,
    menu: <><path d="M4 7h16" /><path d="M4 12h16" /><path d="M4 17h16" /></>,
    message: <path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z" />,
    more: <><circle cx="5" cy="12" r="1" fill="currentColor" stroke="none" /><circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" /><circle cx="19" cy="12" r="1" fill="currentColor" stroke="none" /></>,
    plus: <><path d="M12 5v14" /><path d="M5 12h14" /></>,
    reply: <><path d="m9 17-5-5 5-5" /><path d="M4 12h9a7 7 0 0 1 7 7" /></>,
    search: <><circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" /></>,
    send: <><path d="m4 4 17 8-17 8 3-8-3-8Z" /><path d="M7 12h14" /></>,
    user: <><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></>,
  };
  return <svg aria-hidden="true" viewBox="0 0 24 24" width={normalizedSize} height={normalizedSize} fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">{paths[name]}</svg>;
}

function extractInviteCode(value: string) {
  const input = value.trim();
  if (!input) return '';
  try {
    const url = new URL(input.includes('://') ? input : `https://net.local/${input.startsWith('?') ? input : `?room=${encodeURIComponent(input)}`}`);
    return (url.searchParams.get('room') ?? '').trim();
  } catch {
    const match = input.match(/[?&]room=([^&#]+)/i);
    return match ? decodeURIComponent(match[1]).trim() : input;
  }
}

function avatarStyle(seed: string): CSSProperties {
  const colors = ['#6f4ee8', '#ef7668', '#3aa694', '#e19a3f', '#4e8fb8', '#9a64cf'];
  let hash = 0;
  for (const char of seed) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return { '--avatar': colors[Math.abs(hash) % colors.length] } as CSSProperties;
}

function timeLabel(value: number, locale: Locale) {
  const date = new Date(value);
  const today = new Date();
  return date.toDateString() === today.toDateString()
    ? new Intl.DateTimeFormat(localeTag(locale), { hour: '2-digit', minute: '2-digit' }).format(date)
    : new Intl.DateTimeFormat(localeTag(locale), { day: '2-digit', month: '2-digit' }).format(date);
}

function localDateStamp(value: number) {
  const date = new Date(value);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function messageDayKey(value: number) {
  return localDateStamp(value);
}

function messageDayLabel(value: number, locale: Locale, t: (key: string) => string) {
  const date = new Date(value);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === today.toDateString()) return t('Today');
  if (date.toDateString() === yesterday.toDateString()) return t('Yesterday');
  return new Intl.DateTimeFormat(localeTag(locale), { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric' }).format(date);
}

function sameMessage(left: MessageView, right: MessageView) {
  return left.id === right.id
    && left.sequence === right.sequence
    && left.body === right.body
    && left.assetUrl === right.assetUrl
    && left.assetKey === right.assetKey
    && left.editedAt === right.editedAt
    && left.deletedAt === right.deletedAt
    && left.lineageRoot?.id === right.lineageRoot?.id
    && left.lineageRoot?.deletedAt === right.lineageRoot?.deletedAt
    && left.readCount === right.readCount
    && left.continuationCount === right.continuationCount
    && left.reactions.length === right.reactions.length
    && left.reactions.every((reaction, index) => {
      const next = right.reactions[index];
      return next && reaction.emoji === next.emoji && reaction.count === next.count && reaction.reacted === next.reacted;
    });
}

const LEGACY_SYSTEM_MESSAGE_KEYS: Record<string, string> = {
  'Phiên khách đã bắt đầu. Khi phiên kết thúc, khách mất quyền truy cập nhưng nội dung đã gửi vẫn được giữ lại trong phòng.': 'The guest session started. When it ends, the guest loses access but submitted content remains in the room.',
  'Phiên tạm thời đã bắt đầu. Nội dung chỉ được lưu lâu dài khi phòng có thành viên đăng nhập.': 'The guest session started. When it ends, the guest loses access but submitted content remains in the room.',
  'Phiên khách đã bắt đầu. Nội dung của bạn sẽ được xoá khi kết thúc phiên.': 'The guest session started. When it ends, the guest loses access but submitted content remains in the room.',
};

function systemMessageKey(body: string | null) {
  if (!body) return 'System update';
  return LEGACY_SYSTEM_MESSAGE_KEYS[body] ?? body;
}

function Logo({ compact = false }: { compact?: boolean }) {
  const { t } = useLanguage();
  return (
    <div className={compact ? 'net-logo compact-logo' : 'net-logo'}>
      <span className="logo-mark" aria-hidden="true"><i /><i /><i /></span>
      <span><strong translate="no">Nét</strong>{!compact && <small>{t('Draw what words cannot say')}</small>}</span>
    </div>
  );
}

function InviteContext({ preview }: { preview: InvitePreview | null }) {
  const { locale, t } = useLanguage();
  if (!preview) return null;
  const activity = preview.recentActivity?.type === 'canvas'
    ? t('A drawing was shared')
    : preview.recentActivity?.type === 'image'
      ? t('An image was shared')
      : preview.recentActivity
        ? t('The conversation is active')
        : t('Be the first to add something');
  return (
    <div className="invite-context">
      <div className="invite-context-copy">
        <small>{preview.hostedBy ? t('Hosted by {name}', { name: preview.hostedBy }) : t('You were invited to')}</small>
        <strong>{preview.name}</strong>
      </div>
      <div className="invite-context-meta">
        <div className="invite-participants" aria-label={t('{count} people in this room', { count: preview.participantCount })}>
          {preview.participants.slice(0, 4).map((participant, index) => <span key={`${participant.displayName}-${index}`} className="avatar" style={participant.avatarColor ? { '--avatar': participant.avatarColor } as CSSProperties : avatarStyle(participant.displayName)}>{participant.displayName.slice(0, 1)}</span>)}
          {preview.participantCount > 4 && <b>+{preview.participantCount - 4}</b>}
        </div>
        <p className="invite-participant-names">{preview.participants.slice(0, 3).map((participant) => participant.displayName).join(', ')}{preview.participantCount > 3 ? t(' and {count} others', { count: preview.participantCount - 3 }) : ''}</p>
        {preview.participantCount > 3 ? <details className="invite-participant-disclosure"><summary>{t('See who is here')}</summary><p>{preview.participants.map((participant) => participant.displayName).join(', ')}{preview.participantCount > preview.participants.length ? t(' and {count} more', { count: preview.participantCount - preview.participants.length }) : ''}</p></details> : null}
        <span><i /> {activity}{preview.recentActivity ? ` · ${timeLabel(preview.recentActivity.createdAt, locale)}` : ''}</span>
      </div>
    </div>
  );
}

function GuestRecoveryPanel({ recovery, hasDrawing, onKeepDrawing }: {
  recovery: GuestRecovery;
  hasDrawing: boolean;
  onKeepDrawing?: () => void;
}) {
  const { t } = useLanguage();
  const [copied, setCopied] = useState(false);

  const copySupportCode = async () => {
    if (!recovery.requestId) return;
    try {
      await navigator.clipboard.writeText(recovery.requestId);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <section className="guest-recovery" aria-labelledby="guest-recovery-title">
      <div>
        <strong id="guest-recovery-title" role="alert">{recovery.message}</strong>
        <p>{hasDrawing
          ? t('Your name and first mark are still here. Nothing has been discarded.')
          : t('Your name and invitation are still here. Nothing has been discarded.')}</p>
      </div>
      {recovery.requestId ? <div className="support-code"><span>{t('Support Code')}</span><code>{recovery.requestId}</code><button type="button" onClick={() => void copySupportCode()}>{copied ? t('Copied') : t('Copy')}</button></div> : null}
      {hasDrawing && onKeepDrawing ? <button type="button" className="keep-drawing-button" onClick={onKeepDrawing}>{t('Keep Drawing')}</button> : null}
    </section>
  );
}

export default function NetApp({ initialUser, initialApiToken, signInPath, signOutPath }: { initialUser: InitialUser; initialApiToken: string | null; signInPath: string; signOutPath: string }) {
  const { locale, t } = useLanguage();
  const [phase, setPhase] = useState<Phase>('loading');
  const [actor, setActor] = useState<ActorView | null>(initialUser ? { kind: 'user', id: initialUser.id, displayName: initialUser.displayName, email: initialUser.email } : null);
  const [guestSession, setGuestSession] = useState<string | null>(() => typeof window === 'undefined' || initialUser ? null : sessionStorage.getItem('net_guest_session'));
  const [rooms, setRooms] = useState<RoomView[]>([]);
  const [activeRoomId, setActiveRoomId] = useState<string | null>(null);
  const [messages, setMessages] = useState<MessageView[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [messageSearchResults, setMessageSearchResults] = useState<MessageView[]>([]);
  const [messageSearchTotal, setMessageSearchTotal] = useState(0);
  const [messageSearchLoading, setMessageSearchLoading] = useState(false);
  const [roomQuery, setRoomQuery] = useState('');
  const [messageQuery, setMessageQuery] = useState('');
  const [draft, setDraft] = useState('');
  const [replyTo, setReplyTo] = useState<MessageView | null>(null);
  const [guestModal, setGuestModal] = useState(false);
  const [guestEndConfirmOpen, setGuestEndConfirmOpen] = useState(false);
  const [guestName, setGuestName] = useState('');
  const [guestIntroduction, setGuestIntroduction] = useState('');
  const [guestFormError, setGuestFormError] = useState('');
  const [guestErrorField, setGuestErrorField] = useState<'name' | 'form' | null>(null);
  const [guestRecovery, setGuestRecovery] = useState<GuestRecovery | null>(null);
  const [inviteCode, setInviteCode] = useState(() => typeof window === 'undefined' ? '' : new URLSearchParams(window.location.search).get('room') ?? '');
  const [inviteStatus, setInviteStatus] = useState<InviteStatus>(() => typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('room') ? 'checking' : 'none');
  const [invitePreview, setInvitePreview] = useState<InvitePreview | null>(null);
  const [guestRequest, setGuestRequest] = useState<ActiveGuestRequest | null>(null);
  const [guestRequestBusy, setGuestRequestBusy] = useState(false);
  const [createRoomOpen, setCreateRoomOpen] = useState(false);
  const [roomName, setRoomName] = useState('');
  const [contactQuery, setContactQuery] = useState('');
  const [contactResults, setContactResults] = useState<UserSummary[]>([]);
  const [contactSearching, setContactSearching] = useState(false);
  const [conversationStartError, setConversationStartError] = useState('');
  const [selectedContacts, setSelectedContacts] = useState<UserSummary[]>([]);
  const [allowGuests, setAllowGuests] = useState(true);
  const [infoOpen, setInfoOpen] = useState(false);
  const [mobileHeaderMenuOpen, setMobileHeaderMenuOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [studio, setStudio] = useState<{ sourceUrl?: string | null; parentId?: string | null; version?: number | null; draftSource?: boolean; sourceKind?: 'photo' | 'drawing' | 'draft'; sourceAuthor?: string | null } | null>(null);
  const [pendingLandingSketch, setPendingLandingSketch] = useState<string | null>(() => {
    if (typeof window === 'undefined') return null;
    try {
      return sessionStorage.getItem('net_pending_landing_sketch');
    } catch {
      return null;
    }
  });
  const [viewingMedia, setViewingMedia] = useState<MessageView | null>(null);
  const [photoDraft, setPhotoDraft] = useState<{ file: File; url: string; rotation: 0 | 90 | 180 | 270; crop: PhotoCrop; prompt: string; description: string; purpose: 'creative' | 'reference'; replyToId: string | null } | null>(null);
  const [photoStep, setPhotoStep] = useState<1 | 2>(1);
  const [lineageViewer, setLineageViewer] = useState<{ messageId: string; lineage: CanvasLineageItem[]; loading: boolean; error: string; truncated: boolean; canDecide: boolean; decisionOwners: Array<{ id: string; displayName: string }> } | null>(null);
  const [downloadingAssetKey, setDownloadingAssetKey] = useState<string | null>(null);
  const [paletteColors, setPaletteColors] = useState<PaletteColorView[]>([]);
  const [paletteLoading, setPaletteLoading] = useState(false);
  const [paletteMutating, setPaletteMutating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [installPrompt, setInstallPrompt] = useState<InstallPromptEvent | null>(null);
  const [realtimeConnected, setRealtimeConnected] = useState(false);
  const [networkOnline, setNetworkOnline] = useState(() => typeof navigator === 'undefined' ? true : navigator.onLine);
  const [pendingMessages, setPendingMessages] = useState<PendingMessage[]>([]);
  const [outboxReady, setOutboxReady] = useState(false);
  const [outboxRetrying, setOutboxRetrying] = useState(false);
  const [outboxPersistenceFailed, setOutboxPersistenceFailed] = useState(false);
  const [outboxExpanded, setOutboxExpanded] = useState(false);
  const [pageVisible, setPageVisible] = useState(() => typeof document === 'undefined' || document.visibilityState === 'visible');
  const [conversationAtBottom, setConversationAtBottom] = useState(false);
  const [viewingLatest, setViewingLatest] = useState(true);
  const [firstUnreadSequence, setFirstUnreadSequence] = useState<number | null>(null);
  const [historyAnnouncement, setHistoryAnnouncement] = useState('');
  const [roomPeople, setRoomPeople] = useState<RoomPeopleView | null>(null);
  const [roomPeopleLoading, setRoomPeopleLoading] = useState(false);
  const [peopleSafetyOpen, setPeopleSafetyOpen] = useState(false);
  const [peopleSafetySection, setPeopleSafetySection] = useState<'people' | 'requests' | 'access' | 'safety'>('people');
  const [guestRequests, setGuestRequests] = useState<GuestRequestView[]>([]);
  const [guestRequestsLoading, setGuestRequestsLoading] = useState(false);
  const [guestRequestActionId, setGuestRequestActionId] = useState<string | null>(null);
  const [highlightedGuestRequestId, setHighlightedGuestRequestId] = useState<string | null>(null);
  const [requestClock, setRequestClock] = useState(() => Date.now());
  const [decliningGuestRequest, setDecliningGuestRequest] = useState<GuestRequestView | null>(null);
  const [declineReason, setDeclineReason] = useState('');
  const [governanceConfirmation, setGovernanceConfirmation] = useState<GovernanceConfirmation | null>(null);
  const [reportTarget, setReportTarget] = useState<RoomPersonView | null>(null);
  const [reportMessage, setReportMessage] = useState<MessageView | null>(null);
  const [reportOpen, setReportOpen] = useState(false);
  const [reportReason, setReportReason] = useState('harassment');
  const [reportDetails, setReportDetails] = useState('');
  const [editingMessage, setEditingMessage] = useState<MessageView | null>(null);
  const [editingText, setEditingText] = useState('');
  const [deletingMessage, setDeletingMessage] = useState<MessageView | null>(null);
  const [safetyAction, setSafetyAction] = useState<{ kind: 'remove' | 'block' | 'leave'; person?: RoomPersonView } | null>(null);
  const [deleteRoomConfirmOpen, setDeleteRoomConfirmOpen] = useState(false);
  const [undoMessage, setUndoMessage] = useState<{ messageId: string; roomId: string; expiresAt: number } | null>(null);
  const [pendingPreview, setPendingPreview] = useState<{ message: PendingMessage; url: string; revoke: boolean } | null>(null);
  const [pendingRemoval, setPendingRemoval] = useState<PendingMessage | null>(null);
  const [revealedBlockedMessages, setRevealedBlockedMessages] = useState<Set<string>>(() => new Set());
  const [replacePendingId, setReplacePendingId] = useState<string | null>(null);
  const [bootstrapRetry, setBootstrapRetry] = useState(0);
  const [apiToken, setApiToken] = useState(initialApiToken);
  const fileRef = useRef<HTMLInputElement>(null);
  const replaceFileRef = useRef<HTMLInputElement>(null);
  const guestNameRef = useRef<HTMLInputElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const messageScrollRef = useRef<HTMLElement>(null);
  const messagesRef = useRef<MessageView[]>([]);
  const conversationAtBottomRef = useRef(false);
  const messageInputRef = useRef<HTMLTextAreaElement>(null);
  const mobileHeaderMenuTriggerRef = useRef<HTMLButtonElement>(null);
  const mobileHeaderActionsRef = useRef<HTMLDivElement>(null);
  const joinedInvite = useRef(false);
  const activeRoomRef = useRef<string | null>(null);
  const latestMessageRequestGeneration = useRef(0);
  const historyMessageRequestGeneration = useRef(0);
  const paginationInitializedRoomRef = useRef<string | null>(null);
  const messageSearchGeneration = useRef(0);
  const paletteRequestGeneration = useRef(0);
  const paletteMutationGeneration = useRef(0);
  const contactSearchGeneration = useRef(0);
  const paletteMutationActiveRef = useRef(false);
  const paletteAbortRef = useRef<AbortController | null>(null);
  const actorIdRef = useRef<string | null>(null);
  const readMarkers = useRef(new Map<string, string>());
  const socketRef = useRef<Socket | null>(null);
  const nativeSocketRef = useRef<WebSocket | null>(null);
  const endingGuestRef = useRef(false);
  const assetRefreshes = useRef(new Map<string, Promise<string | null>>());
  const automaticAssetRefreshAttempts = useRef(new Map<string, number>());
  const lineageRequestGeneration = useRef(0);
  const continuationGeneration = useRef(0);
  const guestBootstrapSessionRef = useRef<string | null>(null);
  const pendingLandingSketchRef = useRef(pendingLandingSketch);
  const skipNextOutboxPersistenceRef = useRef(false);
  const outboxStoragePrefixRef = useRef<string | null>(null);
  const peopleSafetyOpenRef = useRef(peopleSafetyOpen);
  const roomCanManageRef = useRef(Boolean(roomPeople?.canManage));
  const guestRequestHighlightByRoomRef = useRef(new Map<string, string>());

  peopleSafetyOpenRef.current = peopleSafetyOpen;
  roomCanManageRef.current = Boolean(roomPeople?.canManage);

  const activeRoom = rooms.find((room) => room.id === activeRoomId) ?? null;
  const activeRoomUnreadCount = activeRoom?.unreadCount ?? 0;
  const activeRoomFirstUnreadSequence = activeRoom?.firstUnreadSequence ?? null;
  const actorId = actor?.id ?? null;
  const normalizedMessageQuery = messageQuery.trim().toLocaleLowerCase(localeTag(locale));
  const outboxStoragePrefix = actor ? `net_message_outbox:v3:${actor.kind}:${actor.id}:` : null;
  const activePendingMessages = activeRoomId ? pendingMessages.filter((message) => message.roomId === activeRoomId) : [];

  useEffect(() => { messagesRef.current = messages; }, [messages]);

  useEffect(() => () => {
    if (pendingPreview?.revoke) URL.revokeObjectURL(pendingPreview.url);
  }, [pendingPreview]);

  const api = useCallback(async <T,>(path: string, init: RequestInit = {}, sessionOverride?: string | null): Promise<T> => {
    const requestUrl = API_REQUEST_ORIGIN ? `${API_REQUEST_ORIGIN}${path}` : path;
    const session = sessionOverride === undefined ? guestSession : sessionOverride;
    const headers = new Headers(init.headers);
    headers.set('accept-language', localeTag(locale));
    if (session) headers.set('x-net-guest-session', session);
    else if (apiToken) headers.set('authorization', `Bearer ${apiToken}`);
    if (init.body && typeof init.body === 'string' && !headers.has('content-type')) headers.set('content-type', 'application/json');
    let response = await fetch(requestUrl, { ...init, headers });
    if (response.status === 401 && !session && initialUser) {
      const refreshed = await fetch('/auth/api-token', { method: 'POST' });
      if (refreshed.ok) {
        const credentials = await refreshed.json() as { token: string };
        setApiToken(credentials.token);
        headers.set('authorization', `Bearer ${credentials.token}`);
        response = await fetch(requestUrl, { ...init, headers });
      }
    }
    const data = await response.json().catch(() => ({})) as T & { error?: string; requestId?: string };
    if (!response.ok) {
      const message = data.error ?? 'We could not complete that request. Please try again.';
      throw new ApiRequestError(response.status, translateApiMessage(locale, message), data.requestId ?? response.headers.get('x-request-id'));
    }
    return data;
  }, [apiToken, guestSession, initialUser, locale]);

  const clearGuestSession = useCallback((message: string) => {
    const storedGuest = sessionStorage.getItem('net_guest_session');
    if (storedGuest) {
      void deleteStudioDraftsForPrefix(`guest:${storedGuest}:`).catch(() => undefined);
      void clearStoredGuestOutbox(storedGuest);
    }
    sessionStorage.removeItem('net_guest_session');
    latestMessageRequestGeneration.current += 1;
    historyMessageRequestGeneration.current += 1;
    messageSearchGeneration.current += 1;
    paletteRequestGeneration.current += 1;
    paletteMutationGeneration.current += 1;
    paletteMutationActiveRef.current = false;
    paletteAbortRef.current?.abort();
    paletteAbortRef.current = null;
    actorIdRef.current = null;
    setPaletteMutating(false);
    activeRoomRef.current = null;
    continuationGeneration.current += 1;
    paginationInitializedRoomRef.current = null;
    setGuestSession(null); setActor(null); setRooms([]); setMessages([]); setNextCursor(null); setPaletteColors([]); setPendingMessages([]);
    setActiveRoomId(null); setReplyTo(null); setViewingMedia(null); setLineageViewer(null); setPhase('landing'); setSidebarOpen(false); setInfoOpen(false);
    setError(message);
  }, []);

  const selectRoom = useCallback((roomId: string) => {
    latestMessageRequestGeneration.current += 1;
    historyMessageRequestGeneration.current += 1;
    messageSearchGeneration.current += 1;
    activeRoomRef.current = roomId;
    paginationInitializedRoomRef.current = null;
    messagesRef.current = [];
    setActiveRoomId(roomId); setMessages([]); setNextCursor(null); setReplyTo(null);
    setMessageSearchResults([]); setMessageSearchTotal(0); setMessageSearchLoading(false);
    conversationAtBottomRef.current = false;
    lineageRequestGeneration.current += 1;
    continuationGeneration.current += 1;
    setSidebarOpen(false); setInfoOpen(false); setPeopleSafetyOpen(false); setRoomPeople(null); setViewingMedia(null); setLineageViewer(null); setMessageQuery(''); setConversationAtBottom(false); setViewingLatest(true); setFirstUnreadSequence(null);
    setMobileHeaderMenuOpen(false);
  }, []);

  const consumeInvite = useCallback(() => {
    joinedInvite.current = false;
    setInviteCode('');
    setInviteStatus('none');
    setInvitePreview(null);
    window.history.replaceState(null, '', '/');
  }, []);

  const loadBootstrap = useCallback(async (sessionOverride?: string | null) => {
    const data = await api<{ actor: ActorView | null; rooms: RoomView[] }>('/api/bootstrap', {}, sessionOverride);
    setActor(data.actor);
    setRooms(data.rooms);
    if (data.actor) {
      setPhase('app');
      const current = activeRoomRef.current;
      const next = current && data.rooms.some((room) => room.id === current) ? current : data.rooms[0]?.id ?? null;
      if (current !== next) {
        latestMessageRequestGeneration.current += 1;
        historyMessageRequestGeneration.current += 1;
        messageSearchGeneration.current += 1;
        setMessages([]); setNextCursor(null); setReplyTo(null); setMessageSearchResults([]); setMessageSearchTotal(0);
        paginationInitializedRoomRef.current = null;
      }
      activeRoomRef.current = next;
      setActiveRoomId(next);
    } else {
      activeRoomRef.current = null;
      setPhase('landing');
    }
    return data;
  }, [api]);

  useEffect(() => {
    pendingLandingSketchRef.current = pendingLandingSketch;
    try {
      if (pendingLandingSketch) sessionStorage.setItem('net_pending_landing_sketch', pendingLandingSketch);
      else sessionStorage.removeItem('net_pending_landing_sketch');
    } catch {
      // The in-memory draft still survives while this tab remains open.
    }
  }, [pendingLandingSketch]);

  useEffect(() => {
    const queryInvite = inviteCode;
    const savedGuest = guestSession;
    const boot = window.setTimeout(() => {
      loadBootstrap(savedGuest).then(async (data) => {
        if (queryInvite && data.actor?.kind === 'user') {
          const invitedRoom = data.rooms.find((room) => room.inviteCode === queryInvite);
          if (invitedRoom) {
            selectRoom(invitedRoom.id);
            consumeInvite();
            return;
          }
          if (joinedInvite.current) return;
          joinedInvite.current = true;
          setPhase('loading');
          try {
            const joined = await api<{ roomId: string }>('/api/rooms/join', { method: 'POST', body: JSON.stringify({ inviteCode: queryInvite }) }, null);
            await loadBootstrap(null);
            selectRoom(joined.roomId);
            consumeInvite();
            setNotice(t('Opened the conversation from your invite link.'));
          } catch (joinError) {
            joinedInvite.current = false;
            setPhase('app');
            setError(joinError instanceof Error ? joinError.message : t('This invite link is invalid.'));
          }
        } else if (queryInvite && data.actor?.kind === 'guest') {
          const invitedRoom = data.rooms.find((room) => room.inviteCode === queryInvite);
          if (invitedRoom) {
            selectRoom(invitedRoom.id);
            consumeInvite();
          } else {
            setError(t('You are already in another guest session. End it before opening a new invite.'));
          }
        } else if (queryInvite && !data.actor) {
          setPhase('loading');
          setInviteStatus('checking');
          try {
            const invitation = await api<{ valid: true; guestAllowed: boolean; guestAdmissionPolicy: 'off' | 'approval' | 'link'; room?: InvitePreview }>(`/api/invites/${encodeURIComponent(queryInvite)}`, {}, null);
            setInvitePreview(invitation.room ?? null);
            const nextInviteStatus = !invitation.guestAllowed || invitation.guestAdmissionPolicy === 'off'
              ? 'auth-only'
              : invitation.guestAdmissionPolicy === 'approval' ? 'approval' : 'guest';
            setInviteStatus(nextInviteStatus);
            if (nextInviteStatus === 'approval') {
              const storedRequest = readStoredGuestRequest(queryInvite);
              if (storedRequest) {
                try {
                  const status = await api<GuestRequestStatusView>(`/api/guest-requests/${encodeURIComponent(storedRequest.id)}/status`, { headers: { 'x-net-guest-request': storedRequest.requestToken } }, null);
                  setGuestName(status.displayName);
                  setGuestIntroduction(status.introduction ?? '');
                  setGuestRequest({ ...status, requestToken: storedRequest.requestToken });
                } catch (requestError) {
                  if (requestError instanceof ApiRequestError && requestError.status === 404) localStorage.removeItem(guestRequestStorageKey(queryInvite));
                }
              }
            }
          } catch (inviteError) {
            setInvitePreview(null);
            setInviteStatus(inviteError instanceof ApiRequestError && [400, 404].includes(inviteError.status) ? 'invalid' : 'unavailable');
          }
          setPhase('landing');
        }
        if (savedGuest && data.actor?.kind === 'guest' && pendingLandingSketchRef.current) {
          setStudio({ sourceUrl: pendingLandingSketchRef.current, draftSource: true });
          pendingLandingSketchRef.current = null;
          setPendingLandingSketch(null);
        }
      }).catch((bootstrapError) => {
        if (endingGuestRef.current) return;
        if (bootstrapError instanceof ApiRequestError && bootstrapError.status === 401 && savedGuest) {
          clearGuestSession(t('Your guest session expired. You no longer have access; messages and attached images remain in the room.'));
          return;
        }
        const hasActiveIdentity = Boolean(savedGuest || initialUser);
        setError(hasActiveIdentity
          ? navigator.onLine
            ? t('Nét cannot connect right now. Your session is safe; try again in a moment.')
            : t('You are offline. Your session is safe and will recover when the connection returns.')
          : navigator.onLine
            ? t('We could not load Nét. Try again in a moment.')
            : t('You are offline. Check your connection and try again.'));
        setPhase(hasActiveIdentity ? 'loading' : 'landing');
      });
    }, 0);
    const onInstall = (event: Event) => { event.preventDefault(); setInstallPrompt(event as InstallPromptEvent); };
    window.addEventListener('beforeinstallprompt', onInstall);
    return () => { window.clearTimeout(boot); window.removeEventListener('beforeinstallprompt', onInstall); };
  }, [api, bootstrapRetry, clearGuestSession, consumeInvite, guestSession, initialUser, inviteCode, loadBootstrap, selectRoom, t]);

  useEffect(() => {
    if (!initialUser) return;
    const storedGuest = sessionStorage.getItem('net_guest_session');
    if (storedGuest) void clearStoredGuestOutbox(storedGuest);
    sessionStorage.removeItem('net_guest_session');
  }, [initialUser]);

  useEffect(() => {
    skipNextOutboxPersistenceRef.current = true;
    outboxStoragePrefixRef.current = outboxStoragePrefix;
    const frame = window.requestAnimationFrame(() => {
      setOutboxReady(false);
      setOutboxPersistenceFailed(false);
      if (!outboxStoragePrefix) {
        setPendingMessages([]);
        setOutboxReady(true);
        return;
      }
      try {
        const recovered = readStoredOutbox(outboxStoragePrefix);
        for (const message of recovered.messages) localStorage.setItem(`${outboxStoragePrefix}${message.id}`, serializePendingMessage(message));
        localStorage.removeItem(recovered.legacyKey);
        setPendingMessages(recovered.messages);
      } catch {
        setPendingMessages([]);
        setOutboxPersistenceFailed(true);
      }
      setOutboxReady(true);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [outboxStoragePrefix]);

  useEffect(() => {
    if (!outboxStoragePrefix || !outboxReady) return;
    if (skipNextOutboxPersistenceRef.current) {
      skipNextOutboxPersistenceRef.current = false;
      return;
    }
    let persistenceFailed = false;
    try {
      for (const message of pendingMessages) localStorage.setItem(`${outboxStoragePrefix}${message.id}`, serializePendingMessage(message));
    } catch {
      persistenceFailed = true;
    }
    const frame = window.requestAnimationFrame(() => setOutboxPersistenceFailed(persistenceFailed));
    return () => window.cancelAnimationFrame(frame);
  }, [outboxReady, outboxStoragePrefix, pendingMessages]);

  useEffect(() => {
    if (!outboxStoragePrefix) return;
    const synchronizeOutbox = (event: StorageEvent) => {
      if (!event.key?.startsWith(outboxStoragePrefix)) return;
      try {
        setPendingMessages(readStoredOutbox(outboxStoragePrefix).messages);
        setOutboxPersistenceFailed(false);
      } catch {
        setOutboxPersistenceFailed(true);
      }
    };
    window.addEventListener('storage', synchronizeOutbox);
    return () => window.removeEventListener('storage', synchronizeOutbox);
  }, [outboxStoragePrefix]);

  useEffect(() => {
    if ('serviceWorker' in navigator) void navigator.serviceWorker.register('/sw.js');
  }, []);

  useEffect(() => {
    if (!mobileHeaderMenuOpen) return;
    const frame = window.requestAnimationFrame(() => mobileHeaderActionsRef.current?.querySelector<HTMLButtonElement>('button')?.focus());
    const dismissFromOutside = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node) || mobileHeaderActionsRef.current?.contains(target) || mobileHeaderMenuTriggerRef.current?.contains(target)) return;
      setMobileHeaderMenuOpen(false);
    };
    const dismissFromKeyboard = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      setMobileHeaderMenuOpen(false);
      mobileHeaderMenuTriggerRef.current?.focus();
    };
    document.addEventListener('pointerdown', dismissFromOutside);
    document.addEventListener('keydown', dismissFromKeyboard);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener('pointerdown', dismissFromOutside);
      document.removeEventListener('keydown', dismissFromKeyboard);
    };
  }, [mobileHeaderMenuOpen]);

  useEffect(() => {
    const onOffline = () => setNetworkOnline(false);
    const onOnline = () => {
      setNetworkOnline(true);
      setBootstrapRetry((current) => current + 1);
      const socket = socketRef.current;
      if (socket && !socket.connected && !endingGuestRef.current) socket.connect();
    };
    window.addEventListener('offline', onOffline);
    window.addEventListener('online', onOnline);
    return () => {
      window.removeEventListener('offline', onOffline);
      window.removeEventListener('online', onOnline);
    };
  }, []);

  useEffect(() => {
    actorIdRef.current = actorId;
  }, [actorId]);

  useEffect(() => {
    if (actor?.kind !== 'guest') return;
    let lastTouch = 0;
    const touch = (event: Event) => {
      if (endingGuestRef.current) return;
      const target = event.target;
      if (target instanceof Element && target.closest('[data-end-guest="true"]')) return;
      const now = Date.now();
      if (now - lastTouch < 5 * 60 * 1000) return;
      lastTouch = now;
      void api('/api/guest/activity', { method: 'POST' }).catch((activityError) => {
        if (endingGuestRef.current) return;
        if (activityError instanceof ApiRequestError && activityError.status === 401 && sessionStorage.getItem('net_guest_session')) {
          clearGuestSession(t('Your guest session expired. You no longer have access; messages and attached images remain in the room.'));
        }
      });
    };
    window.addEventListener('pointerdown', touch, { passive: true });
    window.addEventListener('keydown', touch);
    return () => { window.removeEventListener('pointerdown', touch); window.removeEventListener('keydown', touch); };
  }, [actor?.kind, api, clearGuestSession, t]);

  const loadMessages = useCallback(async (roomId: string, quiet = false, before?: string, from?: number | null) => {
    const requestGeneration = before ? historyMessageRequestGeneration : latestMessageRequestGeneration;
    const generation = ++requestGeneration.current;
    const followLatest = quiet && !before && conversationAtBottomRef.current;
    try {
      const cursor = before
        ? `?before=${encodeURIComponent(before)}`
        : from
          ? `?from=${encodeURIComponent(String(from))}&limit=100`
          : quiet ? '?limit=100' : '';
      const data = await api<{ messages: MessageView[]; nextCursor: string | null; hasMoreAfter?: boolean }>(`/api/rooms/${roomId}/messages${cursor}`);
      if (activeRoomRef.current !== roomId || generation !== requestGeneration.current) return;
      if (!quiet || paginationInitializedRoomRef.current !== roomId) {
        setNextCursor(data.nextCursor);
        paginationInitializedRoomRef.current = roomId;
      }
      if (before) {
        setMessages((current) => {
          const merged = new Map(current.map((message) => [message.id, message]));
          for (const message of data.messages) merged.set(message.id, message);
          return [...merged.values()].sort((left, right) => left.sequence - right.sequence);
        });
      } else if (quiet) {
        const previousNewest = messagesRef.current[messagesRef.current.length - 1]?.sequence ?? 0;
        const newIncoming = data.messages.filter((message) => message.sequence > previousNewest && (actor?.kind === 'user' ? message.senderId !== actor.id : message.guestSessionId !== actor?.id) && message.type !== 'system');
        if (newIncoming.length) setHistoryAnnouncement(t('{count} new messages arrived.', { count: newIncoming.length }));
        setMessages((current) => {
          if (!data.messages.length) return [];
          const ids = new Set(data.messages.map((message) => message.id));
          const oldest = data.messages[0];
          const currentById = new Map(current.map((message) => [message.id, message]));
          const unchanged = data.messages.every((message) => {
            const existing = currentById.get(message.id);
            return existing ? sameMessage(existing, message) : false;
          }) && current.every((message) => message.sequence < oldest.sequence || ids.has(message.id));
          if (unchanged) return current;
          const retained = current.filter((message) => message.sequence < oldest.sequence || ids.has(message.id));
          const merged = new Map(retained.map((message) => [message.id, message]));
          for (const message of data.messages) merged.set(message.id, message);
          return [...merged.values()].sort((left, right) => left.sequence - right.sequence);
        });
      } else setMessages(data.messages);
      if (!quiet && !before) {
        setViewingLatest(!data.hasMoreAfter);
        setFirstUnreadSequence(from ?? null);
      }
      if ((!quiet && !before) || followLatest) requestAnimationFrame(() => {
        const unread = from ? document.getElementById(`message-${data.messages.find((message) => message.sequence >= from)?.id ?? ''}`) : null;
        if (unread) unread.scrollIntoView({ block: 'center' });
        else endRef.current?.scrollIntoView({ block: 'end' });
        const scrollContainer = messageScrollRef.current;
        if (!scrollContainer) return;
        const distance = scrollContainer.scrollHeight - scrollContainer.scrollTop - scrollContainer.clientHeight;
        const atBottom = distance <= 72;
        conversationAtBottomRef.current = atBottom;
        setConversationAtBottom(atBottom);
      });
    } catch (loadError) {
      if (endingGuestRef.current) return;
      if (loadError instanceof ApiRequestError && loadError.status === 401 && guestSession) {
        clearGuestSession(t('Your guest session expired. You no longer have access; messages and attached images remain in the room.'));
        return;
      }
      if (!quiet) setError(loadError instanceof Error ? loadError.message : t('Messages could not be loaded. Try again.'));
    }
  }, [actor?.id, actor?.kind, api, clearGuestSession, guestSession, t]);

  useEffect(() => {
    const scrollContainer = messageScrollRef.current;
    const end = endRef.current;
    if (!scrollContainer || !end || phase !== 'app') return;
    const updateFromScroll = () => {
      const distance = scrollContainer.scrollHeight - scrollContainer.scrollTop - scrollContainer.clientHeight;
      const atBottom = distance <= 72;
      conversationAtBottomRef.current = atBottom;
      setConversationAtBottom(atBottom);
    };
    const observer = new IntersectionObserver(
      ([entry]) => {
        conversationAtBottomRef.current = entry.isIntersecting;
        setConversationAtBottom(entry.isIntersecting);
      },
      { root: scrollContainer, threshold: 0.9 },
    );
    observer.observe(end);
    scrollContainer.addEventListener('scroll', updateFromScroll, { passive: true });
    updateFromScroll();
    return () => {
      observer.disconnect();
      scrollContainer.removeEventListener('scroll', updateFromScroll);
    };
  }, [activeRoomId, phase]);

  useEffect(() => {
    const onVisibility = () => setPageVisible(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  useEffect(() => {
    if (!activeRoomId || !pageVisible || normalizedMessageQuery || infoOpen || studio || !messages.length || !viewingLatest) return;
    const scrollContainer = messageScrollRef.current;
    const distanceFromBottom = scrollContainer
      ? scrollContainer.scrollHeight - scrollContainer.scrollTop - scrollContainer.clientHeight
      : Number.POSITIVE_INFINITY;
    if (!conversationAtBottom && distanceFromBottom > 72) return;
    const newest = messages[messages.length - 1];
    if (!newest || newest.id === readMarkers.current.get(activeRoomId)) return;
    readMarkers.current.set(activeRoomId, newest.id);
    void api(`/api/rooms/${activeRoomId}/messages`, { method: 'PATCH', body: JSON.stringify({ messageId: newest.id }) })
      .then(() => {
        setRooms((current) => current.map((room) => room.id === activeRoomId ? { ...room, unreadCount: 0, firstUnreadSequence: null, lastReadSequence: newest.sequence } : room));
        setFirstUnreadSequence(null);
      })
      .catch((readError) => {
        readMarkers.current.delete(activeRoomId);
        if (endingGuestRef.current) return;
        if (readError instanceof ApiRequestError && readError.status === 401 && guestSession) {
          clearGuestSession(t('Your guest session expired. You no longer have access; messages and attached images remain in the room.'));
        }
      });
  }, [activeRoomId, api, clearGuestSession, conversationAtBottom, guestSession, infoOpen, messages, normalizedMessageQuery, pageVisible, studio, t, viewingLatest]);

  useEffect(() => {
    const websocketUrl = process.env.NEXT_PUBLIC_WEBSOCKET_URL;
    if (!websocketUrl || !actorId || !activeRoomId || phase !== 'app' || !networkOnline) return;
    let disposed = false;
    let reconnectTimer: number | null = null;
    let reconnectDelay = 1_000;

    const connect = async () => {
      try {
        const credentials = await api<{ token: string }>('/api/realtime/token', {
          method: 'POST',
          body: JSON.stringify({ roomId: activeRoomId }),
        });
        if (disposed || endingGuestRef.current) return;
        const socket = new WebSocket(websocketUrl);
        nativeSocketRef.current = socket;
        socket.addEventListener('open', () => {
          socket.send(JSON.stringify({ type: 'authenticate', token: credentials.token }));
        });
        socket.addEventListener('message', (event) => {
          let frame: { type?: string; event?: string; roomId?: string; payload?: { roomId?: string; requestId?: string; guestSessionId?: string; retained?: boolean } };
          try {
            frame = JSON.parse(String(event.data)) as typeof frame;
          } catch {
            return;
          }
          if (frame.type === 'ready') {
            if (frame.roomId !== activeRoomRef.current) {
              socket.close(4403, 'Wrong room.');
              return;
            }
            reconnectDelay = 1_000;
            setRealtimeConnected(true);
            void loadBootstrap();
            void loadMessages(activeRoomId, true);
            return;
          }
          if (frame.type !== 'event' || !frame.payload?.roomId) return;
          if (frame.event === 'guest.requested' || frame.event === 'guest.request.updated') {
            if (frame.payload.requestId) guestRequestHighlightByRoomRef.current.set(frame.payload.roomId, frame.payload.requestId);
            void loadBootstrap();
            const currentRoom = activeRoomRef.current;
            if (frame.payload.roomId === currentRoom && currentRoom && peopleSafetyOpenRef.current && roomCanManageRef.current) {
              void api<{ requests: GuestRequestView[] }>(`/api/rooms/${currentRoom}/guest-requests`)
                .then((data) => {
                  setGuestRequests(data.requests);
                  if (frame.payload?.requestId) setHighlightedGuestRequestId(frame.payload.requestId);
                })
                .catch(() => undefined);
            }
            return;
          }
          if (frame.payload.roomId !== activeRoomRef.current) return;
          if (frame.event === 'guest.ended' && actor?.kind === 'guest' && frame.payload.guestSessionId === actorId) {
            endingGuestRef.current = true;
            clearGuestSession('');
            setNotice(frame.payload.retained
              ? t('Your guest session ended. You no longer have access; content you sent remains in the room.')
              : t('Your guest session ended. The room had no signed-in member, so temporary content was removed.'));
            socket.close(1000, 'Guest session ended.');
            return;
          }
          void loadMessages(activeRoomId, true);
          void loadBootstrap();
        });
        socket.addEventListener('close', () => {
          if (nativeSocketRef.current === socket) nativeSocketRef.current = null;
          setRealtimeConnected(false);
          if (disposed || endingGuestRef.current) return;
          reconnectTimer = window.setTimeout(() => {
            reconnectDelay = Math.min(reconnectDelay * 2, 30_000);
            void connect();
          }, reconnectDelay);
        });
        socket.addEventListener('error', () => setRealtimeConnected(false));
      } catch {
        setRealtimeConnected(false);
        if (!disposed && !endingGuestRef.current) {
          reconnectTimer = window.setTimeout(() => {
            reconnectDelay = Math.min(reconnectDelay * 2, 30_000);
            void connect();
          }, reconnectDelay);
        }
      }
    };
    void connect();
    return () => {
      disposed = true;
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      setRealtimeConnected(false);
      nativeSocketRef.current?.close(1000, 'Room changed.');
      nativeSocketRef.current = null;
    };
  }, [activeRoomId, actor?.kind, actorId, api, clearGuestSession, loadBootstrap, loadMessages, networkOnline, phase, t]);

  useEffect(() => {
    if (process.env.NEXT_PUBLIC_WEBSOCKET_URL || !actorId || !activeRoomId || phase !== 'app') return;
    let disposed = false;
    let refreshing = false;
    let lastRefresh = 0;
    const connect = async () => {
      try {
        const credentials = await api<{ token: string }>('/api/realtime/token', { method: 'POST', body: JSON.stringify({ roomId: activeRoomId }) });
        if (disposed) return;
        const realtimeEndpoint = process.env.NEXT_PUBLIC_REALTIME_URL
          ?? (process.env.NEXT_PUBLIC_API_URL
            ? `${process.env.NEXT_PUBLIC_API_URL.replace(/\/$/, '')}/chat`
            : 'http://localhost:3001/chat');
        const socket = io(realtimeEndpoint, {
          path: '/socket.io',
          transports: ['websocket'],
          auth: { token: credentials.token },
          reconnection: true,
          reconnectionDelayMax: 5000,
        });
        socketRef.current = socket;
        socket.on('connect', () => {
          if (endingGuestRef.current) {
            socket.disconnect();
            return;
          }
          const roomId = activeRoomRef.current;
          if (!roomId) {
            setRealtimeConnected(false);
            return;
          }
          socket.emit('room.subscribe', { roomId }, (ack: { ok: boolean; roomId?: string }) => {
            if (!ack?.ok || ack.roomId !== activeRoomRef.current) {
              setRealtimeConnected(false);
              return;
            }
            setRealtimeConnected(true);
            void loadBootstrap();
            void loadMessages(roomId, true);
          });
        });
        const refreshRealtimeCredentials = async () => {
          setRealtimeConnected(false);
          const now = Date.now();
          if (disposed || endingGuestRef.current || refreshing || now - lastRefresh < 5000) return;
          refreshing = true;
          lastRefresh = now;
          try {
            const next = await api<{ token: string }>('/api/realtime/token', { method: 'POST', body: JSON.stringify({ roomId: activeRoomId }) });
            socket.auth = { token: next.token };
            if (!disposed && !socket.connected) socket.connect();
          } catch {
            // The polling fallback remains active until credentials can be refreshed.
          } finally { refreshing = false; }
        };
        socket.on('disconnect', (reason) => {
          setRealtimeConnected(false);
          if (reason === 'io server disconnect') void refreshRealtimeCredentials();
        });
        socket.on('connect_error', () => void refreshRealtimeCredentials());
        const refreshActiveRoom = (payload: { roomId?: string }) => {
          const currentRoom = activeRoomRef.current;
          if (!payload?.roomId || payload.roomId !== currentRoom) return;
          void loadMessages(currentRoom, true);
        };
        const applyReadReceipt = (payload: { roomId?: string; actorKey?: string; sequence?: number }) => {
          const currentRoom = activeRoomRef.current;
          const currentActorKey = actor?.kind && actorId ? `${actor.kind}:${actorId}` : null;
          const sequence = Number(payload.sequence);
          if (!payload.roomId || payload.roomId !== currentRoom || payload.actorKey === currentActorKey || !Number.isSafeInteger(sequence)) return;
          const apply = (current: MessageView[]) => current.map((message) => {
            const ownMessage = actor?.kind === 'user' ? message.senderId === actorId : message.guestSessionId === actorId;
            return ownMessage && message.sequence <= sequence && message.readCount < 1 ? { ...message, readCount: 1 } : message;
          });
          setMessages(apply);
          setMessageSearchResults(apply);
          refreshActiveRoom(payload);
        };
        socket.on('message.created', (payload: { roomId?: string }) => {
          refreshActiveRoom(payload);
          void loadBootstrap();
        });
        socket.on('message.updated', (payload: { roomId?: string; messageId?: string; body?: string; editedAt?: number }) => {
          if (!payload?.roomId || payload.roomId !== activeRoomRef.current || !payload.messageId || typeof payload.body !== 'string' || !Number.isSafeInteger(payload.editedAt)) return;
          const applyEdit = (current: MessageView[]) => current.map((message) => message.id === payload.messageId ? { ...message, body: payload.body ?? '', editedAt: Number(payload.editedAt) } : message);
          setMessages(applyEdit);
          setMessageSearchResults(applyEdit);
          void loadBootstrap();
        });
        socket.on('message.deleted', (payload: { roomId?: string; messageId?: string; deletedAt?: number }) => {
          if (!payload?.roomId || payload.roomId !== activeRoomRef.current || !payload.messageId || !Number.isSafeInteger(payload.deletedAt)) return;
          const applyDelete = (current: MessageView[]) => current.map((message) => message.id === payload.messageId ? { ...message, body: null, assetKey: null, assetUrl: null, deletedAt: Number(payload.deletedAt), reactions: [] } : message);
          setMessages(applyDelete);
          setMessageSearchResults(applyDelete);
          setViewingMedia((current) => current?.id === payload.messageId ? null : current);
          void loadBootstrap();
        });
        socket.on('reaction.updated', (payload: { roomId?: string; messageId?: string; emoji?: string; actorKey?: string; reacted?: boolean; count?: number }) => {
          const currentRoom = activeRoomRef.current;
          if (!payload?.roomId || payload.roomId !== currentRoom || !payload.messageId || !payload.emoji || !Number.isSafeInteger(payload.count) || Number(payload.count) < 0) return;
          const currentActorKey = actor?.kind && actorId ? `${actor.kind}:${actorId}` : null;
          const applyReaction = (current: MessageView[]) => current.map((message) => {
            if (message.id !== payload.messageId) return message;
            const reactions = message.reactions.filter((reaction) => reaction.emoji !== payload.emoji);
            if (Number(payload.count) > 0) reactions.push({
              emoji: payload.emoji!,
              count: Number(payload.count),
              reacted: payload.actorKey === currentActorKey ? Boolean(payload.reacted) : message.reactions.find((reaction) => reaction.emoji === payload.emoji)?.reacted ?? false,
            });
            return { ...message, reactions };
          });
          setMessages(applyReaction);
          setMessageSearchResults(applyReaction);
          refreshActiveRoom(payload);
        });
        socket.on('messages.read', applyReadReceipt);
        socket.on('guest.ended', (payload: { roomId?: string; guestSessionId?: string; messageIds?: string[]; retained?: boolean; removedReactions?: Array<{ messageId: string; emoji: string }> }) => {
          if (actor?.kind === 'guest' && payload.guestSessionId === actorId) {
            endingGuestRef.current = true;
            clearGuestSession('');
            setNotice(payload.retained
              ? t('Your guest session ended. You no longer have access; content you sent remains in the room.')
              : t('Your guest session ended. The room had no signed-in member, so temporary content was removed.'));
            return;
          }
          if (payload.roomId === activeRoomRef.current && payload.messageIds?.length) {
            const deletedIds = new Set(payload.messageIds);
            setMessages((current) => current.filter((message) => !deletedIds.has(message.id)));
            setMessageSearchResults((current) => current.filter((message) => !deletedIds.has(message.id)));
          }
          if (payload.roomId === activeRoomRef.current && payload.removedReactions?.length) {
            const removedByMessage = new Map<string, Set<string>>();
            for (const removed of payload.removedReactions) {
              const emojis = removedByMessage.get(removed.messageId) ?? new Set<string>();
              emojis.add(removed.emoji);
              removedByMessage.set(removed.messageId, emojis);
            }
            const removeEndedGuestReactions = (current: MessageView[]) => current.map((message) => {
              const removedEmojis = removedByMessage.get(message.id);
              if (!removedEmojis) return message;
              return {
                ...message,
                reactions: message.reactions.flatMap((reaction) => {
                  if (!removedEmojis.has(reaction.emoji)) return [reaction];
                  return reaction.count > 1 ? [{ ...reaction, count: reaction.count - 1 }] : [];
                }),
              };
            });
            setMessages(removeEndedGuestReactions);
            setMessageSearchResults(removeEndedGuestReactions);
          }
          refreshActiveRoom(payload);
          void loadBootstrap();
        });
        socket.on('room.updated', (payload: { roomId?: string }) => {
          if (payload?.roomId === activeRoomRef.current) refreshActiveRoom(payload);
          void loadBootstrap();
        });
        const refreshGuestAdmission = (payload: { roomId?: string; requestId?: string }) => {
          if (payload.roomId && payload.requestId) guestRequestHighlightByRoomRef.current.set(payload.roomId, payload.requestId);
          void loadBootstrap();
          const currentRoom = activeRoomRef.current;
          if (!payload?.roomId || payload.roomId !== currentRoom || !currentRoom || !peopleSafetyOpenRef.current || !roomCanManageRef.current) return;
          void api<{ requests: GuestRequestView[] }>(`/api/rooms/${currentRoom}/guest-requests`)
            .then((data) => {
              setGuestRequests(data.requests);
              if (payload.requestId) setHighlightedGuestRequestId(payload.requestId);
            })
            .catch(() => undefined);
        };
        socket.on('guest.requested', refreshGuestAdmission);
        socket.on('guest.request.updated', refreshGuestAdmission);
        socket.on('room.activity', (payload: { roomId?: string }) => {
          if (payload?.roomId === activeRoomRef.current) refreshActiveRoom(payload);
          void loadBootstrap();
        });
      } catch {
        setRealtimeConnected(false);
      }
    };
    void connect();
    return () => {
      disposed = true;
      setRealtimeConnected(false);
      socketRef.current?.disconnect();
      socketRef.current = null;
    };
  }, [activeRoomId, actor?.kind, actorId, api, clearGuestSession, loadBootstrap, loadMessages, phase, t]);

  useEffect(() => {
    if (process.env.NEXT_PUBLIC_WEBSOCKET_URL) return;
    const socket = socketRef.current;
    if (!socket?.connected || !activeRoomId) return;
    socket.emit('room.subscribe', { roomId: activeRoomId }, (ack: { ok: boolean; roomId?: string }) => {
      if (!ack?.ok || ack.roomId !== activeRoomRef.current) setRealtimeConnected(false);
    });
    return () => { socket.emit('room.unsubscribe'); };
  }, [activeRoomId]);

  useEffect(() => {
    if (!activeRoomId || phase !== 'app') return;
    const unreadStart = activeRoomUnreadCount > 0 ? activeRoomFirstUnreadSequence : null;
    const initialLoad = window.setTimeout(() => void loadMessages(activeRoomId, false, undefined, unreadStart), 0);
    return () => window.clearTimeout(initialLoad);
  }, [activeRoomFirstUnreadSequence, activeRoomId, activeRoomUnreadCount, loadMessages, phase]);

  useEffect(() => {
    if (!activeRoomId || phase !== 'app') return;
    const poll = window.setInterval(() => void loadMessages(activeRoomId, true), realtimeConnected ? 4000 : 3000);
    return () => window.clearInterval(poll);
  }, [activeRoomId, loadMessages, phase, realtimeConnected]);

  const pendingOwnReadReceiptKey = messages.flatMap((message) => {
    const ownMessage = actor?.kind === 'user' ? message.senderId === actorId : message.guestSessionId === actorId;
    return ownMessage && message.readCount < 1 ? [message.id] : [];
  }).join(':');

  useEffect(() => {
    if (!activeRoomId || phase !== 'app' || !realtimeConnected || !pendingOwnReadReceiptKey) return;
    const timers = [600, 1400, 2600, 4200].map((delay) => window.setTimeout(() => void loadMessages(activeRoomId, true), delay));
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [activeRoomId, loadMessages, pendingOwnReadReceiptKey, phase, realtimeConnected]);

  useEffect(() => {
    if (!notice) return;
    const timeout = window.setTimeout(() => setNotice(''), 6500);
    return () => window.clearTimeout(timeout);
  }, [notice]);

  useEffect(() => {
    if (!undoMessage) return;
    const timeout = window.setTimeout(() => setUndoMessage((current) => current?.messageId === undoMessage.messageId ? null : current), Math.max(0, undoMessage.expiresAt - Date.now()));
    return () => window.clearTimeout(timeout);
  }, [undoMessage]);

  useEffect(() => {
    if (phase !== 'landing' || (!guestModal && !['guest', 'approval'].includes(inviteStatus)) || guestRequest) return;
    if (window.matchMedia('(max-width: 720px)').matches) return;
    const frame = window.requestAnimationFrame(() => guestNameRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [guestModal, guestRequest, inviteStatus, phase]);

  useEffect(() => {
    const generation = ++messageSearchGeneration.current;
    if (!activeRoomId || normalizedMessageQuery.length < 2) {
      return;
    }
    const timeout = window.setTimeout(() => {
      setMessageSearchLoading(true);
      void api<{ messages: MessageView[]; totalCount: number }>(
        `/api/rooms/${activeRoomId}/messages?q=${encodeURIComponent(normalizedMessageQuery)}&limit=100`,
      ).then((data) => {
        if (generation !== messageSearchGeneration.current || activeRoomRef.current !== activeRoomId) return;
        setMessageSearchResults(data.messages);
        setMessageSearchTotal(data.totalCount);
      }).catch((searchError) => {
        if (generation !== messageSearchGeneration.current) return;
        setError(searchError instanceof Error ? searchError.message : t('Message search failed. Try again.'));
      }).finally(() => {
        if (generation === messageSearchGeneration.current) setMessageSearchLoading(false);
      });
    }, 250);
    return () => window.clearTimeout(timeout);
  }, [activeRoomId, api, normalizedMessageQuery, t]);

  useEffect(() => {
    const generation = ++contactSearchGeneration.current;
    const query = contactQuery.trim();
    if (!createRoomOpen || actor?.kind !== 'user' || query.length < 2) {
      return;
    }
    const timeout = window.setTimeout(() => {
      void api<{ users: UserSummary[] }>(`/api/users?q=${encodeURIComponent(query)}`)
        .then((data) => {
          if (generation !== contactSearchGeneration.current) return;
          setContactResults(data.users);
          setConversationStartError('');
        })
        .catch((searchError) => {
          if (generation !== contactSearchGeneration.current) return;
          setContactResults([]);
          setConversationStartError(searchError instanceof Error ? searchError.message : t('Member search failed. Try again.'));
        })
        .finally(() => {
          if (generation === contactSearchGeneration.current) setContactSearching(false);
        });
    }, 220);
    return () => window.clearTimeout(timeout);
  }, [actor?.kind, api, contactQuery, createRoomOpen, t]);

  const startGuest = async (event: FormEvent) => {
    event.preventDefault();
    const displayName = guestName.trim();
    if (!displayName) {
      setGuestFormError(t('Enter a display name.'));
      setGuestErrorField('name');
      guestNameRef.current?.focus();
      return;
    }
    if (displayName.length < 2) {
      setGuestFormError(t('Display name must be at least 2 characters.'));
      setGuestErrorField('name');
      guestNameRef.current?.focus();
      return;
    }
    setBusy(true); setGuestFormError(''); setGuestErrorField(null); setGuestRecovery(null);
    let sessionId = guestBootstrapSessionRef.current;
    try {
      if (inviteStatus === 'approval') {
        const normalizedInviteCode = extractInviteCode(inviteCode);
        const data = await api<GuestRequestStatusView & { requestToken: string }>(`/api/invites/${encodeURIComponent(normalizedInviteCode)}/guest-requests`, {
          method: 'POST',
          body: JSON.stringify({
            displayName,
            introduction: guestIntroduction.trim() || undefined,
            requestToken: guestRequest?.requestToken,
          }),
        }, null);
        const nextRequest = { ...data, requestToken: data.requestToken };
        setGuestRequest(nextRequest);
        localStorage.setItem(guestRequestStorageKey(normalizedInviteCode), JSON.stringify({ id: data.id, requestToken: data.requestToken } satisfies StoredGuestRequest));
        setNotice(t('Request sent. The room owner can now review it.'));
        setBusy(false);
        return;
      }
      if (!sessionId) {
        const normalizedInviteCode = extractInviteCode(inviteCode);
        const data = await api<{ sessionId: string }>('/api/guest', { method: 'POST', body: JSON.stringify({ displayName, inviteCode: normalizedInviteCode || undefined }) }, null);
        sessionId = data.sessionId;
        guestBootstrapSessionRef.current = sessionId;
        sessionStorage.setItem('net_guest_session', sessionId);
        endingGuestRef.current = false;
      }
      await loadBootstrap(sessionId);
      guestBootstrapSessionRef.current = null;
      setGuestSession(sessionId);
      setGuestModal(false);
      consumeInvite();
      if (pendingLandingSketch) {
        setStudio({ sourceUrl: pendingLandingSketch, draftSource: true });
        pendingLandingSketchRef.current = null;
        setPendingLandingSketch(null);
      }
    } catch (startError) {
      const offline = !navigator.onLine;
      const requestError = startError instanceof ApiRequestError ? startError : null;
      const bootstrapSessionExpired = Boolean(sessionId && requestError?.status === 401);
      if (bootstrapSessionExpired) {
        guestBootstrapSessionRef.current = null;
        sessionStorage.removeItem('net_guest_session');
        setGuestSession(null);
      }
      const message = bootstrapSessionExpired
        ? t('That guest session expired before Nét finished connecting. Try again; your first mark is still here.')
        : sessionId
        ? offline
          ? t('You are offline. Your session is safe and will recover when the connection returns.')
          : t('Nét cannot connect right now. Your session is safe; try again in a moment.')
        : offline
          ? t('You are offline, so we could not create your guest session.')
        : requestError && requestError.status < 500
          ? requestError.message
          : t('We could not create your guest session.');
      setGuestRecovery({ message, requestId: requestError?.requestId ?? null });
      setGuestErrorField('form');
    }
    setBusy(false);
  };

  const checkGuestRequest = useCallback(async (request: ActiveGuestRequest, announce = false) => {
    try {
      const status = await api<GuestRequestStatusView>(`/api/guest-requests/${encodeURIComponent(request.id)}/status`, { headers: { 'x-net-guest-request': request.requestToken } }, null);
      setGuestRequest({ ...status, requestToken: request.requestToken });
      if (announce) setNotice(status.status === 'pending' ? t('Your request is still waiting for an owner.') : t('Your join request was updated.'));
      return status;
    } catch (requestError) {
      if (announce) setError(requestError instanceof Error ? requestError.message : t('The join request could not be checked.'));
      return null;
    }
  }, [api, t]);

  useEffect(() => {
    if (phase !== 'landing' || inviteStatus !== 'approval' || guestRequest?.status !== 'pending') return;
    const poll = window.setInterval(() => void checkGuestRequest(guestRequest), realtimeConnected ? 20_000 : 12_000);
    return () => window.clearInterval(poll);
  }, [checkGuestRequest, guestRequest, inviteStatus, phase, realtimeConnected]);

  const claimApprovedGuestRequest = async () => {
    if (!guestRequest || guestRequestBusy) return;
    setGuestRequestBusy(true); setGuestFormError('');
    try {
      const data = await api<{ sessionId: string }>(`/api/guest-requests/${encodeURIComponent(guestRequest.id)}/claim`, { method: 'POST', headers: { 'x-net-guest-request': guestRequest.requestToken } }, null);
      sessionStorage.setItem('net_guest_session', data.sessionId);
      endingGuestRef.current = false;
      await loadBootstrap(data.sessionId);
      setGuestSession(data.sessionId);
      localStorage.removeItem(guestRequestStorageKey(inviteCode));
      setGuestRequest(null);
      consumeInvite();
      if (pendingLandingSketch) {
        setStudio({ sourceUrl: pendingLandingSketch, draftSource: true, sourceKind: 'draft' });
        pendingLandingSketchRef.current = null;
        setPendingLandingSketch(null);
      }
      setNotice(t('You are in. Your 2-hour guest session starts now.'));
    } catch (claimError) {
      setGuestFormError(claimError instanceof Error ? claimError.message : t('The approved request could not be claimed.'));
    } finally {
      setGuestRequestBusy(false);
    }
  };

  const cancelActiveGuestRequest = async () => {
    if (!guestRequest || guestRequestBusy) return;
    setGuestRequestBusy(true);
    try {
      await api(`/api/guest-requests/${encodeURIComponent(guestRequest.id)}`, { method: 'DELETE', headers: { 'x-net-guest-request': guestRequest.requestToken } }, null);
      localStorage.removeItem(guestRequestStorageKey(inviteCode));
      setGuestRequest(null);
      setGuestIntroduction('');
      setNotice(t('Join request cancelled.'));
    } catch (cancelError) {
      setError(cancelError instanceof Error ? cancelError.message : t('The join request could not be cancelled.'));
    } finally {
      setGuestRequestBusy(false);
    }
  };

  const endGuest = async () => {
    if (endingGuestRef.current) return;
    setGuestEndConfirmOpen(false);
    endingGuestRef.current = true;
    try {
      const result = await api<{ retained?: boolean }>('/api/guest', { method: 'DELETE' });
      if (guestSession) await deleteStudioDraftsForPrefix(`guest:${guestSession}:`).catch(() => undefined);
      clearGuestSession('');
      setNotice(result.retained
        ? t('Your guest session ended. You no longer have access; content you sent remains in the room.')
        : t('Your guest session ended. The room had no signed-in member, so temporary content was removed.'));
    } catch (endError) {
      if (endError instanceof ApiRequestError && endError.status === 401) {
        clearGuestSession('');
        setNotice(t('Your guest session ended. You no longer have access; content you sent remains in the room.'));
      } else {
        endingGuestRef.current = false;
        setError(endError instanceof Error ? endError.message : t('The session could not be ended. Try again.'));
      }
    }
  };

  const resetConversationStarter = () => {
    contactSearchGeneration.current += 1;
    setCreateRoomOpen(false);
    setRoomName('');
    setContactQuery('');
    setContactResults([]);
    setContactSearching(false);
    setConversationStartError('');
    setSelectedContacts([]);
    setAllowGuests(true);
  };

  const openConversationStarter = () => {
    setConversationStartError('');
    setCreateRoomOpen(true);
  };

  const createConversation = async (event: FormEvent) => {
    event.preventDefault();
    if (!selectedContacts.length) {
      setConversationStartError(t('Select at least one person.'));
      return;
    }
    const group = selectedContacts.length > 1;
    setBusy(true); setConversationStartError('');
    try {
      const created = await api<{ id: string; reused?: boolean }>('/api/rooms', { method: 'POST', body: JSON.stringify({ name: group ? roomName : undefined, allowGuests: group ? allowGuests : false, memberIds: selectedContacts.map((contact) => contact.id) }) });
      await loadBootstrap();
      selectRoom(created.id);
      resetConversationStarter();
      setNotice(group
        ? t('Created a new group.')
        : created.reused
          ? t('Reopened your conversation with {name}.', { name: selectedContacts[0].displayName })
          : t('Started a conversation with {name}.', { name: selectedContacts[0].displayName }));
    } catch (createError) { setConversationStartError(createError instanceof Error ? createError.message : t('The conversation could not be started. Try again.')); }
    setBusy(false);
  };

  const uploadAsset = useCallback(async (blob: Blob, roomId = activeRoomId, uploadId?: string) => {
    if (!roomId) throw new Error(t('Select a conversation first.'));
    const uploadQuery = uploadId ? `&uploadId=${encodeURIComponent(uploadId)}` : '';
    return api<{ key: string }>(`/api/assets?room=${encodeURIComponent(roomId)}${uploadQuery}`, { method: 'POST', headers: { 'content-type': blob.type }, body: blob });
  }, [activeRoomId, api, t]);

  const sendMessage = useCallback(async (payload: SendableMessage, replyToId: string | null, clientRequestId = crypto.randomUUID(), roomId = activeRoomId) => {
    if (!roomId) throw new Error(t('Select a conversation first.'));
    const sent = await api<{ id: string; sequence: number; createdAt: number; canvasVersion: number | null }>(`/api/rooms/${roomId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ ...payload, replyToId, clientRequestId }),
    });
    if (activeRoomRef.current === roomId) await loadMessages(roomId);
    await loadBootstrap();
    return sent;
  }, [activeRoomId, api, loadBootstrap, loadMessages, t]);

  const queueMessage = useCallback(async (
    pending: Omit<PendingMessage, 'createdAt' | 'status' | 'error' | 'blobKey'>,
    blob?: Blob,
    recovery?: { status: 'waiting' | 'blocked'; error: string | null },
  ) => {
    if (!actor || !outboxStoragePrefix || (actor.kind === 'guest' && endingGuestRef.current)) throw new Error(t('This item could not be saved on your device.'));
    const capturedActorId = actor.id;
    const capturedPrefix = outboxStoragePrefix;
    const blobKey = blob ? `${actor.kind}:${actor.id}:${pending.id}` : null;
    if (blob && blobKey) await saveOutboxBlob(blobKey, blob);
    const identityChanged = actorIdRef.current !== capturedActorId || outboxStoragePrefixRef.current !== capturedPrefix || (actor.kind === 'guest' && endingGuestRef.current);
    if (identityChanged) {
      if (blobKey) await deleteOutboxBlob(blobKey).catch(() => undefined);
      throw new Error(t('This item could not be saved on your device.'));
    }
    const queued: PendingMessage = {
      ...pending,
      blobKey,
      createdAt: Date.now(),
      status: recovery?.status ?? 'waiting',
      error: recovery?.error ?? null,
    };
    try {
      localStorage.setItem(`${capturedPrefix}${pending.id}`, serializePendingMessage(queued));
    } catch (storageError) {
      if (blobKey) await deleteOutboxBlob(blobKey).catch(() => undefined);
      setOutboxPersistenceFailed(true);
      throw storageError;
    }
    setPendingMessages(readStoredOutbox(capturedPrefix).messages);
    setOutboxPersistenceFailed(false);
    setOutboxExpanded(true);
  }, [actor, outboxStoragePrefix, t]);

  const removePendingMessage = useCallback((id: string) => {
    const removed = pendingMessages.find((message) => message.id === id);
    if (outboxStoragePrefix) {
      try {
        localStorage.removeItem(`${outboxStoragePrefix}${id}`);
        setOutboxPersistenceFailed(false);
      } catch {
        setOutboxPersistenceFailed(true);
      }
    }
    setPendingMessages(outboxStoragePrefix ? readStoredOutbox(outboxStoragePrefix).messages : pendingMessages.filter((message) => message.id !== id));
    if (removed?.blobKey) void deleteOutboxBlob(removed.blobKey).catch(() => undefined);
    if (removed?.assetKey) void api(`/api/assets/${encodeURIComponent(removed.assetKey)}/pending`, { method: 'DELETE' }).catch(() => undefined);
  }, [api, outboxStoragePrefix, pendingMessages]);

  const deliverPendingMessage = useCallback(async (pending: PendingMessage) => {
    let assetKey = pending.assetKey;
    if (pending.type !== 'text' && !assetKey) {
      const blob = pending.blobKey ? await readOutboxBlob(pending.blobKey) : null;
      if (!blob) throw new ApiRequestError(410, t('The saved attachment is no longer available. Remove it and attach the file again.'));
      const asset = await uploadAsset(blob, pending.roomId, pending.id);
      assetKey = asset.key;
      setPendingMessages((current) => current.map((message) => message.id === pending.id ? { ...message, assetKey } : message));
    }
    await sendMessage({ type: pending.type, text: pending.text || undefined, assetKey: assetKey || undefined, canvasParentId: pending.canvasParentId, imageDescription: pending.imageDescription || undefined, imagePurpose: pending.imagePurpose }, pending.replyToId, pending.id, pending.roomId);
    if (pending.blobKey) await deleteOutboxBlob(pending.blobKey).catch(() => undefined);
  }, [sendMessage, t, uploadAsset]);

  const retryPendingMessages = useCallback(async (roomId?: string | null, messageId?: string) => {
    if (!networkOnline || outboxRetrying) return;
    const waiting = pendingMessages.filter((message) => message.status !== 'sending' && (message.status !== 'blocked' || Boolean(messageId)) && (!roomId || message.roomId === roomId) && (!messageId || message.id === messageId));
    if (!waiting.length) return;
    setOutboxRetrying(true);
    for (const pending of waiting) {
      setPendingMessages((current) => current.map((message) => message.id === pending.id ? { ...message, status: 'sending', error: null } : message));
      try {
        await deliverPendingMessage(pending);
        removePendingMessage(pending.id);
      } catch (retryError) {
        const retryable = isRetryableSendError(retryError);
        setPendingMessages((current) => current.map((message) => message.id === pending.id ? {
          ...message,
          status: retryable ? 'failed' : 'blocked',
          error: retryError instanceof Error ? retryError.message : t('This item could not be sent.'),
        } : message));
        if (!navigator.onLine) break;
      }
    }
    setOutboxRetrying(false);
  }, [deliverPendingMessage, networkOnline, outboxRetrying, pendingMessages, removePendingMessage, t]);

  const previousNetworkOnlineRef = useRef(networkOnline);
  useEffect(() => {
    const reconnected = networkOnline && !previousNetworkOnlineRef.current;
    previousNetworkOnlineRef.current = networkOnline;
    if (!outboxReady || !reconnected || !pendingMessages.some((message) => message.status !== 'blocked')) return;
    void retryPendingMessages();
  }, [networkOnline, outboxReady, pendingMessages, retryPendingMessages]);

  const submitText = async () => {
    const text = draft.trim();
    if (!text || busy) return;
    const replyingTo = replyTo;
    const clientRequestId = crypto.randomUUID();
    setBusy(true); setError('');
    setDraft(''); setReplyTo(null);
    if (!networkOnline) {
      try {
        await queueMessage({ id: clientRequestId, roomId: activeRoomId ?? '', type: 'text', text, assetKey: null, canvasParentId: null, fileName: null, replyToId: replyingTo?.id ?? null });
      } catch {
        setDraft(text);
        setReplyTo(replyingTo);
        setError(t('The message could not be saved for retry. Copy it before closing this page.'));
      }
      setBusy(false);
      return;
    }
    try {
      const sent = await sendMessage({ type: 'text', text }, replyingTo?.id ?? null, clientRequestId);
      setUndoMessage({ messageId: sent.id, roomId: activeRoomId ?? '', expiresAt: Date.now() + 8_000 });
    }
    catch (sendError) {
      if (isRetryableSendError(sendError)) {
        try {
          await queueMessage({ id: clientRequestId, roomId: activeRoomId ?? '', type: 'text', text, assetKey: null, canvasParentId: null, fileName: null, replyToId: replyingTo?.id ?? null });
        } catch {
          setDraft(text);
          setReplyTo(replyingTo);
          setError(t('The message could not be saved for retry. Copy it before closing this page.'));
        }
      }
      else {
        setDraft((current) => current || text);
        setReplyTo((current) => current ?? replyingTo);
        setError(sendError instanceof Error ? sendError.message : t('The message could not be sent. Try again.'));
      }
    }
    setBusy(false);
  };

  const attachImage = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file || !activeRoomId) return;
    setPhotoStep(1);
    setPhotoDraft({ file, url: URL.createObjectURL(file), rotation: 0, crop: 'original', prompt: '', description: '', purpose: 'creative', replyToId: replyTo?.id ?? null });
  };

  const closePhotoDraft = () => {
    setPhotoDraft((current) => {
      if (current) URL.revokeObjectURL(current.url);
      return null;
    });
    setPhotoStep(1);
  };

  const sendPreparedPhoto = async () => {
    if (!photoDraft || !activeRoomId || busy) return;
    const { file, rotation, crop, prompt, description, purpose, replyToId } = photoDraft;
    const roomId = activeRoomId;
    const clientRequestId = crypto.randomUUID();
    setBusy(true); setError('');
    let assetKey: string | null = null;
    try {
      const prepared = rotation === 0 && crop === 'original' ? file : await preparePhoto(file, rotation, crop);
      if (!networkOnline) {
        await queueMessage({ id: clientRequestId, roomId, type: 'image', text: prompt.trim() || null, assetKey: null, canvasParentId: null, imageDescription: description.trim() || null, imagePurpose: purpose, fileName: prepared.name, replyToId }, prepared);
        setReplyTo(null);
        closePhotoDraft();
        setBusy(false);
        return;
      }
      const asset = await uploadAsset(prepared, roomId, clientRequestId);
      assetKey = asset.key;
      const sent = await sendMessage({ type: 'image', assetKey, text: prompt.trim() || undefined, imageDescription: description.trim() || undefined, imagePurpose: purpose }, replyToId, clientRequestId, roomId);
      setUndoMessage({ messageId: sent.id, roomId, expiresAt: Date.now() + 8_000 });
      setReplyTo(null);
      closePhotoDraft();
    } catch (uploadError) {
      if (isRetryableSendError(uploadError)) {
        try {
          const prepared = assetKey ? undefined : rotation === 0 && crop === 'original' ? file : await preparePhoto(file, rotation, crop);
          await queueMessage({ id: clientRequestId, roomId, type: 'image', text: prompt.trim() || null, assetKey, canvasParentId: null, imageDescription: description.trim() || null, imagePurpose: purpose, fileName: file.name, replyToId }, prepared);
          setReplyTo(null);
          closePhotoDraft();
        } catch (storageError) {
          setError(storageError instanceof Error ? storageError.message : t('The image could not be saved for retry. Keep this page open and try again.'));
        }
      } else {
        const message = uploadError instanceof Error ? uploadError.message : t('The image could not be sent. Try again.');
        try {
          await queueMessage(
            { id: clientRequestId, roomId, type: 'image', text: prompt.trim() || null, assetKey, canvasParentId: null, imageDescription: description.trim() || null, imagePurpose: purpose, fileName: file.name, replyToId },
            assetKey ? undefined : file,
            { status: 'blocked', error: message },
          );
          setReplyTo(null);
          closePhotoDraft();
        } catch (storageError) {
          setError(storageError instanceof Error ? storageError.message : t('The image could not be saved for retry. Keep this page open and try again.'));
        }
      }
    }
    setBusy(false);
  };

  const closeStudio = () => {
    if (paletteMutationActiveRef.current) {
      setError(t('Your palette is still updating. Studio can close as soon as it finishes.'));
      return;
    }
    paletteRequestGeneration.current += 1;
    paletteAbortRef.current?.abort();
    paletteAbortRef.current = null;
    setPaletteLoading(false);
    setStudio(null);
  };

  const sendDrawing = async (blob: Blob, caption: string) => {
    if (!activeRoomId) return false;
    const roomId = activeRoomId;
    const replyingTo = replyTo;
    const clientRequestId = crypto.randomUUID();
    let assetKey: string | null = null;
    try {
      if (!networkOnline) {
        await queueMessage({ id: clientRequestId, roomId, type: 'canvas', text: caption || null, assetKey: null, canvasParentId: studio?.parentId ?? null, fileName: t('Drawing'), replyToId: replyingTo?.id ?? null }, blob);
        setReplyTo(null);
        closeStudio();
        return true;
      }
      const asset = await uploadAsset(blob, roomId, clientRequestId);
      assetKey = asset.key;
      const sent = await sendMessage({ type: 'canvas', assetKey, text: caption || undefined, canvasParentId: studio?.parentId ?? null }, replyingTo?.id ?? null, clientRequestId, roomId);
      setUndoMessage({ messageId: sent.id, roomId, expiresAt: Date.now() + 8_000 });
      setReplyTo(null);
      closeStudio();
      return true;
    } catch (drawingError) {
      if (isRetryableSendError(drawingError)) {
        try {
          await queueMessage({ id: clientRequestId, roomId, type: 'canvas', text: caption || null, assetKey, canvasParentId: studio?.parentId ?? null, fileName: t('Drawing'), replyToId: replyingTo?.id ?? null }, assetKey ? undefined : blob);
          setReplyTo(null);
          closeStudio();
          return true;
        } catch (storageError) {
          setError(storageError instanceof Error ? storageError.message : t('The drawing could not be saved for retry. Keep Studio open and try again.'));
          return false;
        }
      } else {
        const message = drawingError instanceof Error ? drawingError.message : t('The drawing could not be sent. Try again.');
        try {
          await queueMessage(
            { id: clientRequestId, roomId, type: 'canvas', text: caption || null, assetKey, canvasParentId: studio?.parentId ?? null, fileName: t('Drawing'), replyToId: replyingTo?.id ?? null },
            assetKey ? undefined : blob,
            { status: 'blocked', error: message },
          );
        } catch (storageError) {
          setError(storageError instanceof Error ? storageError.message : t('The drawing could not be saved for retry. Keep Studio open and try again.'));
          return false;
        }
        setError(message);
        return false;
      }
    }
  };

  const editPendingMessage = (pending: PendingMessage) => {
    if (pending.type !== 'text' || !pending.text) return;
    setDraft(pending.text);
    setReplyTo(pending.replyToId ? messages.find((message) => message.id === pending.replyToId) ?? null : null);
    removePendingMessage(pending.id);
    window.requestAnimationFrame(() => messageInputRef.current?.focus());
  };

  const copyPendingMessage = async (pending: PendingMessage) => {
    const content = pending.text || pending.fileName || t(pending.type === 'canvas' ? 'Drawing' : 'Photo');
    try {
      await navigator.clipboard.writeText(content);
      setNotice(t('Queued content copied.'));
    } catch {
      setError(t('Your browser blocked clipboard access.'));
    }
  };

  const resolvePendingMedia = async (pending: PendingMessage) => {
    const blob = pending.blobKey ? await readOutboxBlob(pending.blobKey) : null;
    if (blob) return { blob, url: URL.createObjectURL(blob), revoke: true };
    if (pending.assetKey) {
      const access = await api<{ assetUrl: string }>(`/api/assets/${encodeURIComponent(pending.assetKey)}/access`);
      return { blob: null, url: access.assetUrl, revoke: false };
    }
    throw new Error(t('The saved attachment is no longer available. Replace the file before sending again.'));
  };

  const closePendingPreview = () => {
    setPendingPreview((current) => {
      if (current?.revoke) URL.revokeObjectURL(current.url);
      return null;
    });
  };

  const previewPendingMedia = async (pending: PendingMessage) => {
    try {
      closePendingPreview();
      const media = await resolvePendingMedia(pending);
      setPendingPreview({ message: pending, url: media.url, revoke: media.revoke });
    } catch (previewError) {
      setError(previewError instanceof Error ? previewError.message : t('The saved attachment could not be previewed.'));
    }
  };

  const savePendingMedia = async (pending: PendingMessage) => {
    try {
      const media = await resolvePendingMedia(pending);
      let blob = media.blob;
      if (!blob) blob = await fetch(media.url).then((response) => {
        if (!response.ok) throw new Error(t('The saved attachment could not be downloaded.'));
        return response.blob();
      });
      if (!blob) throw new Error(t('The saved attachment could not be downloaded.'));
      const objectUrl = media.revoke ? media.url : URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = objectUrl;
      anchor.download = pending.fileName || (pending.type === 'canvas' ? 'net-drawing.png' : 'net-photo.png');
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
      setNotice(t('Saved the queued attachment to your device.'));
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : t('The saved attachment could not be downloaded.'));
    }
  };

  const replacePendingMedia = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    const pendingId = replacePendingId;
    setReplacePendingId(null);
    if (!file || !pendingId || !outboxStoragePrefix) return;
    const pending = pendingMessages.find((message) => message.id === pendingId);
    if (!pending || pending.type === 'text') return;
    const blobKey = pending.blobKey ?? `${actor?.kind}:${actor?.id}:${pending.id}`;
    try {
      await saveOutboxBlob(blobKey, file);
      const replaced = { ...pending, assetKey: null, blobKey, fileName: file.name, status: 'waiting' as const, error: null };
      localStorage.setItem(`${outboxStoragePrefix}${pending.id}`, serializePendingMessage(replaced));
      setPendingMessages((current) => current.map((message) => message.id === pending.id ? replaced : message));
      if (pending.assetKey) void api(`/api/assets/${encodeURIComponent(pending.assetKey)}/pending`, { method: 'DELETE' }).catch(() => undefined);
      setHistoryAnnouncement(t('Queued attachment replaced and ready to send.'));
    } catch (replaceError) {
      setError(replaceError instanceof Error ? replaceError.message : t('The replacement could not be saved on this device.'));
    }
  };

  const openStudio = (nextStudio: { sourceUrl?: string | null; parentId?: string | null; version?: number | null; draftSource?: boolean; sourceKind?: 'photo' | 'drawing' | 'draft'; sourceAuthor?: string | null }) => {
    paletteAbortRef.current?.abort();
    const controller = new AbortController();
    const generation = ++paletteRequestGeneration.current;
    paletteAbortRef.current = controller;
    setPaletteColors([]);
    setPaletteLoading(true);
    setStudio(nextStudio);
    void api<{ colors: PaletteColorView[] }>('/api/palette', { signal: controller.signal })
      .then((data) => { if (paletteRequestGeneration.current === generation) setPaletteColors(data.colors); })
      .catch((paletteError) => {
        if (paletteRequestGeneration.current === generation && !(paletteError instanceof DOMException && paletteError.name === 'AbortError')) {
          setError(paletteError instanceof Error ? paletteError.message : t('Your palette could not be opened. Try again.'));
        }
      })
      .finally(() => {
        if (paletteRequestGeneration.current === generation) {
          paletteAbortRef.current = null;
          setPaletteLoading(false);
        }
      });
  };

  const refreshAssetUrl = (assetKey: string, automatic = false): Promise<string | null> => {
    const inFlight = assetRefreshes.current.get(assetKey);
    if (inFlight) return inFlight;
    if (automatic) {
      const attempts = automaticAssetRefreshAttempts.current.get(assetKey) ?? 0;
      if (attempts >= 2) return Promise.resolve(null);
      automaticAssetRefreshAttempts.current.set(assetKey, attempts + 1);
    } else automaticAssetRefreshAttempts.current.delete(assetKey);
    const refresh = api<{ assetUrl: string }>(`/api/assets/${encodeURIComponent(assetKey)}/access`)
      .then((data) => {
        setMessages((current) => current.map((message) => message.assetKey === assetKey ? { ...message, assetUrl: data.assetUrl } : message));
        setMessageSearchResults((current) => current.map((message) => message.assetKey === assetKey ? { ...message, assetUrl: data.assetUrl } : message));
        setViewingMedia((current) => current?.assetKey === assetKey ? { ...current, assetUrl: data.assetUrl } : current);
        return data.assetUrl;
      })
      .catch((assetError) => {
        if (!endingGuestRef.current) {
          setError(assetError instanceof Error ? assetError.message : t('Image access could not be refreshed. Try again.'));
        }
        return null;
      })
      .finally(() => { assetRefreshes.current.delete(assetKey); });
    assetRefreshes.current.set(assetKey, refresh);
    return refresh;
  };

  const downloadMedia = async (message: MessageView) => {
    const downloadKey = message.assetKey ?? message.id;
    if (downloadingAssetKey === downloadKey || !message.assetUrl) return;
    setDownloadingAssetKey(downloadKey);
    try {
      let assetUrl = message.assetUrl;
      let response = await fetch(assetUrl);
      if (!response.ok && message.assetKey && [401, 403].includes(response.status)) {
        const refreshed = await refreshAssetUrl(message.assetKey);
        if (!refreshed) throw new Error(t('Download access could not be refreshed. Try again.'));
        assetUrl = refreshed;
        response = await fetch(assetUrl);
      }
      if (!response.ok) throw new Error(t('Image data could not be downloaded. Try again.'));
      const blob = await response.blob();
      const extension = ({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp' } as Record<string, string>)[blob.type] ?? 'png';
      const date = localDateStamp(message.createdAt);
      const label = message.type === 'canvas' ? `drawing-v${message.canvasVersion ?? 1}` : 'image';
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = objectUrl;
      anchor.download = `net-${label}-${date}.${extension}`;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
      setNotice(t('Downloaded the image to your device.'));
    } catch (downloadError) {
      setError(downloadError instanceof Error ? downloadError.message : t('The image could not be downloaded. Try again.'));
    } finally {
      setDownloadingAssetKey(null);
    }
  };

  const continueDrawing = async (message: MessageView) => {
    if (!message.assetKey) return;
    const roomId = activeRoomRef.current;
    if (!roomId || message.roomId !== roomId) return;
    const generation = ++continuationGeneration.current;
    const freshUrl = await refreshAssetUrl(message.assetKey);
    if (freshUrl && generation === continuationGeneration.current && activeRoomRef.current === roomId) {
      openStudio({ sourceUrl: freshUrl, parentId: message.id, version: message.canvasVersion, sourceKind: message.type === 'image' ? 'photo' : 'drawing', sourceAuthor: message.senderName });
    }
  };

  const loadDrawingLineage = async (messageId: string) => {
    if (!activeRoomId) return;
    const roomId = activeRoomId;
    const generation = ++lineageRequestGeneration.current;
    setLineageViewer((current) => ({ messageId, lineage: current?.messageId === messageId ? current.lineage : [], loading: true, error: '', truncated: false, canDecide: current?.canDecide ?? false, decisionOwners: current?.decisionOwners ?? [] }));
    try {
      const data = await api<{ lineage: CanvasLineageItem[]; truncated?: boolean; canDecide?: boolean; decisionOwners?: Array<{ id: string; displayName: string }> }>(`/api/rooms/${roomId}/messages/${messageId}/lineage`);
      if (generation !== lineageRequestGeneration.current || activeRoomRef.current !== roomId) return;
      setLineageViewer({ messageId, lineage: data.lineage, loading: false, error: '', truncated: Boolean(data.truncated), canDecide: Boolean(data.canDecide), decisionOwners: data.decisionOwners ?? [] });
    } catch (lineageError) {
      if (generation !== lineageRequestGeneration.current || activeRoomRef.current !== roomId) return;
      setLineageViewer({
        messageId,
        lineage: [],
        loading: false,
        error: lineageError instanceof Error ? lineageError.message : t('Visual history could not be loaded. Try again.'),
        truncated: false,
        canDecide: false,
        decisionOwners: [],
      });
    }
  };

  const updateVisualDecision = async (item: CanvasLineageItem, input: { voted?: boolean; status?: CanvasLineageItem['visualStatus']; note?: string; ownerId?: string | null }) => {
    if (!activeRoomId || !lineageViewer) return;
    await api(`/api/rooms/${activeRoomId}/messages/${item.id}/decision`, { method: 'PATCH', body: JSON.stringify(input) });
    await loadDrawingLineage(lineageViewer.messageId);
  };

  const continueFromLineage = async (item: CanvasLineageItem) => {
    if (!item.assetKey) return;
    const roomId = activeRoomRef.current;
    if (!roomId || item.roomId !== roomId) return;
    const generation = ++continuationGeneration.current;
    const freshUrl = await refreshAssetUrl(item.assetKey);
    if (!freshUrl || generation !== continuationGeneration.current || activeRoomRef.current !== roomId) return;
    lineageRequestGeneration.current += 1;
    continuationGeneration.current += 1;
    setLineageViewer(null);
    openStudio({ sourceUrl: freshUrl, parentId: item.id, version: item.canvasVersion, sourceKind: item.type === 'image' ? 'photo' : 'drawing', sourceAuthor: item.senderName });
  };

  const savePaletteColor = async (input: { name: string; components: Array<{ color: string; weight: number }> }) => {
    if (paletteLoading || paletteMutationActiveRef.current) throw new Error(t('Your palette is busy. Try again in a moment.'));
    const requestGeneration = paletteRequestGeneration.current;
    const mutationGeneration = ++paletteMutationGeneration.current;
    const mutationActorId = actorIdRef.current;
    paletteMutationActiveRef.current = true;
    setPaletteMutating(true);
    try {
      const data = await api<{ color: PaletteColorView }>('/api/palette', { method: 'POST', body: JSON.stringify(input) });
      if (paletteRequestGeneration.current === requestGeneration && actorIdRef.current === mutationActorId) {
        setPaletteColors((current) => [...current, data.color]);
      }
    } finally {
      if (paletteMutationGeneration.current === mutationGeneration) {
        paletteMutationActiveRef.current = false;
        setPaletteMutating(false);
      }
    }
  };

  const deletePaletteColor = async (id: string) => {
    if (paletteLoading || paletteMutationActiveRef.current) throw new Error(t('Your palette is busy. Try again in a moment.'));
    const requestGeneration = paletteRequestGeneration.current;
    const mutationGeneration = ++paletteMutationGeneration.current;
    const mutationActorId = actorIdRef.current;
    paletteMutationActiveRef.current = true;
    setPaletteMutating(true);
    try {
      await api(`/api/palette/${id}`, { method: 'DELETE' });
      if (paletteRequestGeneration.current === requestGeneration && actorIdRef.current === mutationActorId) {
        setPaletteColors((current) => current.filter((item) => item.id !== id));
      }
    } finally {
      if (paletteMutationGeneration.current === mutationGeneration) {
        paletteMutationActiveRef.current = false;
        setPaletteMutating(false);
      }
    }
  };

  const react = async (messageId: string, emoji: string) => {
    try {
      await api(`/api/messages/${messageId}/reactions`, { method: 'POST', body: JSON.stringify({ emoji }) });
      if (activeRoomId) await loadMessages(activeRoomId, true);
    } catch (reactionError) { setError(reactionError instanceof Error ? reactionError.message : t('The reaction could not be updated. Try again.')); }
  };

  const saveMessageEdit = async (event: FormEvent) => {
    event.preventDefault();
    if (!activeRoomId || !editingMessage || busy) return;
    const nextText = editingText.trim();
    if (editingMessage.type === 'text' && !nextText) return;
    setBusy(true);
    try {
      await api(`/api/rooms/${activeRoomId}/messages/${editingMessage.id}`, { method: 'PATCH', body: JSON.stringify({ text: nextText }) });
      setEditingMessage(null);
      await loadMessages(activeRoomId, true);
      setNotice(t('Contribution updated.'));
    } catch (editError) {
      setError(editError instanceof Error ? editError.message : t('The contribution could not be updated. Try again.'));
    } finally {
      setBusy(false);
    }
  };

  const deleteContribution = async (message: MessageView) => {
    if (!activeRoomId || busy) return;
    setBusy(true);
    try {
      await api(`/api/rooms/${activeRoomId}/messages/${message.id}`, { method: 'DELETE' });
      setDeletingMessage(null);
      setUndoMessage((current) => current?.messageId === message.id ? null : current);
      await loadMessages(activeRoomId, true);
      setNotice(t('Contribution removed. Its place in visual history is preserved.'));
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : t('The contribution could not be removed. Try again.'));
    } finally {
      setBusy(false);
    }
  };

  const undoLastSend = async () => {
    const pendingUndo = undoMessage;
    if (!pendingUndo || pendingUndo.expiresAt <= Date.now()) return;
    setUndoMessage(null);
    try {
      await api(`/api/rooms/${pendingUndo.roomId}/messages/${pendingUndo.messageId}/undo`, { method: 'DELETE' });
      if (activeRoomRef.current === pendingUndo.roomId) await loadMessages(pendingUndo.roomId, true);
      await loadBootstrap();
      setNotice(t('Send undone.'));
    } catch (undoError) {
      setError(undoError instanceof Error ? undoError.message : t('Undo Send is no longer available.'));
    }
  };

  const loadOlder = async () => {
    if (!activeRoomId || !nextCursor || loadingOlder) return;
    setLoadingOlder(true);
    await loadMessages(activeRoomId, false, nextCursor);
    setLoadingOlder(false);
  };

  const jumpToLatest = async () => {
    if (!activeRoomId) return;
    setViewingLatest(true);
    setFirstUnreadSequence(null);
    await loadMessages(activeRoomId);
    requestAnimationFrame(() => endRef.current?.scrollIntoView({ block: 'end', behavior: 'smooth' }));
  };

  const copyInvite = async () => {
    if (!activeRoom) return;
    if (!activeRoom.inviteActive) { setError(t('Create a new invite link before copying it.')); return; }
    const link = `${window.location.origin}/?room=${activeRoom.inviteCode}`;
    try {
      await navigator.clipboard.writeText(link);
      setNotice(t('Copied the invite link.'));
    } catch { setError(t('Your browser blocked clipboard access. Select the invite link and copy it manually.')); }
  };

  const openPeopleSafety = async (
    section: 'people' | 'requests' | 'access' | 'safety' = 'people',
    targetRoomId = activeRoomId,
    requestedHighlightId?: string | null,
  ) => {
    if (!targetRoomId) return;
    setInfoOpen(false);
    setMobileHeaderMenuOpen(false);
    setPeopleSafetyOpen(true);
    setPeopleSafetySection(section);
    setHighlightedGuestRequestId(requestedHighlightId ?? guestRequestHighlightByRoomRef.current.get(targetRoomId) ?? null);
    setRoomPeopleLoading(true);
    try {
      const people = await api<RoomPeopleView>(`/api/rooms/${targetRoomId}/people`);
      setRoomPeople(people);
      if (people.canManage) {
        setGuestRequestsLoading(true);
        const data = await api<{ requests: GuestRequestView[] }>(`/api/rooms/${targetRoomId}/guest-requests`);
        setGuestRequests(data.requests);
        if (section === 'requests' && !requestedHighlightId) {
          setHighlightedGuestRequestId(guestRequestHighlightByRoomRef.current.get(targetRoomId) ?? data.requests.find((request) => request.status === 'pending')?.id ?? data.requests[0]?.id ?? null);
        }
      } else setGuestRequests([]);
    } catch (peopleError) {
      setError(peopleError instanceof Error ? peopleError.message : t('People and safety settings could not be loaded.'));
    } finally {
      setRoomPeopleLoading(false);
      setGuestRequestsLoading(false);
    }
  };

  useEffect(() => {
    if (!peopleSafetyOpen || peopleSafetySection !== 'requests') return;
    const timer = window.setInterval(() => setRequestClock(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, [peopleSafetyOpen, peopleSafetySection]);

  useEffect(() => {
    if (!peopleSafetyOpen || peopleSafetySection !== 'requests' || !highlightedGuestRequestId || guestRequestsLoading) return;
    const frame = requestAnimationFrame(() => {
      const requestCard = document.getElementById(`guest-request-${highlightedGuestRequestId}`);
      requestCard?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      requestCard?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [guestRequests, guestRequestsLoading, highlightedGuestRequestId, peopleSafetyOpen, peopleSafetySection]);

  const refreshRoomGuestRequests = useCallback(async () => {
    if (!activeRoomId || !peopleSafetyOpen || !roomPeople?.canManage) return;
    try {
      const data = await api<{ requests: GuestRequestView[] }>(`/api/rooms/${activeRoomId}/guest-requests`);
      setGuestRequests(data.requests);
    } catch {
      // The visible queue keeps its last durable state until the next manual action.
    }
  }, [activeRoomId, api, peopleSafetyOpen, roomPeople?.canManage]);

  useEffect(() => {
    if (!peopleSafetyOpen || !roomPeople?.canManage) return;
    const poll = window.setInterval(() => void refreshRoomGuestRequests(), 12_000);
    return () => window.clearInterval(poll);
  }, [peopleSafetyOpen, refreshRoomGuestRequests, roomPeople?.canManage]);

  const decideRoomGuestRequest = async (request: GuestRequestView, decision: 'approve' | 'reject' | 'revoke', reason = '') => {
    if (!activeRoomId || guestRequestActionId) return;
    setGuestRequestActionId(request.id);
    try {
      await api(`/api/rooms/${activeRoomId}/guest-requests/${encodeURIComponent(request.id)}/${decision}`, {
        method: 'POST',
        body: decision === 'reject' ? JSON.stringify({ reason }) : undefined,
      });
      if (request.status === 'pending') setRooms((current) => current.map((room) => room.id === activeRoomId ? { ...room, pendingRequestCount: Math.max(0, room.pendingRequestCount - 1) } : room));
      await refreshRoomGuestRequests();
      setDecliningGuestRequest(null);
      setDeclineReason('');
      setNotice(decision === 'approve'
        ? t('{name} can now enter the conversation.', { name: request.displayName })
        : decision === 'revoke' ? t('The admission grant was revoked.') : t('The join request was declined.'));
    } catch (decisionError) {
      setError(decisionError instanceof Error ? decisionError.message : t('The join request could not be updated.'));
      await refreshRoomGuestRequests();
    } finally {
      setGuestRequestActionId(null);
    }
  };

  const toggleRoomMute = async () => {
    if (!activeRoomId || !roomPeople) return;
    try {
      const result = await api<{ muted: boolean }>(`/api/rooms/${activeRoomId}/preferences`, { method: 'PATCH', body: JSON.stringify({ muted: !roomPeople.muted }) });
      setRoomPeople((current) => current ? { ...current, muted: result.muted } : current);
      setRooms((current) => current.map((room) => room.id === activeRoomId ? { ...room, muted: result.muted } : room));
      setNotice(result.muted ? t('Conversation muted.') : t('Conversation notifications restored.'));
    } catch (muteError) {
      setError(muteError instanceof Error ? muteError.message : t('The notification preference could not be updated.'));
    }
  };

  const removeRoomMember = async (person: RoomPersonView) => {
    if (!activeRoomId || person.kind !== 'user') return;
    try {
      await api(`/api/rooms/${activeRoomId}/members/${encodeURIComponent(person.id)}`, { method: 'DELETE' });
      setRoomPeople((current) => current ? { ...current, members: current.members.filter((member) => member.id !== person.id) } : current);
      setNotice(t('{name} was removed from the conversation.', { name: person.displayName }));
    } catch (removeError) {
      setError(removeError instanceof Error ? removeError.message : t('The member could not be removed.'));
    }
  };

  const leaveConversation = async () => {
    if (!activeRoomId) return;
    try {
      await api(`/api/rooms/${activeRoomId}/membership`, { method: 'DELETE' });
      setPeopleSafetyOpen(false);
      await loadBootstrap();
      setNotice(t('You left the conversation.'));
    } catch (leaveError) {
      setError(leaveError instanceof Error ? leaveError.message : t('You could not leave this conversation.'));
    }
  };

  const submitReport = async (event: FormEvent) => {
    event.preventDefault();
    if (!activeRoomId) return;
    try {
      await api(`/api/rooms/${activeRoomId}/reports`, { method: 'POST', body: JSON.stringify({ reason: reportReason, details: reportDetails, reportedUserId: reportMessage?.senderId ?? (reportTarget?.kind === 'user' ? reportTarget.id : null), messageId: reportMessage?.id ?? null }) });
      setReportTarget(null);
      setReportMessage(null);
      setReportOpen(false);
      setReportDetails('');
      setNotice(t('Report received. Thank you for helping keep Nét safe.'));
    } catch (reportError) {
      setError(reportError instanceof Error ? reportError.message : t('The report could not be submitted.'));
    }
  };

  const blockRoomMember = async (person: RoomPersonView) => {
    if (person.kind !== 'user') return;
    try {
      await api(`/api/users/${encodeURIComponent(person.id)}/block`, { method: 'POST' });
      setNotice(t('{name} was blocked.', { name: person.displayName }));
    } catch (blockError) {
      setError(blockError instanceof Error ? blockError.message : t('The member could not be blocked.'));
    }
  };

  const updateGovernance = async (patch: Record<string, unknown>) => {
    if (!activeRoomId) return;
    try {
      const updated = await api<RoomView & { cancelledRequestCount?: number }>(`/api/rooms/${activeRoomId}/governance`, { method: 'PATCH', body: JSON.stringify(patch) });
      setRooms((current) => current.map((room) => room.id === activeRoomId ? { ...room, ...updated } : room));
      setRoomPeople((current) => current ? { ...current, allowGuests: updated.allowGuests, guestAdmissionPolicy: updated.guestAdmissionPolicy, inviteActive: updated.inviteActive, inviteExpiresAt: updated.inviteExpiresAt, inviteMaxUses: updated.inviteMaxUses, inviteUseCount: updated.inviteUseCount } : current);
      if (updated.cancelledRequestCount) setGuestRequests([]);
      setNotice(updated.cancelledRequestCount
        ? t('Settings updated. {count} open requests were cancelled.', { count: updated.cancelledRequestCount })
        : updated.inviteActive ? t('Guest and invite settings updated.') : t('Guest access is closed.'));
    } catch (governanceError) { setError(governanceError instanceof Error ? governanceError.message : t('Conversation settings could not be updated.')); }
  };

  const confirmGovernanceChange = (patch: Record<string, unknown>, title: string, confirmLabel: string) => {
    const pendingCount = guestRequests.filter((request) => request.status === 'pending').length;
    const approvedCount = guestRequests.filter((request) => request.status === 'approved').length;
    setGovernanceConfirmation({
      patch,
      title,
      confirmLabel,
      description: pendingCount || approvedCount
        ? t('This will cancel {pending} pending requests and revoke {approved} unused approvals.', { pending: pendingCount, approved: approvedCount })
        : t('This changes how new guests can enter. Existing room content is not removed.'),
    });
  };

  const transferOwnership = async (person: RoomPersonView) => {
    if (!activeRoomId || person.kind !== 'user') return;
    try {
      await api(`/api/rooms/${activeRoomId}/ownership`, { method: 'POST', body: JSON.stringify({ userId: person.id }) });
      await openPeopleSafety();
      setNotice(t('{name} is now the conversation owner.', { name: person.displayName }));
    } catch (transferError) { setError(transferError instanceof Error ? transferError.message : t('Ownership could not be transferred.')); }
  };

  const removeRoomGuest = async (person: RoomPersonView) => {
    if (!activeRoomId || person.kind !== 'guest') return;
    try {
      await api(`/api/rooms/${activeRoomId}/guests/${encodeURIComponent(person.id)}`, { method: 'DELETE' });
      setRoomPeople((current) => current ? { ...current, members: current.members.filter((member) => member.id !== person.id) } : current);
      setNotice(t('{name} no longer has access. Their contributions remain.', { name: person.displayName }));
    } catch (guestError) { setError(guestError instanceof Error ? guestError.message : t('The guest session could not be ended.')); }
  };

  const archiveConversation = async () => {
    if (!activeRoomId) return;
    try {
      await api(`/api/rooms/${activeRoomId}/membership/archive`, { method: 'PATCH', body: JSON.stringify({ archived: true }) });
      setPeopleSafetyOpen(false);
      await loadBootstrap();
      setNotice(t('Conversation archived for you.'));
    } catch (archiveError) { setError(archiveError instanceof Error ? archiveError.message : t('The conversation could not be archived.')); }
  };

  const deleteConversation = async () => {
    if (!activeRoomId) return;
    try {
      await api(`/api/rooms/${activeRoomId}`, { method: 'DELETE' });
      setDeleteRoomConfirmOpen(false);
      setPeopleSafetyOpen(false);
      await loadBootstrap();
      setNotice(t('Conversation permanently deleted.'));
    } catch (deleteError) { setError(deleteError instanceof Error ? deleteError.message : t('The conversation could not be deleted.')); }
  };

  const unblockAccount = async (userId: string) => {
    try {
      await api(`/api/users/${encodeURIComponent(userId)}/block`, { method: 'DELETE' });
      setRoomPeople((current) => current ? { ...current, blockedAccounts: (current.blockedAccounts ?? []).filter((account) => account.id !== userId) } : current);
      setNotice(t('Account unblocked.'));
      if (activeRoomId) await loadMessages(activeRoomId, true);
    } catch (unblockError) { setError(unblockError instanceof Error ? unblockError.message : t('The account could not be unblocked.')); }
  };

  const filteredRooms = rooms.filter((room) => `${room.name} ${room.preview}`.toLocaleLowerCase(localeTag(locale)).includes(roomQuery.trim().toLocaleLowerCase(localeTag(locale))));
  const pendingGuestRequests = guestRequests.filter((request) => request.status === 'pending');
  const approvedGuestRequests = guestRequests.filter((request) => request.status === 'approved');
  const selectedContactIds = new Set(selectedContacts.map((contact) => contact.id));
  const normalizedInviteCode = extractInviteCode(inviteCode);
  const inviteSignInPath = normalizedInviteCode
    ? `/auth/sign-in?returnTo=${encodeURIComponent(`/?room=${encodeURIComponent(normalizedInviteCode)}`)}`
    : signInPath;
  const homeSignInPath = `${signInPath.split('?')[0]}?returnTo=${encodeURIComponent('/')}`;
  const visibleMessages = useMemo(() => normalizedMessageQuery
    ? normalizedMessageQuery.length >= 2 ? messageSearchResults : []
    : messages, [messageSearchResults, messages, normalizedMessageQuery]);
  const canvasLineageMeta = useMemo(() => {
    const byId = new Map(messages.filter((message) => message.type === 'canvas' || message.type === 'image').map((message) => [message.id, message]));
    return { byId };
  }, [messages]);
  const showInviteOnboarding = Boolean(activeRoom)
    && !normalizedMessageQuery
    && (activeRoom?.messageCount ?? messages.length) <= 1
    && messages.every((message) => message.type === 'system');
  const inviteApproval = inviteStatus === 'approval';
  const inviteReady = inviteStatus === 'guest' || inviteApproval;
  const showGuestConversion = actor?.kind === 'guest'
    && messages.some((message) => message.type === 'canvas' && message.guestSessionId === actor.id);
  const guestConversionPath = activeRoom
    ? `/auth/sign-up?returnTo=${encodeURIComponent(`/?room=${encodeURIComponent(activeRoom.inviteCode)}`)}`
    : signInPath;

  if (phase === 'loading') return <div className="boot-screen"><Logo /><span className="loading-line" /><p>{error || t('Opening your space…')}</p>{error && <button type="button" className="primary-button" onClick={() => { setError(''); setBootstrapRetry((current) => current + 1); }}>{t('Try Connecting Again')}</button>}</div>;

  if (phase === 'landing') {
    return (
      <><a className="skip-link" href="#main-content">{t('Skip to main content')}</a><main id="main-content" className="landing-page">
        <nav className="landing-nav"><Logo /><div><a href="#how">{t('How It Works')}</a><LanguageSwitcher compact /><a href={inviteStatus === 'invalid' ? homeSignInPath : inviteSignInPath} className="nav-signin">{t('Sign In')}</a></div></nav>
        <section className={inviteStatus === 'none' ? 'hero first-mark-hero' : 'hero invite-hero'}>
          <div className="hero-copy">
            <span className="eyebrow">{inviteApproval ? t('Private Room Invite') : inviteReady ? t('Your Invite Is Ready') : inviteStatus === 'auth-only' ? t('Members-Only Invite') : inviteStatus === 'invalid' ? t('Invite Unavailable') : inviteStatus === 'unavailable' ? t('Connection Interrupted') : t('Message with words. Continue with a line.')}</span>
            <h1>{inviteApproval ? <><span>{guestRequest?.status === 'approved' ? t('You are approved,') : t('Ask to join,')}</span>{' '}<em>{guestRequest?.status === 'approved' ? t('then enter when ready.') : t('keep creating while you wait.')}</em></> : inviteReady ? <><span>{t('Enter the room,')}</span>{' '}<em>{t('just choose a name.')}</em></> : inviteStatus === 'auth-only' ? <><span>{t('Sign in,')}</span>{' '}<em>{t('then join instantly.')}</em></> : inviteStatus === 'invalid' ? <><span>{t('This invite link')}</span>{' '}<em>{t('is no longer active.')}</em></> : inviteStatus === 'unavailable' ? <><span>{t('We cannot check')}</span>{' '}<em>{t('your invite yet.')}</em></> : <><span>{t('Some things are')}</span>{' '}<em>{t('easier to draw than say.')}</em></>}</h1>
            <p>{inviteApproval ? guestRequest?.status === 'approved' ? t('Enter when you are ready. Your guest timer has not started yet.') : t('The room stays private until an owner approves you. Your 2-hour guest session starts only when you enter.') : inviteReady ? t('No room search or code entry. Choose a display name, then start chatting and drawing together.') : inviteStatus === 'auth-only' ? t('This room does not accept guests. After you sign in, Nét will take you directly to the conversation.') : inviteStatus === 'invalid' ? t('The invite may have expired or the room may no longer exist. Ask the sender for a new link.') : inviteStatus === 'unavailable' ? t('Nét cannot verify this link while the connection is interrupted. Your invite stays intact so you can try again.') : t('Nét is a messenger for unfinished ideas—send text, images, or a canvas that someone else can continue as a new version.')}</p>
            {inviteReady ? <section className="invite-join-panel" aria-labelledby="invite-join-title">
              <InviteContext preview={invitePreview} />
              {inviteApproval && guestRequest ? <div className={`guest-request-state ${guestRequest.status}`}>
                <div className="invite-join-status"><span><UiIcon name={guestRequest.status === 'approved' ? 'check' : guestRequest.status === 'pending' ? 'history' : 'info'} /></span><div><strong id="invite-join-title">{guestRequest.status === 'approved' ? t('Your Request Was Approved') : guestRequest.status === 'pending' ? t('Request Sent') : guestRequest.status === 'rejected' ? t('Your Request Was Not Approved') : t('This Request Is No Longer Active')}</strong><small>{guestRequest.status === 'approved' ? t('Enter when you are ready. Your guest timer has not started yet.') : guestRequest.status === 'pending' ? t('An owner must approve your request before room content becomes visible.') : t('Ask the sender for a new invitation or sign in.')}</small></div></div>
                <dl><div><dt>{t('Requested')}</dt><dd>{new Intl.DateTimeFormat(localeTag(locale), { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(guestRequest.requestedAt))}</dd></div><div><dt>{guestRequest.status === 'approved' ? t('Enter Before') : t('Request Expires')}</dt><dd>{new Intl.DateTimeFormat(localeTag(locale), { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(guestRequest.grantExpiresAt ?? guestRequest.expiresAt))}</dd></div></dl>
                {guestRequest.status === 'rejected' && guestRequest.decisionReason ? <p className="guest-decision-reason"><strong>{t('A note from the owner')}</strong>{guestRequest.decisionReason}</p> : null}
                {guestRequest.status === 'approved' ? <button type="button" className="hero-primary" onClick={() => void claimApprovedGuestRequest()} disabled={guestRequestBusy}>{guestRequestBusy ? t('Entering…') : <>{pendingLandingSketch ? t('Enter Room & Continue Drawing') : t('Enter {room}', { room: guestRequest.room.name })} <UiIcon name="arrow" size={18} /></>}</button> : null}
                {guestRequest.status === 'pending' ? <div className="guest-request-actions"><button type="button" className="hero-primary" onClick={() => void checkGuestRequest(guestRequest, true)} disabled={guestRequestBusy}>{t('Check Again')}</button><button type="button" onClick={() => void cancelActiveGuestRequest()} disabled={guestRequestBusy}>{t('Cancel Request')}</button></div> : guestRequest.status === 'approved' ? <div className="invite-join-alternatives"><a href={inviteSignInPath}>{t('Sign In')}</a><button type="button" onClick={() => void cancelActiveGuestRequest()} disabled={guestRequestBusy}>{t('Cancel Request')}</button></div> : <div className="invite-join-alternatives"><a href={inviteSignInPath}>{t('Sign In')}</a><button type="button" onClick={() => { localStorage.removeItem(guestRequestStorageKey(inviteCode)); setGuestRequest(null); }}>{t('Request Again')}</button></div>}
              </div> : <>
                <div className="invite-join-status"><span><UiIcon name={inviteApproval ? 'lock' : 'check'} /></span><div><strong id="invite-join-title">{inviteApproval ? t('Request to Join') : t('Join the creative thread')}</strong><small>{inviteApproval ? t('No messages or artwork are shared before approval.') : t('Your invite link has been verified.')}</small></div></div>
                <form className="invite-join-form" onSubmit={startGuest} noValidate>
                  <label>{t('Display Name')}<input ref={guestNameRef} name="guest-invite-name" autoComplete="nickname" value={guestName} onChange={(event) => { setGuestName(event.target.value); setGuestFormError(''); setGuestErrorField(null); setGuestRecovery(null); }} placeholder={t('For example, Alex…')} maxLength={60} aria-invalid={guestErrorField === 'name'} aria-describedby={guestFormError ? 'guest-form-error' : undefined} /></label>
                  {inviteApproval ? <label>{t('Short Introduction')} <small>{t('(optional)')}</small><textarea name="guest-introduction" autoComplete="off" value={guestIntroduction} onChange={(event) => setGuestIntroduction(event.target.value)} maxLength={280} placeholder={t('How do you know the team, or what would you like to contribute?')} /></label> : null}
                  <button type="submit" className="hero-primary" disabled={busy}>{busy ? t(inviteApproval ? 'Sending Request…' : 'Joining…') : <>{guestRecovery ? t('Try Again') : t(inviteApproval ? 'Request to Join' : 'Join Room')} <UiIcon name="arrow" size={18} /></>}</button>
                </form>
              </>}
              {guestFormError && <p id="guest-form-error" className="form-error" role="alert" aria-live="polite">{guestFormError}</p>}
              {guestRecovery ? <GuestRecoveryPanel recovery={guestRecovery} hasDrawing={false} /> : null}
              {!guestRequest ? <div className="invite-join-alternatives"><a href={inviteSignInPath}>{inviteApproval ? t('Sign In to Join Directly') : t('Sign In to Join')}</a><button type="button" onClick={() => { consumeInvite(); setGuestFormError(''); setGuestErrorField(null); }}>{t('Back Home')}</button></div> : null}
              <small>{inviteApproval ? t('Signed-in people join directly. Guest approval applies only to this temporary session.') : t('Guests lose access when their session ends. Messages and attached images remain in the room.')}</small>
            </section> : inviteStatus === 'auth-only' ? <section className="invite-join-panel invite-state-panel" aria-labelledby="invite-auth-title">
              <InviteContext preview={invitePreview} />
              <div className="invite-join-status"><span><UiIcon name="user" /></span><div><strong id="invite-auth-title">{t('This Room Is for Signed-In Members')}</strong><small>{t('The invite is valid and ready.')}</small></div></div>
              <a className="hero-primary" href={inviteSignInPath}>{t('Sign In & Join')} <UiIcon name="arrow" size={18} /></a>
              <button type="button" onClick={consumeInvite}>{t('Back Home')}</button>
            </section> : inviteStatus === 'invalid' ? <section className="invite-join-panel invite-state-panel invalid" aria-labelledby="invite-invalid-title">
              <div className="invite-join-status"><span><UiIcon name="link" /></span><div><strong id="invite-invalid-title">{t('No Room Found for This Link')}</strong><small>{t('Nét has not requested your name or sign-in details.')}</small></div></div>
              <button type="button" className="hero-primary" onClick={consumeInvite}>{t('Back Home')}</button>
            </section> : inviteStatus === 'unavailable' ? <section className="invite-join-panel invite-state-panel" aria-labelledby="invite-unavailable-title">
              <div className="invite-join-status"><span><UiIcon name="link" /></span><div><strong id="invite-unavailable-title">{t('Your Invite Is Safe')}</strong><small>{t('Try again when your connection is more stable.')}</small></div></div>
              <button type="button" className="hero-primary" onClick={() => setBootstrapRetry((current) => current + 1)}>{t('Check Again')}</button>
              <button type="button" onClick={consumeInvite}>{t('Back Home')}</button>
            </section> : <>
              <div className="hero-actions"><button type="button" className="hero-primary" onClick={() => document.getElementById('landing-doodle')?.focus()}>{t('Try Drawing')} <UiIcon name="draw" size={18} /></button><button type="button" onClick={() => { setError(''); setGuestFormError(''); setGuestErrorField(null); setGuestRecovery(null); setGuestModal(true); }}>{t('Try as a Guest')}</button><a className="hero-signin" href={signInPath}>{t('Sign In')}</a></div>
              <small>{t('Draw first · choose a name only when you are ready to send')}</small>
            </>}
          </div>
          {inviteStatus === 'none' || (inviteApproval && guestRequest?.status === 'pending') ? <LandingDoodle onUse={(dataUrl) => { setPendingLandingSketch(dataUrl); setNotice(t('Your drawing is saved on this device while you wait.')); if (inviteStatus === 'none') { setError(''); setGuestFormError(''); setGuestErrorField(null); setGuestRecovery(null); setGuestModal(true); } }} /> : <div className="hero-demo" aria-label={t('Example conversation with messages and drawings')}>
            <div className="demo-top"><span className="avatar" style={avatarStyle('minh')}>M</span><div><strong>Minh Anh</strong><small><i /> {t('drawing with you')}</small></div><b>•••</b></div>
            <div className="demo-canvas"><span className="demo-sun" /><span className="demo-line line-a" /><span className="demo-line line-b" /><strong>{t('Could we add')}<br />{t('a tree here?')}</strong><i>↙</i></div>
            <div className="demo-message">{t('I’ll continue this idea')} ✨</div>
            <div className="demo-version"><span>⌁</span><div><small>{t('Version {version}', { version: 2 })}</small><strong>{t('An idea continued')}</strong></div></div>
          </div>}
        </section>
        <section className="feature-strip" id="how">
          <article><b>01</b><span>{t('Send It Like a Message')}</span><p>{t('Text, images, and canvases share one conversation timeline.')}</p></article>
          <article><b>02</b><span>{t('Continue, Never Overwrite')}</span><p>{t('Every edit creates a clearly tracked version.')}</p></article>
          <article><b>03</b><span>{t('Privacy That Fits')}</span><p>{t('Accounts keep content long term; guest access ends with the session.')}</p></article>
        </section>
        <AppDialog open={guestModal} onClose={() => { setGuestModal(false); if (!guestRecovery) setPendingLandingSketch(null); setGuestFormError(''); setGuestErrorField(null); setGuestRecovery(null); }} labelledBy="guest-dialog-title" describedBy="guest-dialog-description">
            <form className="dialog-card guest-dialog" onSubmit={startGuest} noValidate>
              <button type="button" className="dialog-close" onClick={() => { setGuestModal(false); if (!guestRecovery) setPendingLandingSketch(null); setGuestFormError(''); setGuestErrorField(null); setGuestRecovery(null); }} aria-label={t('Close')} data-tooltip={t('Close')} data-tooltip-placement="below"><UiIcon name="close" size={18} /></button>
              <span className="eyebrow">{t('Guest Session')}</span><h2 id="guest-dialog-title">{t('What Should We Call You?')}</h2>
              <p id="guest-dialog-description">{t('Choose a name so people can recognize you in the conversation.')}</p>
              {pendingLandingSketch ? <figure className="guest-mark-preview"><Image src={pendingLandingSketch} width={900} height={540} unoptimized alt={t('Preview of your first mark')} /><figcaption><UiIcon name="draw" size={16} /><span><strong>{t('Your first mark is ready')}</strong><small>{t('Choose a name, then continue it in Studio.')}</small></span></figcaption></figure> : null}
              <label>{t('Display Name')}<input ref={guestNameRef} name="guest-name" autoComplete="nickname" value={guestName} onChange={(event) => { setGuestName(event.target.value); setGuestFormError(''); setGuestErrorField(null); setGuestRecovery(null); }} placeholder={t('For example, Alex…')} maxLength={60} aria-invalid={guestErrorField === 'name'} aria-describedby={guestErrorField === 'name' ? 'guest-form-error' : undefined} /></label>
              {guestFormError && <p id="guest-form-error" className="form-error" role="alert" aria-live="polite">{guestFormError}</p>}
              {guestRecovery ? <GuestRecoveryPanel recovery={guestRecovery} hasDrawing={Boolean(pendingLandingSketch)} onKeepDrawing={() => { setGuestModal(false); setGuestRecovery(null); setGuestErrorField(null); requestAnimationFrame(() => document.getElementById('landing-doodle')?.focus()); }} /> : null}
              <div className="guest-session-note"><UiIcon name="info" size={17} /><span>{t('The session expires after 2 inactive hours. Content you send remains in the room.')}</span></div>
              <button type="submit" className="primary-button wide" disabled={busy}>{busy ? t('Opening Nét…') : guestRecovery ? t('Try Again') : t('Enter Nét')}</button>
            </form>
        </AppDialog>
        {(error || notice) && <div className={error ? 'toast error' : 'toast'} role="status" aria-live="polite"><span>{error || notice}</span>{error && <button type="button" onClick={() => setError('')} aria-label={t('Dismiss notification')} data-tooltip={t('Dismiss notification')} data-tooltip-placement="above">×</button>}</div>}
      </main></>
    );
  }

  return (
    <><a className="skip-link" href="#main-content">{t('Skip to main content')}</a><div className="product-root">
      <button type="button" className={sidebarOpen ? 'sidebar-scrim show' : 'sidebar-scrim'} onClick={() => setSidebarOpen(false)} aria-label={t('Close conversation list')} />
      <aside className={sidebarOpen ? 'product-sidebar open' : 'product-sidebar'}>
        <div className="sidebar-head"><Logo compact /><LanguageSwitcher compact /><button type="button" className="mobile-close" onClick={() => setSidebarOpen(false)} aria-label={t('Close list')} data-tooltip={t('Close list')} data-tooltip-placement="below">×</button></div>
        {actor?.kind === 'user' && <button type="button" className="new-conversation-button" onClick={() => openConversationStarter()}><span><UiIcon name="message" /></span>{t('New Conversation')}<UiIcon name="plus" size={18} /></button>}
        <label className="product-search"><UiIcon name="search" size={17} /><input name="room-search" type="search" autoComplete="off" value={roomQuery} onChange={(event) => setRoomQuery(event.target.value)} placeholder={t('Search conversations…')} aria-label={t('Search conversations')} /></label>
        <div className="sidebar-label"><span>{t('Recent')}</span><small>{t('{count} conversations', { count: rooms.length })}</small></div>
        <div className="room-list">
          {filteredRooms.map((room) => <div key={room.id} className={room.id === activeRoomId ? 'room-item-row active' : 'room-item-row'}><button type="button" className="room-item" onClick={() => selectRoom(room.id)}><span className="avatar" style={avatarStyle(room.name)}>{room.name.slice(0, 1)}</span><span><strong>{room.name}</strong><small>{room.preview}</small></span><span className="room-meta"><time>{timeLabel(room.lastActivity, locale)}</time>{room.unreadCount > 0 ? <b aria-label={t('{count} unread messages', { count: room.unreadCount })}>{Math.min(room.unreadCount, 99)}</b> : null}</span></button>{room.pendingRequestCount > 0 ? <button type="button" className="room-request-shortcut" aria-label={t('Open {count} join requests for {room}', { count: room.pendingRequestCount, room: room.name })} onClick={() => { selectRoom(room.id); setSidebarOpen(false); void openPeopleSafety('requests', room.id, guestRequestHighlightByRoomRef.current.get(room.id)); }}><UiIcon name="group" size={15} /><span>{Math.min(room.pendingRequestCount, 99)}</span></button> : null}</div>)}
          {!filteredRooms.length && !roomQuery.trim() && <p className="empty-copy">{t('No conversations yet.')}</p>}
          {!filteredRooms.length && roomQuery.trim() && <p className="empty-copy">{t('No conversations found. Start a new conversation to find people.')}</p>}
        </div>
        {actor?.kind === 'guest' && <div className="guest-retention"><span>{t('Temporary Session')}</span><p>{t('You lose access when it ends. Messages and attached images remain in the room.')}</p></div>}
        <div className="account-card"><span className="avatar" style={avatarStyle(actor?.id ?? 'guest')}>{actor?.displayName.slice(0, 1)}</span><span><strong>{actor?.displayName}</strong><small>{actor?.kind === 'user' ? actor.email : t('Guest · up to 2 hours')}</small></span>{actor?.kind === 'user' ? <a href={signOutPath} aria-label={t('Sign Out')} data-tooltip={t('Sign Out')} data-tooltip-placement="above"><UiIcon name="external" size={18} /></a> : <button type="button" className="end-session-button" data-end-guest="true" onClick={() => setGuestEndConfirmOpen(true)} aria-label={t('End guest session')}>{t('End Session')}</button>}</div>
      </aside>

      <main id="main-content" className="conversation-panel">
        {activeRoom ? (
          <>
            <header className="conversation-header">
              <button type="button" className="mobile-menu" onClick={() => setSidebarOpen(true)} aria-label={t('Open conversation list')} data-tooltip={t('Conversation list')} data-tooltip-placement="below"><UiIcon name="menu" size={19} /></button>
              <button type="button" className="conversation-identity" onClick={() => { setMobileHeaderMenuOpen(false); setInfoOpen(true); }} aria-label={t('Open details for {room}', { room: activeRoom.name })}>
                <span className="avatar" style={avatarStyle(activeRoom.name)}>{activeRoom.name.slice(0, 1)}</span>
                <span className="conversation-title"><strong>{activeRoom.name}</strong><small><i className={realtimeConnected && networkOnline && !activePendingMessages.length ? '' : 'offline'} /> {activePendingMessages.length ? networkOnline ? outboxRetrying ? t('Sending {count} waiting items…', { count: activePendingMessages.length }) : t('Couldn’t send · {count} items waiting', { count: activePendingMessages.length }) : t('Offline · {count} items waiting', { count: activePendingMessages.length }) : networkOnline ? realtimeConnected ? t('Synced just now') : t('Reconnecting…') : t('Offline')}</small></span>
              </button>
              <div className="conversation-actions">
                {activeRoom.kind !== 'direct' && <button type="button" className={showInviteOnboarding ? 'invite-header-action contextual' : 'invite-header-action'} onClick={() => void copyInvite()} aria-label={t('Copy invite link')} data-tooltip={t('Invite by Link')} data-tooltip-placement="below"><UiIcon name="link" size={17} /><span>{t('Invite')}</span></button>}
                {installPrompt && <button type="button" className="install-header-action" onClick={() => { void installPrompt.prompt(); setInstallPrompt(null); }} aria-label={t('Install App')} data-tooltip={t('Install App')} data-tooltip-placement="below"><UiIcon name="install" size={18} /></button>}
                <button type="button" className="desktop-header-action" onClick={() => setMessageQuery((value) => value ? '' : ' ')} aria-label={t('Search messages')} data-tooltip={t('Search Messages')} data-tooltip-placement="below"><UiIcon name="search" size={18} /></button>
                {activeRoom.pendingRequestCount > 0 ? <button type="button" className="request-queue-action request-aware-action" onClick={() => void openPeopleSafety('requests', activeRoom.id, guestRequestHighlightByRoomRef.current.get(activeRoom.id))} aria-label={t('Open {count} join requests', { count: activeRoom.pendingRequestCount })} data-tooltip={t('Join Requests')} data-tooltip-placement="below"><UiIcon name="group" size={17} /><span className="header-request-badge" aria-hidden="true">{Math.min(activeRoom.pendingRequestCount, 99)}</span></button> : null}
                <button type="button" className="desktop-header-action" onClick={() => setInfoOpen((value) => !value)} aria-label={t('Conversation details')} data-tooltip={t('Details')} data-tooltip-placement="below"><UiIcon name="info" size={18} /></button>
                <button ref={mobileHeaderMenuTriggerRef} type="button" className="mobile-header-overflow-trigger" onClick={() => setMobileHeaderMenuOpen((value) => !value)} aria-label={t('More conversation actions')} aria-expanded={mobileHeaderMenuOpen} aria-controls="mobile-header-actions"><UiIcon name="more" size={20} /></button>
              </div>
              {mobileHeaderMenuOpen ? <div ref={mobileHeaderActionsRef} id="mobile-header-actions" className="mobile-header-actions" role="group" aria-label={t('More conversation actions')}>
                <button type="button" onClick={() => { setMobileHeaderMenuOpen(false); setMessageQuery((value) => value ? '' : ' '); }}><UiIcon name="search" size={18} /> {t('Search Messages')}</button>
                <button type="button" onClick={() => { setMobileHeaderMenuOpen(false); setInfoOpen(true); }}><UiIcon name="info" size={18} /> {t('Conversation details')}</button>
                {activeRoom.kind !== 'direct' && !showInviteOnboarding ? <button type="button" onClick={() => { setMobileHeaderMenuOpen(false); void copyInvite(); }}><UiIcon name="link" size={18} /> {t('Invite by Link')}</button> : null}
              </div> : null}
            </header>
            {messageQuery !== '' && <div className="message-search"><div className="message-search-field"><span aria-hidden="true"><UiIcon name="search" size={18} /></span><input name="message-search" type="search" autoComplete="off" value={messageQuery.trimStart()} onChange={(event) => setMessageQuery(event.target.value || ' ')} placeholder={t('Search content or sender…')} aria-label={t('Search message content')} aria-describedby="message-search-status" /><button type="button" onClick={() => setMessageQuery('')} aria-label={t('Close search')} data-tooltip={t('Close Search')}><UiIcon name="close" size={17} /></button></div><small id="message-search-status" role="status" aria-live="polite">{messageSearchLoading ? t('Searching…') : normalizedMessageQuery.length === 1 ? t('Enter 1 more character') : normalizedMessageQuery ? t('{count} results across full history', { count: messageSearchTotal }) : t('Search this conversation')}</small></div>}
            <section ref={messageScrollRef} className="message-scroll" aria-label={t('Message history')}>
              <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">{historyAnnouncement}</span>
              <div className="message-lane">
                {nextCursor && !normalizedMessageQuery && <button type="button" className="load-older" onClick={() => void loadOlder()} disabled={loadingOlder}>{loadingOlder ? t('Loading…') : t('Load Older Messages')}</button>}
                {showInviteOnboarding ? <section className="invite-onboarding room-seed-card" aria-labelledby="invite-onboarding-title"><span className="invite-onboarding-icon" aria-hidden="true"><UiIcon name="draw" size={22} /></span><div><h2 id="invite-onboarding-title">{t('Nothing Here Yet')}</h2><p>{t('Draw the first line, write a thought, or invite someone.')}</p></div><div className="invite-onboarding-actions"><button type="button" className="primary-button" onClick={() => openStudio({})}><UiIcon name="draw" size={17} /> {t('Draw the First Line')}</button>{activeRoom.allowGuests ? <button type="button" className="secondary-button" onClick={() => void copyInvite()}><UiIcon name="link" size={17} /> {t('Invite Someone')}</button> : null}</div></section> : null}
                {!visibleMessages.length && !showInviteOnboarding && <div className="conversation-empty"><span aria-hidden="true"><UiIcon name="draw" size={28} /></span><h2>{normalizedMessageQuery ? t('No Messages Found') : t('Start with a Word or a Line')}</h2><p>{normalizedMessageQuery.length === 1 ? t('Enter at least 2 characters to search the full history.') : normalizedMessageQuery ? t('Try another keyword.') : t('Send a message, share an image, or open the canvas.')}</p></div>}
                {visibleMessages.map((message, index) => {
                  const previousMessage = visibleMessages[index - 1];
                  const showDay = !previousMessage || messageDayKey(previousMessage.createdAt) !== messageDayKey(message.createdAt);
                  const leading = <>{showDay ? <div className="day-pill sticky-day">{messageDayLabel(message.createdAt, locale, t)}</div> : null}{!normalizedMessageQuery && firstUnreadSequence === message.sequence ? <div className="unread-divider" role="separator"><span>{t('{count} new messages', { count: activeRoom.unreadCount })}</span></div> : null}</>;
                  const own = actor?.kind === 'user' ? message.senderId === actor.id : message.guestSessionId === actor?.id;
                  const isDeleted = Boolean(message.deletedAt);
                  const blocked = Boolean(message.blockedAuthor && !revealedBlockedMessages.has(message.id));
                  const replied = message.replyToId ? messages.find((item) => item.id === message.replyToId) : null;
                  const visualParent = message.canvasParentId ? canvasLineageMeta.byId.get(message.canvasParentId) : null;
                  const continuationCount = message.continuationCount ?? 0;
                  if (message.type === 'system') return <Fragment key={message.id}>{leading}<div className="system-message">{t(systemMessageKey(message.body))}</div></Fragment>;
                  return (
                    <Fragment key={message.id}>{leading}<article className={own ? 'message-row own' : 'message-row'}>
                      {!own && <span className="avatar message-avatar" style={avatarStyle(message.senderName)}>{message.senderName.slice(0, 1)}</span>}
                      <div className="message-content">
                        {!own && <small className="sender-name">{message.senderName}</small>}
                        {replied && !blocked && <button type="button" className="reply-context" onClick={() => document.getElementById(`message-${replied.id}`)?.scrollIntoView({ block: 'center' })}><strong>{replied.senderName}</strong><span>{replied.body || (replied.type === 'canvas' ? t('Drawing') : t('Image'))}</span></button>}
                        <div id={`message-${message.id}`} className="message-payload">
                          {blocked ? <div className="blocked-message"><UiIcon name="lock" size={17} /><span><strong>{t('Content from a blocked member is hidden')}</strong><small>{t('Interactions and notifications from this member are suppressed.')}</small></span><button type="button" onClick={() => { setRevealedBlockedMessages((current) => new Set(current).add(message.id)); if (message.assetKey) void refreshAssetUrl(message.assetKey); }}>{t('Show Once')}</button></div> : null}
                          {isDeleted ? <div className="message-tombstone"><UiIcon name="info" size={17} /><span>{message.type === 'canvas' || message.type === 'image' ? t('Original removed by its creator') : t('Message removed by its creator')}</span></div> : null}
                          {!blocked && !isDeleted && message.assetUrl && <button type="button" className="message-media-button" onClick={() => setViewingMedia(message)} aria-label={message.type === 'canvas' ? t('Open drawing version {version}', { version: message.canvasVersion ?? 1 }) : t('Open image full screen')} data-tooltip={t('View Full Screen')} data-tooltip-placement="above">
                            {/* Assets use a short-lived, room-scoped signed URL so a plain img request can load them. */}
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img src={message.assetUrl} width="1200" height="720" loading="lazy" decoding="async" alt={message.imageDescription || (message.type === 'canvas' ? t('Drawing version {version} by {name}', { version: message.canvasVersion ?? 1, name: message.senderName }) : t('Photo shared by {name}', { name: message.senderName }))} onLoad={() => { if (message.assetKey) automaticAssetRefreshAttempts.current.delete(message.assetKey); }} onError={() => { if (message.assetKey) void refreshAssetUrl(message.assetKey, true); }} />
                            <span className="media-open-hint" aria-hidden="true"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5" /></svg></span>
                          </button>}
                          {!blocked && !isDeleted && message.type === 'canvas' && <span className="version-badge">{t('Version {version}', { version: message.canvasVersion ?? 1 })}</span>}
                          {!blocked && !isDeleted && message.body && <div className="message-bubble">{message.body}</div>}
                        </div>
                        {!blocked && (message.type === 'canvas' || (message.type === 'image' && message.imagePurpose !== 'reference')) && <>
                          <button type="button" className="inline-lineage-context" onClick={() => void loadDrawingLineage(message.id)}><UiIcon name="history" size={15} /><span>{message.type === 'image' ? t('Source Photo') : message.lineageRoot?.type === 'image' ? t('Based on {name}’s photo', { name: message.lineageRoot.senderName }) : visualParent ? t('Based on {name}’s drawing', { name: visualParent.senderName }) : message.canvasParentId ? t('Based on an earlier visual') : t('Original drawing')}</span>{continuationCount > 0 ? <strong>{t('{count} continuations', { count: continuationCount })}</strong> : null}</button>
                          <div className="canvas-loop-actions">{!isDeleted ? <button type="button" className="continue-drawing-cta" onClick={() => void continueDrawing(message)}><UiIcon name="draw" size={17} /><span><strong>{message.type === 'image' ? t('Continue with This Photo') : t('Continue This Drawing')}</strong><small>{message.type === 'image' ? t('Create a new visual direction without changing the original') : t('Create version {version} without changing the original', { version: (message.canvasVersion ?? 1) + 1 })}</small></span><UiIcon name="arrow" size={16} /></button> : null}<button type="button" className="drawing-history-cta" onClick={() => void loadDrawingLineage(message.id)}><UiIcon name="history" size={17} /><span>{continuationCount > 0 ? t('Compare Versions') : t('View Version History')}</span></button></div>
                        </>}
                        <div className="message-meta"><time>{timeLabel(message.createdAt, locale)}</time>{message.editedAt && !isDeleted ? <span>{t('Edited')}</span> : null}{own && <span>{message.readCount > 0 ? t('Read') : t('Sent')}</span>}</div>
                        {!blocked && <div className="reaction-list">{message.reactions.map((reaction) => <button type="button" key={reaction.emoji} className={reaction.reacted ? 'reacted' : ''} onClick={() => void react(message.id, reaction.emoji)} aria-label={reaction.reacted ? t('Remove {emoji} reaction, {count} total', { emoji: reaction.emoji, count: reaction.count }) : t('Add {emoji} reaction, {count} total', { emoji: reaction.emoji, count: reaction.count })}>{reaction.emoji} <span>{reaction.count}</span></button>)}</div>}
                        {!isDeleted ? <div className="message-tools"><button type="button" onClick={() => setReplyTo(message)}><UiIcon name="reply" size={16} /> <span>{t('Reply')}</span></button>{message.assetUrl && <button type="button" onClick={() => void downloadMedia(message)} disabled={downloadingAssetKey === (message.assetKey ?? message.id)} aria-label={downloadingAssetKey === (message.assetKey ?? message.id) ? t('Downloading image') : t('Download image')} data-tooltip={downloadingAssetKey === (message.assetKey ?? message.id) ? t('Downloading…') : t('Download Image')} data-tooltip-placement="above"><UiIcon name="download" size={16} /> <span>{downloadingAssetKey === (message.assetKey ?? message.id) ? t('Downloading…') : t('Download')}</span></button>}{!own ? <button type="button" onClick={() => { setReportMessage(message); setReportOpen(true); }}>{t('Report')}</button> : null}{own ? <><button type="button" onClick={() => { setEditingMessage(message); setEditingText(message.body ?? ''); }}>{t('Edit')}</button><button type="button" onClick={() => setDeletingMessage(message)}>{t('Delete')}</button></> : null}<div>{EMOJIS.map((emoji) => <button type="button" key={emoji} onClick={() => void react(message.id, emoji)} aria-label={t('Add {emoji} reaction', { emoji })} data-tooltip={t('Add {emoji}', { emoji })}>{emoji}</button>)}</div></div> : null}
                        {!isDeleted ? <details className="message-overflow"><summary aria-label={t('More actions for this message')}>•••</summary><div><button type="button" onClick={() => setReplyTo(message)}><UiIcon name="reply" size={16} /> {t('Reply')}</button>{message.assetUrl && <button type="button" onClick={() => void downloadMedia(message)} disabled={downloadingAssetKey === (message.assetKey ?? message.id)}><UiIcon name="download" size={16} /> {t('Download')}</button>}{!own ? <button type="button" onClick={() => { setReportMessage(message); setReportOpen(true); }}>{t('Report')}</button> : null}{own ? <><button type="button" onClick={() => { setEditingMessage(message); setEditingText(message.body ?? ''); }}>{t('Edit')}</button><button type="button" className="destructive-action" onClick={() => setDeletingMessage(message)}>{t('Delete')}</button></> : null}<span>{EMOJIS.map((emoji) => <button type="button" key={emoji} onClick={() => void react(message.id, emoji)} aria-label={t('Add {emoji} reaction', { emoji })}>{emoji}</button>)}</span></div></details> : null}
                      </div>
                    </article></Fragment>
                  );
                })}
                <div ref={endRef} />
              </div>
            </section>
            {!viewingLatest && !normalizedMessageQuery ? <button type="button" className="jump-latest" onClick={() => void jumpToLatest()}>{t('Jump to latest')} <UiIcon name="arrow" size={16} /></button> : null}
            <footer className="composer-zone">
              {showGuestConversion && <div className="guest-conversion"><span><UiIcon name="lock" size={17} /><span><strong>{t('Keep this room and your drawing history')}</strong><small>{t('Create an account after contributing so you can return anytime.')}</small></span></span><a href={guestConversionPath}>{t('Keep My Work')} <UiIcon name="arrow" size={15} /></a></div>}
              {activePendingMessages.length > 0 && <section className="message-outbox" aria-label={t('Sending Outbox')}>
                <span className="sr-only" role="status" aria-live="polite">{t('{count} items are waiting to send.', { count: activePendingMessages.length })}</span>
                <header>
                  <button type="button" className="outbox-summary" onClick={() => setOutboxExpanded((value) => !value)} aria-expanded={outboxExpanded} aria-controls="active-message-outbox"><UiIcon name="message" size={18} /><span><strong>{outboxRetrying ? t('Sending waiting messages…') : networkOnline ? t('Couldn’t Send Yet') : t('Waiting for Connection')}</strong><small>{outboxPersistenceFailed ? t('Keep this tab open — this queue could not be saved on your device.') : t('{count} items are saved on this device.', { count: activePendingMessages.length })}</small></span><UiIcon name="arrow" size={16} /></button>
                  <button type="button" onClick={() => void retryPendingMessages(activeRoomId)} disabled={!networkOnline || outboxRetrying || activePendingMessages.every((message) => message.status === 'blocked')}>{outboxRetrying ? t('Sending…') : t('Retry All')}</button>
                </header>
                {outboxExpanded ? <ol id="active-message-outbox" className="outbox-items">
                  {activePendingMessages.map((pending) => {
                    const typeLabel = t(pending.type === 'text' ? 'Text Message' : pending.type === 'image' ? 'Photo' : 'Drawing');
                    const preview = pending.text || pending.fileName || typeLabel;
                    const statusLabel = pending.status === 'sending' ? t('Sending…') : pending.status === 'blocked' ? t('Needs Attention') : pending.status === 'failed' ? t('Ready to Retry') : networkOnline ? t('Ready to Send') : t('Waiting for Connection');
                    return <li key={pending.id} className={pending.status === 'blocked' ? 'blocked' : ''}><div className="outbox-item-copy"><span><strong>{typeLabel}</strong><time>{timeLabel(pending.createdAt, locale)}</time></span><p>{preview}</p><small><b>{statusLabel}</b>{pending.error ? ` · ${pending.error}` : ''}</small></div><div className="outbox-item-actions">{pending.type === 'text' ? <><button type="button" onClick={() => editPendingMessage(pending)}>{t('Edit')}</button><button type="button" onClick={() => void copyPendingMessage(pending)}>{t('Copy')}</button></> : <><button type="button" onClick={() => void previewPendingMedia(pending)}>{t('Preview')}</button><button type="button" onClick={() => void savePendingMedia(pending)}>{t('Save to Device')}</button><button type="button" onClick={() => { setReplacePendingId(pending.id); replaceFileRef.current?.click(); }}>{t('Replace File')}</button></>}<button type="button" onClick={() => void retryPendingMessages(activeRoomId, pending.id)} disabled={!networkOnline || outboxRetrying}>{t('Send Again')}</button><button type="button" onClick={() => setPendingRemoval(pending)} disabled={outboxRetrying}>{t('Remove')}</button></div></li>;
                  })}
                </ol> : null}
              </section>}
              {replyTo && <div className="reply-draft"><span>{t('Replying to')} <strong>{replyTo.senderName}</strong><small>{replyTo.body || (replyTo.type === 'canvas' ? t('Drawing') : t('Image'))}</small></span><button type="button" onClick={() => setReplyTo(null)} aria-label={t('Cancel reply')} data-tooltip={t('Cancel Reply')} data-tooltip-placement="above">×</button></div>}
              <div className="composer-modes" role="toolbar" aria-label={t('Reply with text, drawing, or photo')}><button type="button" onClick={() => messageInputRef.current?.focus()}><UiIcon name="message" size={17} /> {t('Text')}</button><button type="button" className="draw-mode" onClick={() => openStudio({})} disabled={busy}><UiIcon name="draw" size={17} /> {t('Draw')}</button><button type="button" onClick={() => fileRef.current?.click()} disabled={busy}><UiIcon name="plus" size={17} /> {t('Photo')}</button></div>
              <div className="composer"><textarea ref={messageInputRef} name="message" autoComplete="off" value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void submitText(); } }} placeholder={t('Write a message…')} maxLength={2000} aria-label={t('Message content')} /><button type="button" className="send-button" onClick={() => void submitText()} disabled={busy || !draft.trim()} aria-label={t('Send message')} data-tooltip={t('Send Message')} data-tooltip-placement="above"><UiIcon name="send" size={18} /></button></div>
              <input ref={fileRef} hidden name="message-image" aria-label={t('Image file')} type="file" accept="image/png,image/jpeg,image/gif,image/webp" onChange={(event) => void attachImage(event)} />
              <input ref={replaceFileRef} hidden name="replace-outbox-image" aria-label={t('Replacement image file')} type="file" accept="image/png,image/jpeg,image/gif,image/webp" onChange={(event) => void replacePendingMedia(event)} />
              <p><kbd>Enter</kbd> {t('send')} · <kbd>Shift</kbd> + <kbd>Enter</kbd> {t('new line')} · {t('images up to 8 MB')}</p>
            </footer>
            <AppDialog open={infoOpen} onClose={() => setInfoOpen(false)} labelledBy="conversation-details-title" describedBy="conversation-details-description" className="details-backdrop"><aside className="info-drawer"><button type="button" className="dialog-close" onClick={() => setInfoOpen(false)} aria-label={t('Close')} data-tooltip={t('Close')} data-tooltip-placement="below"><UiIcon name="close" size={18} /></button><header className="info-identity"><span className="avatar info-avatar" style={avatarStyle(activeRoom.name)}>{activeRoom.name.slice(0, 1)}</span><div><h2 id="conversation-details-title">{activeRoom.name}</h2><p id="conversation-details-description">{t('A space to continue ideas with words and drawings.')}</p></div></header><div className="info-stats"><span><strong>{activeRoom.messageCount ?? messages.length}</strong><small>{t('Messages')}</small></span><span><strong>{activeRoom.mediaCount ?? messages.filter((item) => item.assetKey).length}</strong><small>{t('Images & Drawings')}</small></span></div>{activeRoom.kind !== 'direct' && <section className="info-section"><h3>{t('Invite Link')}</h3>{activeRoom.inviteActive ? <><label className="sr-only" htmlFor="conversation-invite-link">{t('Invite Link')}</label><input id="conversation-invite-link" name="invite-link" readOnly value={`${typeof window !== 'undefined' ? window.location.origin : ''}/?room=${activeRoom.inviteCode}`} /><button type="button" className="primary-button wide" onClick={() => void copyInvite()}>{t('Copy Invite Link')}</button></> : <div className="invite-revoked-state"><UiIcon name="link" size={20} /><div><strong>{t('Invite Revoked')}</strong><small>{t('This old link cannot admit anyone. Create a new invite from Access settings.')}</small></div><button type="button" onClick={() => void openPeopleSafety('access')}>{t('Open Access Settings')}</button></div>}</section>}<section className="info-section info-safety"><h3>{t('People & Safety')}</h3><button type="button" className="secondary-button wide people-safety-entry" onClick={() => void openPeopleSafety()}><UiIcon name="group" size={18} /> {t('Manage People & Safety')}{activeRoom.pendingRequestCount ? <span>{t('{count} requests', { count: activeRoom.pendingRequestCount })}</span> : null}</button><small className="privacy-note"><UiIcon name="lock" size={15} /> {t('Signed-in members keep access long term. Guest messages and attached images remain after they leave.')}</small></section></aside></AppDialog>
          </>
        ) : <div className="no-room"><Logo /><h1>{t('No Conversations Yet')}</h1><p>{actor?.kind === 'user' ? t('Find someone to message or create a new group.') : t('This invite link is no longer active.')}</p>{actor?.kind === 'user' && <button type="button" className="primary-button" onClick={() => openConversationStarter()}>{t('Start a Conversation')}</button>}</div>}
      </main>

      <AppDialog open={createRoomOpen} onClose={resetConversationStarter} labelledBy="create-room-title" describedBy="create-room-description">
        <section className="dialog-card conversation-starter">
          <button type="button" className="dialog-close" onClick={resetConversationStarter} aria-label={t('Close')} data-tooltip={t('Close')} data-tooltip-placement="below"><UiIcon name="close" size={18} /></button>
          <span className="eyebrow">{t('Quick Connect')}</span>
          <h2 id="create-room-title">{t('Start a Conversation')}</h2>
          <p id="create-room-description">{t('Choose people first. One person starts a direct chat; two or more creates a group.')}</p>

          <form className="people-picker" onSubmit={createConversation}>
            <label>{t('Who do you want to create with?')}<div className="starter-search"><UiIcon name="search" /><input name="contact-search" type="search" autoComplete="off" value={contactQuery} onChange={(event) => { const value = event.target.value; setContactQuery(value); setContactResults([]); setContactSearching(value.trim().length >= 2); setConversationStartError(''); }} placeholder={t('Enter a name or email…')} aria-describedby="people-search-status" /></div></label>
            <div id="people-search-status" className="search-status" role="status" aria-live="polite">{contactSearching ? t('Searching…') : contactQuery.trim().length === 1 ? t('Enter 1 more character') : contactQuery.trim().length >= 2 ? t('{count} matching people', { count: contactResults.length }) : t('Select one or more people. Nét chooses the conversation type for you.')}</div>
            {selectedContacts.length > 0 && <div className="selected-contacts" aria-label={t('Selected members')}>{selectedContacts.map((contact) => <button type="button" key={contact.id} aria-label={t('Remove {name}', { name: contact.displayName })} onClick={() => setSelectedContacts((current) => current.filter((item) => item.id !== contact.id))}>{contact.displayName}<span aria-hidden="true">×</span></button>)}</div>}
            {contactQuery.trim().length >= 2 && <div className="contact-results">{contactResults.map((contact) => { const selected = selectedContactIds.has(contact.id); return <button type="button" key={contact.id} className={selected ? 'selected' : ''} disabled={busy} aria-pressed={selected} onClick={() => setSelectedContacts((current) => selected ? current.filter((item) => item.id !== contact.id) : [...current, contact])}><span className="avatar" style={{ '--avatar': contact.avatarColor } as CSSProperties}>{contact.displayName.slice(0, 1)}</span><span><strong>{contact.displayName}</strong><small>{contact.email}</small></span><span className="result-action">{selected ? t('Selected') : t('Select')} <UiIcon name={selected ? 'check' : 'plus'} size={16} /></span></button>; })}{!contactSearching && contactResults.length === 0 && <div className="contact-empty"><UiIcon name="search" /><strong>{t('No Person Found')}</strong><small>{t('Try another name or email.')}</small></div>}</div>}
            {conversationStartError && <p className="form-error" role="alert">{conversationStartError}</p>}
            {selectedContacts.length === 1 && <button type="submit" className="primary-button wide conversation-create-action" disabled={busy}>{busy ? t('Opening conversation…') : t('Message {name}', { name: selectedContacts[0].displayName })}</button>}
            {selectedContacts.length > 1 && <div className="group-options"><label>{t('Group Name')} <small>{t('(optional)')}</small><input name="room-name" autoComplete="off" value={roomName} onChange={(event) => setRoomName(event.target.value)} placeholder={t('Nét will suggest one from the members')} maxLength={60} /></label><label className="checkbox-row"><input type="checkbox" name="allow-guests" checked={allowGuests} onChange={(event) => setAllowGuests(event.target.checked)} /><span><strong>{t('Allow guests to join by link')}</strong><small>{t('Content sent by guests remains after they leave the session.')}</small></span></label><button type="submit" className="primary-button wide" disabled={busy}>{busy ? t('Creating group…') : t('Create Group{members}', { members: ` · ${selectedContacts.length + 1} ${t('people')}` })}</button></div>}
          </form>
        </section>
      </AppDialog>
      <AppDialog open={Boolean(photoDraft)} onClose={closePhotoDraft} labelledBy="photo-preparation-title" describedBy="photo-preparation-description" className="photo-workspace-backdrop">
        <section className="dialog-card photo-preparation-dialog">
          <div className="photo-preparation-content">
          <button type="button" className="dialog-close" onClick={closePhotoDraft} aria-label={t('Close')}><UiIcon name="close" size={18} /></button>
          <h2 id="photo-preparation-title">{t('Prepare Photo')}</h2>
          <p id="photo-preparation-description">{t('Keep the artwork visible while choosing how teammates can use it.')}</p>
          {photoDraft ? <>
            <ol className="photo-progress" aria-label={t('Photo preparation progress')}><li className={photoStep === 1 ? 'active' : 'complete'}><span>1</span><strong>{t('Frame')}</strong></li><li className={photoStep === 2 ? 'active' : ''}><span>2</span><strong>{t('Share')}</strong></li></ol>
            {photoStep === 1 ? <>
              <div className="photo-step-heading"><strong>{t('Frame')}</strong><small>{t('Rotate or crop the photo.')}</small></div>
              <div className={`photo-stage crop-${photoDraft.crop}`}>
                {/* Local object URLs are intentionally previewed without optimization. */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={photoDraft.url} alt="" style={{ transform: `rotate(${photoDraft.rotation}deg)` }} />
              </div>
              <div className="photo-edit-controls" role="group" aria-label={t('Photo framing controls')}>
                <button type="button" onClick={() => setPhotoDraft((current) => current ? { ...current, rotation: ((current.rotation + 270) % 360) as 0 | 90 | 180 | 270 } : current)}>{t('Rotate Left')}</button>
                <button type="button" onClick={() => setPhotoDraft((current) => current ? { ...current, rotation: ((current.rotation + 90) % 360) as 0 | 90 | 180 | 270 } : current)}>{t('Rotate Right')}</button>
                <label>{t('Crop')}<select value={photoDraft.crop} onChange={(event) => setPhotoDraft((current) => current ? { ...current, crop: event.target.value as PhotoCrop } : current)}><option value="original">{t('Original')}</option><option value="square">{t('Square')}</option><option value="landscape">{t('Landscape')}</option><option value="portrait">{t('Portrait')}</option></select></label>
              </div>
            </> : <>
              <div className="photo-step-heading"><strong>{t('Share')}</strong><small>{t('Choose whether this starts a visual branch.')}</small></div>
              <figure className={`photo-share-preview crop-${photoDraft.crop}`}>
                {/* Local object URLs cannot be delegated to the Next image optimizer. */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={photoDraft.url} alt="" style={{ transform: `rotate(${photoDraft.rotation}deg)` }} /><figcaption>{photoDraft.file.name}</figcaption>
              </figure>
              <fieldset className="photo-purpose"><legend>{t('How should the team use this photo?')}</legend><label><input type="radio" name="photo-purpose" value="creative" checked={photoDraft.purpose === 'creative'} onChange={() => setPhotoDraft((current) => current ? { ...current, purpose: 'creative' } : current)} /><span><strong>{t('Use as Creative Source')}</strong><small>{t('Recommended · teammates can continue it as a new branch.')}</small></span></label><label><input type="radio" name="photo-purpose" value="reference" checked={photoDraft.purpose === 'reference'} onChange={() => setPhotoDraft((current) => current ? { ...current, purpose: 'reference' } : current)} /><span><strong>{t('Attach as Reference')}</strong><small>{t('Share it for context without starting a visual branch.')}</small></span></label></fieldset>
              <details className="photo-details"><summary>{t('Details & Accessibility')} <span>{t('Optional')}</span></summary><div><label>{t('What should the team explore?')}<textarea value={photoDraft.prompt} onChange={(event) => setPhotoDraft((current) => current ? { ...current, prompt: event.target.value } : current)} maxLength={2000} placeholder={t('Example: explore a softer shape and warmer color palette…')} /></label><label>{t('Accessible Image Description')}<textarea value={photoDraft.description} onChange={(event) => setPhotoDraft((current) => current ? { ...current, description: event.target.value } : current)} maxLength={500} placeholder={t('Describe the important visual content for people who cannot see it.')} /></label></div></details>
            </>}
          </> : null}
          </div>
          {photoDraft ? <div className="confirmation-actions photo-send-actions">{photoStep === 1 ? <><button type="button" onClick={closePhotoDraft}>{t('Cancel')}</button><button type="button" className="primary-button" onClick={() => setPhotoStep(2)}>{t('Next: Share')}</button></> : <><button type="button" onClick={() => setPhotoStep(1)}>{t('Back to Frame')}</button><button type="button" className="primary-button" onClick={() => void sendPreparedPhoto()} disabled={busy}>{busy ? t('Preparing…') : t('Send Photo')}</button></>}</div> : null}
        </section>
      </AppDialog>
      <AppDialog open={peopleSafetyOpen} onClose={() => { setPeopleSafetyOpen(false); setReportOpen(false); setReportTarget(null); }} labelledBy="people-safety-title" describedBy="people-safety-description" className="management-backdrop">
        <section className="dialog-card people-safety-dialog">
          <button type="button" className="dialog-close" onClick={() => setPeopleSafetyOpen(false)} aria-label={t('Close')}><UiIcon name="close" size={18} /></button>
          <span className="eyebrow">{t('Conversation Controls')}</span>
          <h2 id="people-safety-title">{t('People & Safety')}</h2>
          <p id="people-safety-description">{t('See who is here, review access requests, and keep this conversation safe.')}</p>
          {roomPeopleLoading ? <div className="people-safety-loading" role="status">{t('Loading people…')}</div> : null}
          {roomPeople ? <>
            <div className="people-safety-tabs" role="tablist" aria-label={t('Conversation control sections')}>
              <button type="button" role="tab" aria-selected={peopleSafetySection === 'people'} onClick={() => setPeopleSafetySection('people')}>{t('People')} <span>{roomPeople.members.length}</span></button>
              {roomPeople.canManage && roomPeople.kind !== 'direct' ? <button type="button" role="tab" aria-selected={peopleSafetySection === 'requests'} onClick={() => setPeopleSafetySection('requests')}>{t('Requests')} {guestRequests.length ? <span>{guestRequests.filter((request) => request.status === 'pending').length}</span> : null}</button> : null}
              {roomPeople.kind !== 'direct' ? <button type="button" role="tab" aria-selected={peopleSafetySection === 'access'} onClick={() => setPeopleSafetySection('access')}>{t('Access & Invites')}</button> : null}
              <button type="button" role="tab" aria-selected={peopleSafetySection === 'safety'} onClick={() => setPeopleSafetySection('safety')}>{t('Safety')}</button>
            </div>

            {peopleSafetySection === 'people' ? <div className="people-safety-section" role="tabpanel">
              <section className="people-list" aria-labelledby="people-list-title"><div className="people-list-heading"><h3 id="people-list-title">{t('People')}</h3><span>{roomPeople.members.length}</span></div>{roomPeople.members.map((person) => { const self = person.kind === actor?.kind && person.id === actor?.id; return <article key={`${person.kind}:${person.id}`}><span className="avatar" style={person.avatarColor ? { '--avatar': person.avatarColor } as CSSProperties : avatarStyle(person.displayName)}>{person.displayName.slice(0, 1)}</span><span><strong>{person.displayName}{self ? ` · ${t('You')}` : ''}</strong><small>{person.role === 'owner' ? t('Owner') : person.role === 'guest' ? t('Guest') : t('Member')}</small></span>{!self ? <details className="person-action-menu"><summary aria-label={t('Actions for {name}', { name: person.displayName })}><UiIcon name="more" size={19} /></summary><div><button type="button" onClick={() => { setReportTarget(person); setReportOpen(true); }}>{t('Report')}</button>{actor?.kind === 'user' && person.kind === 'user' ? <button type="button" onClick={() => setSafetyAction({ kind: 'block', person })}>{t('Block')}</button> : null}{roomPeople.canManage && person.kind === 'user' && person.role === 'member' ? <><button type="button" onClick={() => void transferOwnership(person)}>{t('Make Owner')}</button><button type="button" className="destructive-action" onClick={() => setSafetyAction({ kind: 'remove', person })}>{t('Remove')}</button></> : null}{roomPeople.canManage && person.kind === 'guest' ? <button type="button" className="destructive-action" onClick={() => void removeRoomGuest(person)}>{t('End Guest Access')}</button> : null}</div></details> : null}</article>; })}</section>
            </div> : null}

            {peopleSafetySection === 'requests' && roomPeople.canManage ? <section className="people-safety-section join-request-queue" role="tabpanel" aria-labelledby="join-requests-title">
              <div className="section-heading"><div><span className="eyebrow">{t('Admission')}</span><h3 id="join-requests-title">{t('Join Requests')}</h3></div><small role="status" aria-live="polite">{t('{count} waiting for review', { count: pendingGuestRequests.length })}</small></div>
              {guestRequestsLoading ? <div role="status">{t('Loading requests…')}</div> : guestRequests.length ? ([
                { key: 'pending', title: t('Waiting for Review'), description: t('These people cannot see room content yet.'), items: pendingGuestRequests },
                { key: 'approved', title: t('Approved · Waiting to Enter'), description: t('Their temporary session begins only when they enter.'), items: approvedGuestRequests },
              ] as const).map((group) => group.items.length ? <section className="request-group" key={group.key} aria-labelledby={`request-group-${group.key}`}>
                <div className="request-group-heading"><div><h4 id={`request-group-${group.key}`}>{group.title}</h4><p>{group.description}</p></div><span>{group.items.length}</span></div>
                {group.items.map((request) => <article id={`guest-request-${request.id}`} tabIndex={-1} key={request.id} className={`join-request-card ${request.status}${highlightedGuestRequestId === request.id ? ' highlighted' : ''}`}>
                  <span className="avatar" style={avatarStyle(request.displayName)}>{request.displayName.slice(0, 1)}</span>
                  <div><strong>{request.displayName}</strong><small>{request.status === 'approved' ? t('Approved · requested {time}', { time: relativeTime(request.requestedAt, locale, requestClock) }) : t('Requested {time}', { time: relativeTime(request.requestedAt, locale, requestClock) })}</small><small>{t('Invite {code} · expires {time}', { code: request.inviteCodeHint, time: relativeTime(request.grantExpiresAt ?? request.expiresAt, locale, requestClock) })}</small>{request.introduction ? <p>{request.introduction}</p> : <p className="muted-copy">{t('No introduction provided.')}</p>}</div>
                  <div className="join-request-card-actions">{request.status === 'pending' ? <><button type="button" className="primary-button" disabled={guestRequestActionId === request.id} onClick={() => void decideRoomGuestRequest(request, 'approve')}>{t('Approve')}</button><button type="button" disabled={guestRequestActionId === request.id} onClick={() => { setDecliningGuestRequest(request); setDeclineReason(''); }}>{t('Decline')}</button></> : <button type="button" className="destructive-action" disabled={guestRequestActionId === request.id} onClick={() => void decideRoomGuestRequest(request, 'revoke')}>{t('Revoke Approval')}</button>}</div>
                </article>)}
              </section> : null) : <div className="section-empty"><UiIcon name="check" size={24} /><strong>{t('No Open Requests')}</strong><small>{t('New requests will appear here without exposing room content.')}</small></div>}
            </section> : null}

            {peopleSafetySection === 'access' ? <section className="people-safety-section access-invite-section" role="tabpanel"><div className="section-heading"><div><span className="eyebrow">{t('Guest Admission')}</span><h3>{t('Who Can Enter by Link?')}</h3></div></div>{roomPeople.canManage ? <fieldset className="admission-policy"><legend>{t('Guest Access')}</legend>{(['off', 'approval', 'link'] as const).map((policy) => <label key={policy}><input type="radio" name="guest-admission-policy" value={policy} checked={roomPeople.guestAdmissionPolicy === policy} onChange={() => { if (roomPeople.guestAdmissionPolicy !== policy) confirmGovernanceChange({ guestAdmissionPolicy: policy }, t('Change guest access?'), t('Change Access')); }} /><span><strong>{policy === 'off' ? t('Guest Access Off') : policy === 'approval' ? t('Approval Required') : t('Anyone with the Link')}</strong><small>{policy === 'off' ? t('Only signed-in people can use this invite.') : policy === 'approval' ? t('Guests wait for an owner. Their 2-hour session starts only after entry.') : t('Guests enter immediately after choosing a display name.')}</small></span></label>)}</fieldset> : <p>{roomPeople.guestAdmissionPolicy === 'approval' ? t('Guests need owner approval before entering.') : roomPeople.guestAdmissionPolicy === 'link' ? t('Guests with the link can enter immediately.') : t('Guest access is off.')}</p>}
              <div className="invite-policy-summary"><strong>{roomPeople.inviteActive ? t('Active Invite') : t('Invite Revoked')}</strong><span>{roomPeople.inviteExpiresAt ? t('Expires {date}', { date: new Intl.DateTimeFormat(localeTag(locale), { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(roomPeople.inviteExpiresAt)) }) : t('No expiration')}</span><span>{roomPeople.inviteMaxUses ? t('{used} of {max} uses', { used: roomPeople.inviteUseCount, max: roomPeople.inviteMaxUses }) : t('{used} uses · unlimited', { used: roomPeople.inviteUseCount })}</span></div>
              {roomPeople.canManage ? <div className="access-actions">{roomPeople.inviteActive ? <button type="button" onClick={() => confirmGovernanceChange({ inviteActive: false }, t('Revoke this invite?'), t('Revoke Invite'))}>{t('Revoke Invite')}</button> : <button type="button" className="primary-button" onClick={() => void updateGovernance({ inviteActive: true })}>{t('Create New Invite')}</button>}<label className="governance-select">{t('Change Expiration')}<select value="" onChange={(event) => { if (event.target.value) void updateGovernance({ inviteExpiresInHours: Number(event.target.value) }); }}><option value="" disabled>{t('Choose a new expiration…')}</option><option value="0">{t('No Expiration')}</option><option value="1">{t('1 Hour from Now')}</option><option value="24">{t('24 Hours from Now')}</option><option value="168">{t('7 Days from Now')}</option></select></label><label className="governance-select">{t('Invite Uses')}<select value={roomPeople.inviteMaxUses ?? 0} onChange={(event) => { const value = Number(event.target.value); const reducesBelowReserved = value > 0 && value < roomPeople.inviteUseCount; if (reducesBelowReserved) confirmGovernanceChange({ inviteMaxUses: value }, t('Reduce invite capacity?'), t('Reduce Capacity')); else void updateGovernance({ inviteMaxUses: value }); }}><option value="0">{t('Unlimited')}</option><option value="1">{t('One Time')}</option><option value="5">{t('5 People')}</option><option value="20">{t('20 People')}</option></select></label></div> : null}
              <small className="signed-in-policy-note"><UiIcon name="info" size={15} /> {t('Signed-in people still join directly from a valid invite. Approval currently applies to guests.')}</small>
            </section> : null}

            {peopleSafetySection === 'safety' ? <section className="people-safety-section safety-zone" role="tabpanel"><section className="notification-section" aria-labelledby="notification-section-title"><h3 id="notification-section-title">{t('Notifications')}</h3><button type="button" className="notification-setting" onClick={() => void toggleRoomMute()} aria-pressed={roomPeople.muted}><UiIcon name="message" size={18} /><span><strong>{roomPeople.muted ? t('Unmute Conversation') : t('Mute Conversation')}</strong><small>{roomPeople.muted ? t('Resume in-app notifications for new activity.') : t('Pause conversation activity notifications. Join requests remain visible to owners.')}</small></span></button></section><button type="button" className="wide" onClick={() => { setReportTarget(null); setReportOpen(true); }}>{t('Report Conversation')}</button>{(roomPeople.blockedAccounts ?? []).length ? <section className="blocked-accounts" aria-labelledby="blocked-accounts-title"><h3 id="blocked-accounts-title">{t('Blocked Accounts')}</h3>{(roomPeople.blockedAccounts ?? []).map((account) => <div key={account.id}><span className="avatar" style={{ '--avatar': account.avatarColor } as CSSProperties}>{account.displayName.slice(0, 1)}</span><strong>{account.displayName}</strong><button type="button" onClick={() => void unblockAccount(account.id)}>{t('Unblock')}</button></div>)}</section> : null}<div className="danger-zone"><span className="eyebrow destructive">{t('Danger Zone')}</span>{actor?.kind === 'user' ? <button type="button" onClick={() => void archiveConversation()}>{t('Archive for Me')}</button> : null}{actor?.kind === 'user' && roomPeople.currentRole !== 'owner' ? <button type="button" className="danger-button" onClick={() => setSafetyAction({ kind: 'leave' })}>{t('Leave Conversation')}</button> : null}{roomPeople.canManage ? <button type="button" className="danger-button" onClick={() => setDeleteRoomConfirmOpen(true)}>{t('Delete Conversation')}</button> : null}</div></section> : null}
          </> : null}
        </section>
      </AppDialog>
      <AppDialog open={Boolean(decliningGuestRequest)} onClose={() => { setDecliningGuestRequest(null); setDeclineReason(''); }} labelledBy="decline-request-title" describedBy="decline-request-description" className="confirmation-backdrop">
        <form className="dialog-card confirmation-dialog decline-request-dialog" onSubmit={(event) => { event.preventDefault(); if (decliningGuestRequest) void decideRoomGuestRequest(decliningGuestRequest, 'reject', declineReason); }}>
          <span className="eyebrow destructive">{t('Decline Request')}</span>
          <h2 id="decline-request-title">{t('Decline {name}?', { name: decliningGuestRequest?.displayName ?? '' })}</h2>
          <p id="decline-request-description">{t('They will not be able to enter or see room content. You can add a short, respectful note to help them understand.')}</p>
          <label>{t('Reason')} <small>{t('(optional)')}</small><textarea value={declineReason} onChange={(event) => setDeclineReason(event.target.value)} maxLength={500} placeholder={t('For example: please ask the project owner for a new invite.')} autoFocus /></label>
          <div className="confirmation-actions"><button type="button" onClick={() => { setDecliningGuestRequest(null); setDeclineReason(''); }}>{t('Keep Waiting')}</button><button type="submit" className="danger-button" disabled={Boolean(guestRequestActionId)}>{t('Decline Request')}</button></div>
        </form>
      </AppDialog>
      <AppDialog open={Boolean(governanceConfirmation)} onClose={() => setGovernanceConfirmation(null)} labelledBy="governance-confirmation-title" describedBy="governance-confirmation-description" className="confirmation-backdrop">
        <section className="dialog-card confirmation-dialog">
          <span className="eyebrow destructive">{t('Review Impact')}</span>
          <h2 id="governance-confirmation-title">{governanceConfirmation?.title}</h2>
          <p id="governance-confirmation-description">{governanceConfirmation?.description}</p>
          <div className="impact-preview"><strong>{t('What stays safe')}</strong><span>{t('Messages, drawings, and current members are not removed.')}</span></div>
          <div className="confirmation-actions"><button type="button" onClick={() => setGovernanceConfirmation(null)}>{t('Cancel')}</button><button type="button" className="danger-button" onClick={() => { const confirmation = governanceConfirmation; setGovernanceConfirmation(null); if (confirmation) void updateGovernance(confirmation.patch); }}>{governanceConfirmation?.confirmLabel}</button></div>
        </section>
      </AppDialog>
      <AppDialog open={Boolean(safetyAction)} onClose={() => setSafetyAction(null)} labelledBy="safety-action-title" describedBy="safety-action-description" className="confirmation-backdrop"><section className="dialog-card confirmation-dialog"><span className="eyebrow destructive">{safetyAction?.kind === 'block' ? t('Block Member') : safetyAction?.kind === 'remove' ? t('Remove Member') : t('Leave Conversation')}</span><h2 id="safety-action-title">{safetyAction?.kind === 'block' ? t('Block {name}?', { name: safetyAction.person?.displayName ?? '' }) : safetyAction?.kind === 'remove' ? t('Remove {name}?', { name: safetyAction.person?.displayName ?? '' }) : t('Leave this conversation?')}</h2><p id="safety-action-description">{safetyAction?.kind === 'block' ? t('They cannot start a direct conversation with you or appear in your people search. Their existing shared-room content will be hidden by default.') : safetyAction?.kind === 'remove' ? t('They lose access immediately. Their earlier contributions remain so the conversation and visual history stay understandable.') : t('You will lose access and need a new active invite to return. Your contributions remain.')}</p><div className="confirmation-actions"><button type="button" onClick={() => setSafetyAction(null)}>{t('Cancel')}</button><button type="button" className="danger-button" onClick={() => { const action = safetyAction; setSafetyAction(null); if (action?.kind === 'block' && action.person) void blockRoomMember(action.person); else if (action?.kind === 'remove' && action.person) void removeRoomMember(action.person); else if (action?.kind === 'leave') void leaveConversation(); }}>{safetyAction?.kind === 'block' ? t('Block') : safetyAction?.kind === 'remove' ? t('Remove') : t('Leave')}</button></div></section></AppDialog>
      <AppDialog open={deleteRoomConfirmOpen} onClose={() => setDeleteRoomConfirmOpen(false)} labelledBy="delete-room-title" describedBy="delete-room-description" className="confirmation-backdrop"><section className="dialog-card confirmation-dialog"><span className="eyebrow destructive">{t('Permanent Deletion')}</span><h2 id="delete-room-title">{t('Delete this conversation?')}</h2><p id="delete-room-description">{t('Every message, drawing, version, report, reaction, and stored image in this conversation will be permanently deleted for everyone. This cannot be undone.')}</p><div className="impact-preview"><strong>{t('Impact')}</strong><span>{t('{messages} messages · {media} images and drawings · all members lose access', { messages: activeRoom?.messageCount ?? messages.length, media: activeRoom?.mediaCount ?? 0 })}</span></div><div className="confirmation-actions"><button type="button" onClick={() => setDeleteRoomConfirmOpen(false)}>{t('Cancel')}</button><button type="button" className="danger-button" onClick={() => void deleteConversation()}>{t('Delete for Everyone')}</button></div></section></AppDialog>
      <AppDialog open={reportOpen} onClose={() => { setReportOpen(false); setReportTarget(null); setReportMessage(null); }} labelledBy="report-title" describedBy="report-description" className="confirmation-backdrop">
        <form className="dialog-card report-dialog" onSubmit={submitReport}>
          <button type="button" className="dialog-close" onClick={() => { setReportOpen(false); setReportTarget(null); setReportMessage(null); }} aria-label={t('Close')}><UiIcon name="close" size={18} /></button>
          <span className="eyebrow destructive">{t('Safety Report')}</span><h2 id="report-title">{reportMessage ? t('Report Message') : reportTarget ? t('Report {name}', { name: reportTarget.displayName }) : t('Report Conversation')}</h2><p id="report-description">{t('Reports are private. Include only the context needed to understand what happened.')}</p>
          {reportMessage ? <blockquote className="report-evidence"><strong>{reportMessage.senderName}</strong><p>{reportMessage.body || (reportMessage.type === 'canvas' ? t('Drawing contribution') : t('Photo contribution'))}</p><small>{t('This message and its room context will be attached automatically.')}</small></blockquote> : null}
          <label>{t('Reason')}<select value={reportReason} onChange={(event) => setReportReason(event.target.value)}><option value="harassment">{t('Harassment')}</option><option value="spam">{t('Spam')}</option><option value="unsafe-content">{t('Unsafe Content')}</option><option value="impersonation">{t('Impersonation')}</option><option value="other">{t('Other')}</option></select></label>
          <label>{t('Details')} <small>{t('(optional)')}</small><textarea value={reportDetails} onChange={(event) => setReportDetails(event.target.value)} maxLength={1000} placeholder={t('Describe what happened…')} /></label>
          <div className="confirmation-actions"><button type="button" onClick={() => { setReportOpen(false); setReportTarget(null); setReportMessage(null); }}>{t('Cancel')}</button><button type="submit" className="danger-button">{t('Submit Report')}</button></div>
        </form>
      </AppDialog>
      <AppDialog open={Boolean(editingMessage)} onClose={() => setEditingMessage(null)} labelledBy="edit-message-title" describedBy="edit-message-description">
        <form className="dialog-card edit-message-dialog" onSubmit={saveMessageEdit}><button type="button" className="dialog-close" onClick={() => setEditingMessage(null)} aria-label={t('Close')}><UiIcon name="close" size={18} /></button><span className="eyebrow">{t('Edit Contribution')}</span><h2 id="edit-message-title">{editingMessage?.type === 'text' ? t('Edit Message') : t('Edit Caption')}</h2><p id="edit-message-description">{t('The conversation will show that this contribution was edited.')}</p><label>{editingMessage?.type === 'text' ? t('Message') : t('Caption')}<textarea value={editingText} onChange={(event) => setEditingText(event.target.value)} maxLength={2000} autoFocus /></label><div className="confirmation-actions"><button type="button" onClick={() => setEditingMessage(null)}>{t('Cancel')}</button><button type="submit" className="primary-button" disabled={busy || (editingMessage?.type === 'text' && !editingText.trim())}>{t('Save Changes')}</button></div></form>
      </AppDialog>
      <AppDialog open={Boolean(deletingMessage)} onClose={() => setDeletingMessage(null)} labelledBy="delete-message-title" describedBy="delete-message-description" className="confirmation-backdrop"><section className="dialog-card confirmation-dialog"><span className="eyebrow destructive">{t('Remove Contribution')}</span><h2 id="delete-message-title">{t('Remove this contribution?')}</h2><p id="delete-message-description">{deletingMessage?.type === 'canvas' || deletingMessage?.type === 'image' ? t('The image is removed, but a safe placeholder keeps replies and visual branches understandable.') : t('A placeholder will remain so replies keep their context.')}</p><div className="confirmation-actions"><button type="button" onClick={() => setDeletingMessage(null)}>{t('Keep It')}</button><button type="button" className="danger-button" onClick={() => deletingMessage && void deleteContribution(deletingMessage)} disabled={busy}>{t('Remove')}</button></div></section></AppDialog>
      <AppDialog open={Boolean(pendingPreview)} onClose={closePendingPreview} labelledBy="pending-preview-title" describedBy="pending-preview-description"><section className="dialog-card pending-preview-dialog"><button type="button" className="dialog-close" onClick={closePendingPreview} aria-label={t('Close')}><UiIcon name="close" size={18} /></button><span className="eyebrow">{t('Saved on This Device')}</span><h2 id="pending-preview-title">{pendingPreview?.message.fileName || t('Queued Artwork')}</h2><p id="pending-preview-description">{t('Preview this attachment before deciding whether to retry, replace, save, or remove it.')}</p>{pendingPreview ? <Image unoptimized src={pendingPreview.url} width="1200" height="720" alt={t('Preview of queued attachment')} /> : null}<div className="confirmation-actions"><button type="button" onClick={closePendingPreview}>{t('Close')}</button>{pendingPreview ? <button type="button" className="primary-button" onClick={() => void savePendingMedia(pendingPreview.message)}>{t('Save to Device')}</button> : null}</div></section></AppDialog>
      <AppDialog open={Boolean(pendingRemoval)} onClose={() => setPendingRemoval(null)} labelledBy="remove-pending-title" describedBy="remove-pending-description" className="confirmation-backdrop"><section className="dialog-card confirmation-dialog"><span className="eyebrow destructive">{t('Remove Saved Item')}</span><h2 id="remove-pending-title">{t('Remove this unsent item?')}</h2><p id="remove-pending-description">{t('Save it to your device first if you may need it later. Removal deletes the local recovery copy.')}</p><div className="confirmation-actions"><button type="button" onClick={() => setPendingRemoval(null)}>{t('Keep Item')}</button><button type="button" className="danger-button" onClick={() => { const pending = pendingRemoval; setPendingRemoval(null); if (pending) removePendingMessage(pending.id); }}>{t('Remove')}</button></div></section></AppDialog>
      <AppDialog open={guestEndConfirmOpen} onClose={() => setGuestEndConfirmOpen(false)} labelledBy="end-guest-title" describedBy="end-guest-description" className="confirmation-backdrop">
        <section className="dialog-card confirmation-dialog">
          <span className="eyebrow destructive">{t('Cannot Be Undone')}</span>
          <h2 id="end-guest-title">{t('End Guest Session?')}</h2>
          <p id="end-guest-description">{t('You will lose access immediately. Messages and attached images remain in the room; reactions, palette colors, and unattached uploads are removed.')}</p>
          <div className="confirmation-actions"><button type="button" onClick={() => setGuestEndConfirmOpen(false)}>{t('Keep Session')}</button><button type="button" className="danger-button" onClick={() => void endGuest()}>{t('End Session')}</button></div>
        </section>
      </AppDialog>
      {studio && actor && activeRoomId && <Suspense fallback={<div className="studio-loading" role="status">{t('Opening Nét Studio…')}</div>}><DrawingStudio sourceUrl={studio.sourceUrl} sourceIsDraft={studio.draftSource} sourceKind={studio.sourceKind} sourceAuthor={studio.sourceAuthor} version={studio.version} draftKey={`${actor.kind}:${actor.id}:${activeRoomId}:${studio.parentId ?? 'new'}`} paletteColors={paletteColors} paletteLoading={paletteLoading} paletteMutating={paletteMutating} palettePersistence={actor?.kind === 'user' ? 'account' : 'session'} onClose={closeStudio} onSend={sendDrawing} onSavePalette={savePaletteColor} onDeletePalette={deletePaletteColor} /></Suspense>}
      {lineageViewer && <Suspense fallback={<div className="studio-loading" role="status">{t('Loading drawing history…')}</div>}><DrawingLineage key={`${lineageViewer.messageId}:${lineageViewer.loading ? 'loading' : 'ready'}:${lineageViewer.error ? 'error' : 'ok'}`} lineage={lineageViewer.lineage} initialId={lineageViewer.messageId} loading={lineageViewer.loading} error={lineageViewer.error} truncated={lineageViewer.truncated} canDecide={lineageViewer.canDecide} decisionOwners={lineageViewer.decisionOwners} onDecision={updateVisualDecision} onClose={() => { lineageRequestGeneration.current += 1; continuationGeneration.current += 1; setLineageViewer(null); }} onRetry={() => void loadDrawingLineage(lineageViewer.messageId)} onContinue={(item) => void continueFromLineage(item)} /></Suspense>}
      {viewingMedia && <MediaViewer key={viewingMedia.id} message={viewingMedia} downloading={downloadingAssetKey === (viewingMedia.assetKey ?? viewingMedia.id)} onClose={() => setViewingMedia(null)} onDownload={downloadMedia} onRefresh={(assetKey) => { void refreshAssetUrl(assetKey, true); }} />}
      {undoMessage ? <div className="undo-send-toast" role="status" aria-live="polite"><span>{t('Sent')}</span><button type="button" onClick={() => void undoLastSend()}>{t('Undo Send')}</button></div> : null}
      {(error || notice) && <div className={`${error ? 'toast error' : 'toast'}${studio ? ' studio-toast' : ''}`} role="status" aria-live="polite"><span>{error || notice}</span>{error && <button type="button" onClick={() => setError('')} aria-label={t('Dismiss notification')} data-tooltip={t('Dismiss notification')} data-tooltip-placement="above">×</button>}</div>}
    </div></>
  );
}
