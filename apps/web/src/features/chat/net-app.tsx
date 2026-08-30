'use client';

import {
  type ChangeEvent,
  type CSSProperties,
  type FormEvent,
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ActorView, MessageView, PaletteColorView, RoomView, UserSummary } from '@/src/shared/chat.types';
import { io, type Socket } from 'socket.io-client';
import AppDialog from '@/src/shared/app-dialog';
import MediaViewer from '@/src/features/chat/media-viewer';
import { useLanguage } from '@/src/i18n/language-provider';
import { localeTag, translateApiMessage, type Locale } from '@/src/i18n/messages';
import LanguageSwitcher from '@/src/shared/language-switcher';

const DrawingStudio = lazy(() => import('@/src/features/drawing/drawing-studio'));

type InitialUser = { id: string; displayName: string; email: string } | null;
type Phase = 'loading' | 'landing' | 'app';
type ConversationStartMode = 'direct' | 'group';
type InviteStatus = 'none' | 'checking' | 'guest' | 'auth-only' | 'invalid' | 'unavailable';
type InstallPromptEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> };

class ApiRequestError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

const EMOJIS = ['❤️', '👍', '✨', '😂', '👀'];

type UiIconName = 'arrow' | 'check' | 'close' | 'download' | 'draw' | 'external' | 'group' | 'info' | 'install' | 'link' | 'lock' | 'menu' | 'message' | 'plus' | 'reply' | 'search' | 'send' | 'user';

function UiIcon({ name, size = 20 }: { name: UiIconName; size?: number }) {
  const paths = {
    arrow: <><path d="M5 12h14" /><path d="m13 6 6 6-6 6" /></>,
    check: <path d="m5 12 4 4L19 6" />,
    close: <><path d="m6 6 12 12" /><path d="M18 6 6 18" /></>,
    download: <><path d="M12 3v12" /><path d="m7 10 5 5 5-5" /><path d="M5 21h14" /></>,
    draw: <><path d="m4 20 4.6-1.1L19 8.5 15.5 5 5.1 15.4 4 20Z" /><path d="m13.8 6.7 3.5 3.5" /></>,
    external: <><path d="M14 4h6v6" /><path d="M20 4 11 13" /><path d="M18 13v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h6" /></>,
    group: <><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" /></>,
    info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v6" /><path d="M12 7h.01" /></>,
    install: <><path d="M12 3v12" /><path d="m7 10 5 5 5-5" /><path d="M5 21h14" /></>,
    link: <><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" /><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" /></>,
    lock: <><rect x="5" y="10" width="14" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></>,
    menu: <><path d="M4 7h16" /><path d="M4 12h16" /><path d="M4 17h16" /></>,
    message: <path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z" />,
    plus: <><path d="M12 5v14" /><path d="M5 12h14" /></>,
    reply: <><path d="m9 17-5-5 5-5" /><path d="M4 12h9a7 7 0 0 1 7 7" /></>,
    search: <><circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" /></>,
    send: <><path d="m4 4 17 8-17 8 3-8-3-8Z" /><path d="M7 12h14" /></>,
    user: <><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></>,
  };
  return <svg aria-hidden="true" viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">{paths[name]}</svg>;
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

export default function NetApp({ initialUser, initialApiToken, signInPath, signOutPath }: { initialUser: InitialUser; initialApiToken: string | null; signInPath: string; signOutPath: string }) {
  const { locale, t } = useLanguage();
  const [phase, setPhase] = useState<Phase>('loading');
  const [actor, setActor] = useState<ActorView | null>(initialUser ? { kind: 'user', id: initialUser.id, displayName: initialUser.displayName, email: initialUser.email } : null);
  const [guestSession, setGuestSession] = useState<string | null>(() => typeof window === 'undefined' ? null : sessionStorage.getItem('net_guest_session'));
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
  const [guestFormError, setGuestFormError] = useState('');
  const [guestErrorField, setGuestErrorField] = useState<'name' | 'form' | null>(null);
  const [inviteCode, setInviteCode] = useState(() => typeof window === 'undefined' ? '' : new URLSearchParams(window.location.search).get('room') ?? '');
  const [inviteStatus, setInviteStatus] = useState<InviteStatus>(() => typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('room') ? 'checking' : 'none');
  const [createRoomOpen, setCreateRoomOpen] = useState(false);
  const [conversationStartMode, setConversationStartMode] = useState<ConversationStartMode>('direct');
  const [roomName, setRoomName] = useState('');
  const [contactQuery, setContactQuery] = useState('');
  const [contactResults, setContactResults] = useState<UserSummary[]>([]);
  const [contactSearching, setContactSearching] = useState(false);
  const [conversationStartError, setConversationStartError] = useState('');
  const [selectedContacts, setSelectedContacts] = useState<UserSummary[]>([]);
  const [allowGuests, setAllowGuests] = useState(true);
  const [sidebarPeople, setSidebarPeople] = useState<UserSummary[]>([]);
  const [sidebarPeopleLoading, setSidebarPeopleLoading] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [studio, setStudio] = useState<{ sourceUrl?: string | null; parentId?: string | null; version?: number | null } | null>(null);
  const [viewingMedia, setViewingMedia] = useState<MessageView | null>(null);
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
  const [pageVisible, setPageVisible] = useState(() => typeof document === 'undefined' || document.visibilityState === 'visible');
  const [conversationAtBottom, setConversationAtBottom] = useState(false);
  const [bootstrapRetry, setBootstrapRetry] = useState(0);
  const [apiToken, setApiToken] = useState(initialApiToken);
  const fileRef = useRef<HTMLInputElement>(null);
  const guestNameRef = useRef<HTMLInputElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const messageScrollRef = useRef<HTMLElement>(null);
  const conversationAtBottomRef = useRef(false);
  const joinedInvite = useRef(false);
  const activeRoomRef = useRef<string | null>(null);
  const latestMessageRequestGeneration = useRef(0);
  const historyMessageRequestGeneration = useRef(0);
  const messageSearchGeneration = useRef(0);
  const paletteRequestGeneration = useRef(0);
  const paletteMutationGeneration = useRef(0);
  const contactSearchGeneration = useRef(0);
  const sidebarPeopleGeneration = useRef(0);
  const paletteMutationActiveRef = useRef(false);
  const paletteAbortRef = useRef<AbortController | null>(null);
  const actorIdRef = useRef<string | null>(null);
  const readMarkers = useRef(new Map<string, string>());
  const socketRef = useRef<Socket | null>(null);
  const nativeSocketRef = useRef<WebSocket | null>(null);
  const endingGuestRef = useRef(false);
  const assetRefreshes = useRef(new Map<string, Promise<string | null>>());
  const automaticAssetRefreshAttempts = useRef(new Map<string, number>());

  const activeRoom = rooms.find((room) => room.id === activeRoomId) ?? null;
  const actorId = actor?.id ?? null;
  const normalizedMessageQuery = messageQuery.trim().toLocaleLowerCase(localeTag(locale));

  const api = useCallback(async <T,>(path: string, init: RequestInit = {}, sessionOverride?: string | null): Promise<T> => {
    const session = sessionOverride === undefined ? guestSession : sessionOverride;
    const headers = new Headers(init.headers);
    headers.set('accept-language', localeTag(locale));
    if (session) headers.set('x-net-guest-session', session);
    else if (apiToken) headers.set('authorization', `Bearer ${apiToken}`);
    if (init.body && typeof init.body === 'string' && !headers.has('content-type')) headers.set('content-type', 'application/json');
    let response = await fetch(path, { ...init, headers });
    if (response.status === 401 && !session && initialUser) {
      const refreshed = await fetch('/auth/api-token', { method: 'POST' });
      if (refreshed.ok) {
        const credentials = await refreshed.json() as { token: string };
        setApiToken(credentials.token);
        headers.set('authorization', `Bearer ${credentials.token}`);
        response = await fetch(path, { ...init, headers });
      }
    }
    const data = await response.json().catch(() => ({})) as T & { error?: string };
    if (!response.ok) {
      const message = data.error ?? 'We could not complete that request. Please try again.';
      throw new ApiRequestError(response.status, translateApiMessage(locale, message));
    }
    return data;
  }, [apiToken, guestSession, initialUser, locale]);

  const clearGuestSession = useCallback((message: string) => {
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
    setGuestSession(null); setActor(null); setRooms([]); setMessages([]); setNextCursor(null); setPaletteColors([]);
    setActiveRoomId(null); setReplyTo(null); setViewingMedia(null); setPhase('landing'); setSidebarOpen(false); setInfoOpen(false);
    setError(message);
  }, []);

  const selectRoom = useCallback((roomId: string) => {
    latestMessageRequestGeneration.current += 1;
    historyMessageRequestGeneration.current += 1;
    messageSearchGeneration.current += 1;
    activeRoomRef.current = roomId;
    setActiveRoomId(roomId); setMessages([]); setNextCursor(null); setReplyTo(null);
    setMessageSearchResults([]); setMessageSearchTotal(0); setMessageSearchLoading(false);
    conversationAtBottomRef.current = false;
    setSidebarOpen(false); setInfoOpen(false); setViewingMedia(null); setMessageQuery(''); setConversationAtBottom(false);
  }, []);

  const consumeInvite = useCallback(() => {
    joinedInvite.current = false;
    setInviteCode('');
    setInviteStatus('none');
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
            const invitation = await api<{ valid: true; guestAllowed: boolean }>(`/api/invites/${encodeURIComponent(queryInvite)}`, {}, null);
            setInviteStatus(invitation.guestAllowed ? 'guest' : 'auth-only');
          } catch (inviteError) {
            setInviteStatus(inviteError instanceof ApiRequestError && [400, 404].includes(inviteError.status) ? 'invalid' : 'unavailable');
          }
          setPhase('landing');
        }
      }).catch((bootstrapError) => {
        if (bootstrapError instanceof ApiRequestError && bootstrapError.status === 401 && savedGuest) {
          clearGuestSession(t('Your guest session expired. You no longer have access; messages and attached images remain in the room.'));
          return;
        }
        setError(navigator.onLine
          ? t('Nét cannot connect right now. Your session is safe; try again in a moment.')
          : t('You are offline. Your session is safe and will recover when the connection returns.'));
        setPhase(savedGuest || initialUser ? 'loading' : 'landing');
      });
    }, 0);
    const onInstall = (event: Event) => { event.preventDefault(); setInstallPrompt(event as InstallPromptEvent); };
    window.addEventListener('beforeinstallprompt', onInstall);
    return () => { window.clearTimeout(boot); window.removeEventListener('beforeinstallprompt', onInstall); };
  }, [api, bootstrapRetry, clearGuestSession, consumeInvite, guestSession, initialUser, inviteCode, loadBootstrap, selectRoom, t]);

  useEffect(() => {
    if ('serviceWorker' in navigator) void navigator.serviceWorker.register('/sw.js');
  }, []);

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
        if (activityError instanceof ApiRequestError && activityError.status === 401 && sessionStorage.getItem('net_guest_session')) {
          clearGuestSession(t('Your guest session expired. You no longer have access; messages and attached images remain in the room.'));
        }
      });
    };
    window.addEventListener('pointerdown', touch, { passive: true });
    window.addEventListener('keydown', touch);
    return () => { window.removeEventListener('pointerdown', touch); window.removeEventListener('keydown', touch); };
  }, [actor?.kind, api, clearGuestSession, t]);

  const loadMessages = useCallback(async (roomId: string, quiet = false, before?: string) => {
    const requestGeneration = before ? historyMessageRequestGeneration : latestMessageRequestGeneration;
    const generation = ++requestGeneration.current;
    const followLatest = quiet && !before && conversationAtBottomRef.current;
    try {
      const cursor = before ? `?before=${encodeURIComponent(before)}` : quiet ? '?limit=100' : '';
      const data = await api<{ messages: MessageView[]; nextCursor: string | null }>(`/api/rooms/${roomId}/messages${cursor}`);
      if (activeRoomRef.current !== roomId || generation !== requestGeneration.current) return;
      if (!quiet) setNextCursor(data.nextCursor);
      if (before) {
        setMessages((current) => {
          const merged = new Map(current.map((message) => [message.id, message]));
          for (const message of data.messages) merged.set(message.id, message);
          return [...merged.values()].sort((left, right) => left.sequence - right.sequence);
        });
      } else if (quiet) {
        setMessages((current) => {
          if (!data.messages.length) return [];
          const ids = new Set(data.messages.map((message) => message.id));
          const oldest = data.messages[0];
          const retained = current.filter((message) => message.sequence < oldest.sequence || ids.has(message.id));
          const merged = new Map(retained.map((message) => [message.id, message]));
          for (const message of data.messages) merged.set(message.id, message);
          return [...merged.values()].sort((left, right) => left.sequence - right.sequence);
        });
      } else setMessages(data.messages);
      if ((!quiet && !before) || followLatest) requestAnimationFrame(() => {
        endRef.current?.scrollIntoView({ block: 'end' });
        const scrollContainer = messageScrollRef.current;
        if (!scrollContainer) return;
        const distance = scrollContainer.scrollHeight - scrollContainer.scrollTop - scrollContainer.clientHeight;
        const atBottom = distance <= 72;
        conversationAtBottomRef.current = atBottom;
        setConversationAtBottom(atBottom);
      });
    } catch (loadError) {
      if (loadError instanceof ApiRequestError && loadError.status === 401 && guestSession) {
        clearGuestSession(t('Your guest session expired. You no longer have access; messages and attached images remain in the room.'));
        return;
      }
      if (!quiet) setError(loadError instanceof Error ? loadError.message : t('Messages could not be loaded. Try again.'));
    }
  }, [api, clearGuestSession, guestSession, t]);

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
    if (!activeRoomId || !pageVisible || normalizedMessageQuery || infoOpen || studio || !messages.length) return;
    const scrollContainer = messageScrollRef.current;
    const distanceFromBottom = scrollContainer
      ? scrollContainer.scrollHeight - scrollContainer.scrollTop - scrollContainer.clientHeight
      : Number.POSITIVE_INFINITY;
    if (!conversationAtBottom && distanceFromBottom > 72) return;
    const newest = messages[messages.length - 1];
    if (!newest || newest.id === readMarkers.current.get(activeRoomId)) return;
    readMarkers.current.set(activeRoomId, newest.id);
    void api(`/api/rooms/${activeRoomId}/messages`, { method: 'PATCH', body: JSON.stringify({ messageId: newest.id }) })
      .then(() => setRooms((current) => current.map((room) => room.id === activeRoomId ? { ...room, unreadCount: 0 } : room)))
      .catch((readError) => {
        readMarkers.current.delete(activeRoomId);
        if (readError instanceof ApiRequestError && readError.status === 401 && guestSession) {
          clearGuestSession(t('Your guest session expired. You no longer have access; messages and attached images remain in the room.'));
        }
      });
  }, [activeRoomId, api, clearGuestSession, conversationAtBottom, guestSession, infoOpen, messages, normalizedMessageQuery, pageVisible, studio, t]);

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
          let frame: { type?: string; event?: string; roomId?: string; payload?: { roomId?: string; guestSessionId?: string; retained?: boolean } };
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
          if (frame.type !== 'event' || frame.payload?.roomId !== activeRoomRef.current) return;
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
    const initialLoad = window.setTimeout(() => void loadMessages(activeRoomId), 0);
    return () => window.clearTimeout(initialLoad);
  }, [activeRoomId, loadMessages, phase]);

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
    if (phase !== 'landing' || (!guestModal && inviteStatus !== 'guest')) return;
    const frame = window.requestAnimationFrame(() => guestNameRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [guestModal, inviteStatus, phase]);

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
  }, [actor?.kind, api, contactQuery, conversationStartMode, createRoomOpen, t]);

  useEffect(() => {
    const generation = ++sidebarPeopleGeneration.current;
    const query = roomQuery.trim();
    if (actor?.kind !== 'user' || query.length < 2) {
      return;
    }
    const timeout = window.setTimeout(() => {
      void api<{ users: UserSummary[] }>(`/api/users?q=${encodeURIComponent(query)}`)
        .then((data) => {
          if (generation === sidebarPeopleGeneration.current) setSidebarPeople(data.users);
        })
        .catch(() => {
          if (generation === sidebarPeopleGeneration.current) setSidebarPeople([]);
        })
        .finally(() => {
          if (generation === sidebarPeopleGeneration.current) setSidebarPeopleLoading(false);
        });
    }, 220);
    return () => window.clearTimeout(timeout);
  }, [actor?.kind, api, roomQuery]);

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
    setBusy(true); setGuestFormError(''); setGuestErrorField(null);
    try {
      const normalizedInviteCode = extractInviteCode(inviteCode);
      const data = await api<{ sessionId: string }>('/api/guest', { method: 'POST', body: JSON.stringify({ displayName, inviteCode: normalizedInviteCode || undefined }) }, null);
      sessionStorage.setItem('net_guest_session', data.sessionId);
      endingGuestRef.current = false;
      setGuestSession(data.sessionId);
      setGuestModal(false);
      await loadBootstrap(data.sessionId);
      consumeInvite();
    } catch (startError) {
      setGuestFormError(startError instanceof Error ? startError.message : t('The guest session could not be started. Try again.'));
      setGuestErrorField('form');
    }
    setBusy(false);
  };

  const endGuest = async () => {
    if (endingGuestRef.current) return;
    setGuestEndConfirmOpen(false);
    endingGuestRef.current = true;
    try {
      const result = await api<{ retained?: boolean }>('/api/guest', { method: 'DELETE' });
      clearGuestSession('');
      setNotice(result.retained
        ? t('Your guest session ended. You no longer have access; content you sent remains in the room.')
        : t('Your guest session ended. The room had no signed-in member, so temporary content was removed.'));
    } catch (endError) {
      if (endError instanceof ApiRequestError && endError.status === 401) {
        clearGuestSession('');
        setNotice(t('Your guest session expired. You no longer have access; messages and attached images remain in the room.'));
      } else {
        endingGuestRef.current = false;
        setError(endError instanceof Error ? endError.message : t('The session could not be ended. Try again.'));
      }
    }
  };

  const resetConversationStarter = () => {
    contactSearchGeneration.current += 1;
    setCreateRoomOpen(false);
    setConversationStartMode('direct');
    setRoomName('');
    setContactQuery('');
    setContactResults([]);
    setContactSearching(false);
    setConversationStartError('');
    setSelectedContacts([]);
    setAllowGuests(true);
  };

  const openConversationStarter = (mode: ConversationStartMode = 'direct') => {
    setConversationStartMode(mode);
    setConversationStartError('');
    setCreateRoomOpen(true);
  };

  const startDirectChat = async (contact: UserSummary) => {
    if (busy) return;
    setBusy(true); setConversationStartError('');
    try {
      const created = await api<{ id: string; reused?: boolean }>('/api/rooms', {
        method: 'POST',
        body: JSON.stringify({ allowGuests: false, memberIds: [contact.id] }),
      });
      await loadBootstrap();
      selectRoom(created.id);
      resetConversationStarter();
      setRoomQuery('');
      setNotice(created.reused ? t('Reopened your conversation with {name}.', { name: contact.displayName }) : t('Started a conversation with {name}.', { name: contact.displayName }));
    } catch (createError) {
      const message = createError instanceof Error ? createError.message : t('The conversation could not be started. Try again.');
      if (createRoomOpen) setConversationStartError(message);
      else setError(message);
    }
    setBusy(false);
  };

  const createRoom = async (event: FormEvent) => {
    event.preventDefault();
    if (selectedContacts.length < 2) {
      setConversationStartError(t('Select at least 2 people to create a group. For 1 person, start a direct message.'));
      return;
    }
    setBusy(true); setConversationStartError('');
    try {
      const created = await api<{ id: string }>('/api/rooms', { method: 'POST', body: JSON.stringify({ name: roomName, allowGuests, memberIds: selectedContacts.map((contact) => contact.id) }) });
      await loadBootstrap();
      selectRoom(created.id);
      resetConversationStarter();
      setNotice(t('Created a new group.'));
    } catch (createError) { setConversationStartError(createError instanceof Error ? createError.message : t('The group could not be created. Try again.')); }
    setBusy(false);
  };

  const sendMessage = async (payload: { type: 'text' | 'image' | 'canvas'; text?: string; assetKey?: string; canvasParentId?: string | null }, replyToId: string | null) => {
    if (!activeRoomId) return;
    const clientRequestId = crypto.randomUUID();
    const request = () => api(`/api/rooms/${activeRoomId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ ...payload, replyToId, clientRequestId }),
    });
    try { await request(); }
    catch (requestError) {
      if (!(requestError instanceof TypeError)) throw requestError;
      await request();
    }
    await Promise.all([loadMessages(activeRoomId), loadBootstrap()]);
  };

  const submitText = async () => {
    const text = draft.trim();
    if (!text || busy) return;
    const replyingTo = replyTo;
    setBusy(true); setError('');
    setDraft(''); setReplyTo(null);
    try { await sendMessage({ type: 'text', text }, replyingTo?.id ?? null); }
    catch (sendError) {
      setDraft((current) => current || text);
      setReplyTo((current) => current ?? replyingTo);
      setError(sendError instanceof Error ? sendError.message : t('The message could not be sent. Try again.'));
    }
    setBusy(false);
  };

  const uploadAsset = async (blob: Blob) => {
    if (!activeRoomId) throw new Error(t('Select a conversation first.'));
    return api<{ key: string }>(`/api/assets?room=${encodeURIComponent(activeRoomId)}`, { method: 'POST', headers: { 'content-type': blob.type }, body: blob });
  };

  const attachImage = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setBusy(true); setError('');
    try {
      const asset = await uploadAsset(file);
      await sendMessage({ type: 'image', assetKey: asset.key }, replyTo?.id ?? null);
      setReplyTo(null);
    } catch (uploadError) { setError(uploadError instanceof Error ? uploadError.message : t('The image could not be sent. Try again.')); }
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
    try {
      const asset = await uploadAsset(blob);
      await sendMessage({ type: 'canvas', assetKey: asset.key, text: caption || undefined, canvasParentId: studio?.parentId ?? null }, replyTo?.id ?? null);
      setReplyTo(null);
      closeStudio();
    } catch (drawingError) { setError(drawingError instanceof Error ? drawingError.message : t('The drawing could not be sent. Try again.')); }
  };

  const openStudio = (nextStudio: { sourceUrl?: string | null; parentId?: string | null; version?: number | null }) => {
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
        setError(assetError instanceof Error ? assetError.message : t('Image access could not be refreshed. Try again.'));
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
    const freshUrl = await refreshAssetUrl(message.assetKey);
    if (freshUrl) openStudio({ sourceUrl: freshUrl, parentId: message.id, version: message.canvasVersion });
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

  const loadOlder = async () => {
    if (!activeRoomId || !nextCursor || loadingOlder) return;
    setLoadingOlder(true);
    await loadMessages(activeRoomId, false, nextCursor);
    setLoadingOlder(false);
  };

  const copyInvite = async () => {
    if (!activeRoom) return;
    const link = `${window.location.origin}/?room=${activeRoom.inviteCode}`;
    try {
      await navigator.clipboard.writeText(link);
      setNotice(t('Copied the invite link.'));
    } catch { setError(t('Your browser blocked clipboard access. Select the invite link and copy it manually.')); }
  };

  const filteredRooms = rooms.filter((room) => `${room.name} ${room.preview}`.toLocaleLowerCase(localeTag(locale)).includes(roomQuery.trim().toLocaleLowerCase(localeTag(locale))));
  const availableContacts = conversationStartMode === 'group'
    ? contactResults.filter((user) => !selectedContacts.some((selected) => selected.id === user.id))
    : contactResults;
  const normalizedInviteCode = extractInviteCode(inviteCode);
  const inviteSignInPath = normalizedInviteCode
    ? `/auth/sign-in?returnTo=${encodeURIComponent(`/?room=${encodeURIComponent(normalizedInviteCode)}`)}`
    : signInPath;
  const homeSignInPath = `${signInPath.split('?')[0]}?returnTo=${encodeURIComponent('/')}`;
  const visibleMessages = useMemo(() => normalizedMessageQuery
    ? normalizedMessageQuery.length >= 2 ? messageSearchResults : []
    : messages, [messageSearchResults, messages, normalizedMessageQuery]);
  const showInviteOnboarding = Boolean(activeRoom?.allowGuests)
    && !normalizedMessageQuery
    && (activeRoom?.messageCount ?? messages.length) <= 1
    && messages.every((message) => message.type === 'system');
  const inviteReady = inviteStatus === 'guest';

  if (phase === 'loading') return <div className="boot-screen"><Logo /><span className="loading-line" /><p>{error || t('Opening your space…')}</p>{error && <button type="button" className="primary-button" onClick={() => { setError(''); setBootstrapRetry((current) => current + 1); }}>{t('Try Connecting Again')}</button>}</div>;

  if (phase === 'landing') {
    return (
      <><a className="skip-link" href="#main-content">{t('Skip to main content')}</a><main id="main-content" className="landing-page">
        <nav className="landing-nav"><Logo /><div><a href="#how">{t('How It Works')}</a><LanguageSwitcher compact /><a href={inviteStatus === 'invalid' ? homeSignInPath : inviteSignInPath} className="nav-signin">{t('Sign In')}</a></div></nav>
        <section className="hero">
          <div className="hero-copy">
            <span className="eyebrow">{inviteReady ? t('Your Invite Is Ready') : inviteStatus === 'auth-only' ? t('Members-Only Invite') : inviteStatus === 'invalid' ? t('Invite Unavailable') : inviteStatus === 'unavailable' ? t('Connection Interrupted') : t('Message with words. Continue with a line.')}</span>
            <h1>{inviteReady ? <><span>{t('Enter the room,')}</span>{' '}<em>{t('just choose a name.')}</em></> : inviteStatus === 'auth-only' ? <><span>{t('Sign in,')}</span>{' '}<em>{t('then join instantly.')}</em></> : inviteStatus === 'invalid' ? <><span>{t('This invite link')}</span>{' '}<em>{t('is no longer active.')}</em></> : inviteStatus === 'unavailable' ? <><span>{t('We cannot check')}</span>{' '}<em>{t('your invite yet.')}</em></> : <><span>{t('Some things are')}</span>{' '}<em>{t('easier to draw than say.')}</em></>}</h1>
            <p>{inviteReady ? t('No room search or code entry. Choose a display name, then start chatting and drawing together.') : inviteStatus === 'auth-only' ? t('This room does not accept guests. After you sign in, Nét will take you directly to the conversation.') : inviteStatus === 'invalid' ? t('The invite may have expired or the room may no longer exist. Ask the sender for a new link.') : inviteStatus === 'unavailable' ? t('Nét cannot verify this link while the connection is interrupted. Your invite stays intact so you can try again.') : t('Nét is a messenger for unfinished ideas—send text, images, or a canvas that someone else can continue as a new version.')}</p>
            {inviteReady ? <section className="invite-join-panel" aria-labelledby="invite-join-title">
              <div className="invite-join-status"><span><UiIcon name="check" /></span><div><strong id="invite-join-title">{t('Room Ready')}</strong><small>{t('Your invite link has been verified.')}</small></div></div>
              <form className="invite-join-form" onSubmit={startGuest} noValidate>
                <label>{t('Display Name')}<input ref={guestNameRef} name="guest-invite-name" autoComplete="nickname" value={guestName} onChange={(event) => { setGuestName(event.target.value); setGuestFormError(''); setGuestErrorField(null); }} placeholder={t('For example, Alex…')} maxLength={60} aria-invalid={guestErrorField === 'name'} aria-describedby={guestFormError ? 'guest-form-error' : undefined} /></label>
                <button type="submit" className="hero-primary" disabled={busy}>{busy ? t('Joining…') : <>{t('Join Room')} <UiIcon name="arrow" size={18} /></>}</button>
              </form>
              {guestFormError && <p id="guest-form-error" className="form-error" role="alert" aria-live="polite">{guestFormError}</p>}
              <div className="invite-join-alternatives"><a href={inviteSignInPath}>{t('Sign In to Join')}</a><button type="button" onClick={() => { consumeInvite(); setGuestFormError(''); setGuestErrorField(null); }}>{t('Back Home')}</button></div>
              <small>{t('Guests lose access when their session ends. Messages and attached images remain in the room.')}</small>
            </section> : inviteStatus === 'auth-only' ? <section className="invite-join-panel invite-state-panel" aria-labelledby="invite-auth-title">
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
              <div className="hero-actions"><a className="hero-primary" href={signInPath}>{t('Sign In')} <UiIcon name="arrow" size={18} /></a><button type="button" onClick={() => { setError(''); setGuestFormError(''); setGuestErrorField(null); setGuestModal(true); }}>{t('Try as a Guest')}</button></div>
              <small>{t('No account required · Guest access ends with the session')}</small>
            </>}
          </div>
          <div className="hero-demo" aria-label={t('Example conversation with messages and drawings')}>
            <div className="demo-top"><span className="avatar" style={avatarStyle('minh')}>M</span><div><strong>Minh Anh</strong><small><i /> {t('drawing with you')}</small></div><b>•••</b></div>
            <div className="demo-canvas"><span className="demo-sun" /><span className="demo-line line-a" /><span className="demo-line line-b" /><strong>{t('Could we add')}<br />{t('a tree here?')}</strong><i>↙</i></div>
            <div className="demo-message">{t('I’ll continue this idea')} ✨</div>
            <div className="demo-version"><span>⌁</span><div><small>{t('Version {version}', { version: 2 })}</small><strong>{t('An idea continued')}</strong></div></div>
          </div>
        </section>
        <section className="feature-strip" id="how">
          <article><b>01</b><span>{t('Send It Like a Message')}</span><p>{t('Text, images, and canvases share one conversation timeline.')}</p></article>
          <article><b>02</b><span>{t('Continue, Never Overwrite')}</span><p>{t('Every edit creates a clearly tracked version.')}</p></article>
          <article><b>03</b><span>{t('Privacy That Fits')}</span><p>{t('Accounts keep content long term; guest access ends with the session.')}</p></article>
        </section>
        <AppDialog open={guestModal} onClose={() => { setGuestModal(false); setGuestFormError(''); setGuestErrorField(null); }} labelledBy="guest-dialog-title" describedBy="guest-dialog-description">
            <form className="dialog-card guest-dialog" onSubmit={startGuest} noValidate>
              <button type="button" className="dialog-close" onClick={() => { setGuestModal(false); setGuestFormError(''); setGuestErrorField(null); }} aria-label={t('Close')} data-tooltip={t('Close')} data-tooltip-placement="below">×</button>
              <span className="eyebrow">{t('Guest Session')}</span><h2 id="guest-dialog-title">{t('What Should We Call You?')}</h2>
              <p id="guest-dialog-description">{t('Choose a name so people can recognize you in the conversation.')}</p>
              <label>{t('Display Name')}<input ref={guestNameRef} name="guest-name" autoComplete="nickname" value={guestName} onChange={(event) => { setGuestName(event.target.value); setGuestFormError(''); setGuestErrorField(null); }} placeholder={t('For example, Alex…')} maxLength={60} aria-invalid={guestErrorField === 'name'} aria-describedby={guestErrorField === 'name' ? 'guest-form-error' : undefined} /></label>
              {guestFormError && <p id="guest-form-error" className="form-error" role="alert" aria-live="polite">{guestFormError}</p>}
              <div className="guest-session-note"><UiIcon name="info" size={17} /><span>{t('The session expires after 2 inactive hours. Content you send remains in the room.')}</span></div>
              <button type="submit" className="primary-button wide" disabled={busy}>{busy ? t('Opening Nét…') : t('Enter Nét')}</button>
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
        <label className="product-search"><UiIcon name="search" size={17} /><input name="room-search" type="search" autoComplete="off" value={roomQuery} onChange={(event) => { const value = event.target.value; setRoomQuery(value); setSidebarPeople([]); setSidebarPeopleLoading(actor?.kind === 'user' && value.trim().length >= 2); }} placeholder={actor?.kind === 'user' ? t('Search chats or people…') : t('Search conversations…')} aria-label={actor?.kind === 'user' ? t('Search conversations or people') : t('Search conversations')} /></label>
        <div className="sidebar-label"><span>{t('Recent')}</span><small>{t('{count} conversations', { count: rooms.length })}</small></div>
        <div className="room-list">
          {filteredRooms.map((room) => <button type="button" key={room.id} className={room.id === activeRoomId ? 'room-item active' : 'room-item'} onClick={() => selectRoom(room.id)}><span className="avatar" style={avatarStyle(room.name)}>{room.name.slice(0, 1)}</span><span><strong>{room.name}</strong><small>{room.preview}</small></span><span className="room-meta"><time>{timeLabel(room.lastActivity, locale)}</time>{room.unreadCount > 0 && <b aria-label={t('{count} unread messages', { count: room.unreadCount })}>{Math.min(room.unreadCount, 99)}</b>}</span></button>)}
          {!filteredRooms.length && !roomQuery.trim() && <p className="empty-copy">{t('No conversations yet.')}</p>}
          {actor?.kind === 'user' && roomQuery.trim().length >= 2 && <section className="sidebar-people" aria-label={t('People')}><div className="sidebar-label"><span>{t('People')}</span><small>{sidebarPeopleLoading ? t('Searching…') : t('{count} results', { count: sidebarPeople.length })}</small></div>{sidebarPeople.map((person) => <button type="button" key={person.id} onClick={() => void startDirectChat(person)} disabled={busy}><span className="avatar" style={{ '--avatar': person.avatarColor } as CSSProperties}>{person.displayName.slice(0, 1)}</span><span><strong>{person.displayName}</strong><small>{person.email}</small></span><UiIcon name="message" size={18} /></button>)}{!sidebarPeopleLoading && !filteredRooms.length && !sidebarPeople.length && <p className="empty-copy">{t('No results. Try another name or email.')}</p>}</section>}
        </div>
        {actor?.kind === 'guest' && <div className="guest-retention"><span>{t('Temporary Session')}</span><p>{t('You lose access when it ends. Messages and attached images remain in the room.')}</p></div>}
        <div className="account-card"><span className="avatar" style={avatarStyle(actor?.id ?? 'guest')}>{actor?.displayName.slice(0, 1)}</span><span><strong>{actor?.displayName}</strong><small>{actor?.kind === 'user' ? actor.email : t('Guest · up to 2 hours')}</small></span>{actor?.kind === 'user' ? <a href={signOutPath} aria-label={t('Sign Out')} data-tooltip={t('Sign Out')} data-tooltip-placement="above"><UiIcon name="external" size={18} /></a> : <button type="button" className="end-session-button" data-end-guest="true" onClick={() => setGuestEndConfirmOpen(true)} aria-label={t('End guest session')}>{t('End Session')}</button>}</div>
      </aside>

      <main id="main-content" className="conversation-panel">
        {activeRoom ? (
          <>
            <header className="conversation-header"><button type="button" className="mobile-menu" onClick={() => setSidebarOpen(true)} aria-label={t('Open conversation list')} data-tooltip={t('Conversation list')} data-tooltip-placement="below"><UiIcon name="menu" size={19} /></button><span className="avatar" style={avatarStyle(activeRoom.name)}>{activeRoom.name.slice(0, 1)}</span><div className="conversation-title"><strong>{activeRoom.name}</strong><small><i className={realtimeConnected && networkOnline ? '' : 'offline'} /> {realtimeConnected && networkOnline ? t('Synced') : t('Reconnecting…')}</small></div><div className="conversation-actions">{activeRoom.kind !== 'direct' && <button type="button" className="invite-header-action" onClick={() => void copyInvite()} aria-label={t('Copy invite link')} data-tooltip={t('Invite by Link')} data-tooltip-placement="below"><UiIcon name="link" size={17} /><span>{t('Invite')}</span></button>}{installPrompt && <button type="button" className="install-header-action" onClick={() => { void installPrompt.prompt(); setInstallPrompt(null); }} aria-label={t('Install App')} data-tooltip={t('Install App')} data-tooltip-placement="below"><UiIcon name="install" size={18} /></button>}<button type="button" onClick={() => setMessageQuery((value) => value ? '' : ' ')} aria-label={t('Search messages')} data-tooltip={t('Search Messages')} data-tooltip-placement="below"><UiIcon name="search" size={18} /></button><button type="button" onClick={() => setInfoOpen((value) => !value)} aria-label={t('Conversation details')} data-tooltip={t('Details')} data-tooltip-placement="below"><UiIcon name="info" size={18} /></button></div></header>
            {messageQuery !== '' && <div className="message-search"><span><UiIcon name="search" size={18} /></span><input name="message-search" autoComplete="off" value={messageQuery.trimStart()} onChange={(event) => setMessageQuery(event.target.value || ' ')} placeholder={t('Search content or sender…')} aria-label={t('Search message content')} /><small>{messageSearchLoading ? t('Searching…') : normalizedMessageQuery.length === 1 ? t('Enter 1 more character') : normalizedMessageQuery ? t('{count} results across full history', { count: messageSearchTotal }) : t('Search this conversation')}</small><button type="button" onClick={() => setMessageQuery('')} aria-label={t('Close search')} data-tooltip={t('Close Search')}><UiIcon name="close" size={17} /></button></div>}
            <section ref={messageScrollRef} className="message-scroll" aria-live="polite" aria-label={t('Message history')}>
              <div className="message-lane"><div className="day-pill">{t('Today')}</div>
                {nextCursor && !normalizedMessageQuery && <button type="button" className="load-older" onClick={() => void loadOlder()} disabled={loadingOlder}>{loadingOlder ? t('Loading…') : t('Load Older Messages')}</button>}
                {showInviteOnboarding && <section className="invite-onboarding" aria-labelledby="invite-onboarding-title"><span className="invite-onboarding-icon" aria-hidden="true"><UiIcon name="draw" size={22} /></span><div><h2 id="invite-onboarding-title">{t('Start Your Way')}</h2><p>{t('Invite someone to draw with you, or make the first mark and share it later.')}</p></div><div className="invite-onboarding-actions"><button type="button" className="primary-button" onClick={() => void copyInvite()}><UiIcon name="link" size={17} /> {t('Invite Someone')}</button><button type="button" className="secondary-button" onClick={() => openStudio({})}><UiIcon name="draw" size={17} /> {t('Draw Now')}</button></div></section>}
                {!visibleMessages.length && <div className="conversation-empty"><span aria-hidden="true"><UiIcon name="draw" size={28} /></span><h2>{normalizedMessageQuery ? t('No Messages Found') : t('Start with a Word or a Line')}</h2><p>{normalizedMessageQuery.length === 1 ? t('Enter at least 2 characters to search the full history.') : normalizedMessageQuery ? t('Try another keyword.') : t('Send a message, share an image, or open the canvas.')}</p></div>}
                {visibleMessages.map((message) => {
                  const own = actor?.kind === 'user' ? message.senderId === actor.id : message.guestSessionId === actor?.id;
                  const replied = message.replyToId ? messages.find((item) => item.id === message.replyToId) : null;
                  if (message.type === 'system') return <div key={message.id} className="system-message">{t(systemMessageKey(message.body))}</div>;
                  return (
                    <article key={message.id} className={own ? 'message-row own' : 'message-row'}>
                      {!own && <span className="avatar message-avatar" style={avatarStyle(message.senderName)}>{message.senderName.slice(0, 1)}</span>}
                      <div className="message-content">
                        {!own && <small className="sender-name">{message.senderName}</small>}
                        {replied && <button type="button" className="reply-context" onClick={() => document.getElementById(`message-${replied.id}`)?.scrollIntoView({ block: 'center' })}><strong>{replied.senderName}</strong><span>{replied.body || (replied.type === 'canvas' ? t('Drawing') : t('Image'))}</span></button>}
                        <div id={`message-${message.id}`} className="message-payload">
                          {message.assetUrl && <button type="button" className="message-media-button" onClick={() => setViewingMedia(message)} aria-label={message.type === 'canvas' ? t('Open drawing version {version}', { version: message.canvasVersion ?? 1 }) : t('Open image full screen')} data-tooltip={t('View Full Screen')} data-tooltip-placement="above">
                            {/* Assets use a short-lived, room-scoped signed URL so a plain img request can load them. */}
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img src={message.assetUrl} width="1200" height="720" loading="lazy" decoding="async" alt={message.type === 'canvas' ? t('Drawing version {version}', { version: message.canvasVersion ?? 1 }) : t('Image in the conversation')} onLoad={() => { if (message.assetKey) automaticAssetRefreshAttempts.current.delete(message.assetKey); }} onError={() => { if (message.assetKey) void refreshAssetUrl(message.assetKey, true); }} />
                            <span className="media-open-hint" aria-hidden="true"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5" /></svg></span>
                          </button>}
                          {message.type === 'canvas' && <span className="version-badge">{t('Version {version}', { version: message.canvasVersion ?? 1 })}</span>}
                          {message.body && <div className="message-bubble">{message.body}</div>}
                        </div>
                        <div className="message-meta"><time>{timeLabel(message.createdAt, locale)}</time>{own && <span>{message.readCount > 0 ? t('Read') : t('Sent')}</span>}</div>
                        <div className="reaction-list">{message.reactions.map((reaction) => <button type="button" key={reaction.emoji} className={reaction.reacted ? 'reacted' : ''} onClick={() => void react(message.id, reaction.emoji)} aria-label={reaction.reacted ? t('Remove {emoji} reaction, {count} total', { emoji: reaction.emoji, count: reaction.count }) : t('Add {emoji} reaction, {count} total', { emoji: reaction.emoji, count: reaction.count })}>{reaction.emoji} <span>{reaction.count}</span></button>)}</div>
                        <div className="message-tools"><button type="button" onClick={() => setReplyTo(message)}><UiIcon name="reply" size={16} /> <span>{t('Reply')}</span></button>{message.assetUrl && <button type="button" onClick={() => void downloadMedia(message)} disabled={downloadingAssetKey === (message.assetKey ?? message.id)} aria-label={downloadingAssetKey === (message.assetKey ?? message.id) ? t('Downloading image') : t('Download image')} data-tooltip={downloadingAssetKey === (message.assetKey ?? message.id) ? t('Downloading…') : t('Download Image')} data-tooltip-placement="above"><UiIcon name="download" size={16} /> <span>{downloadingAssetKey === (message.assetKey ?? message.id) ? t('Downloading…') : t('Download')}</span></button>}{message.type === 'canvas' && <button type="button" onClick={() => void continueDrawing(message)}><UiIcon name="draw" size={16} /> <span>{t('Continue Drawing')}</span></button>}<div>{EMOJIS.map((emoji) => <button type="button" key={emoji} onClick={() => void react(message.id, emoji)} aria-label={t('Add {emoji} reaction', { emoji })} data-tooltip={t('Add {emoji}', { emoji })}>{emoji}</button>)}</div></div>
                      </div>
                    </article>
                  );
                })}
                <div ref={endRef} />
              </div>
            </section>
            <footer className="composer-zone">
              {replyTo && <div className="reply-draft"><span>{t('Replying to')} <strong>{replyTo.senderName}</strong><small>{replyTo.body || (replyTo.type === 'canvas' ? t('Drawing') : t('Image'))}</small></span><button type="button" onClick={() => setReplyTo(null)} aria-label={t('Cancel reply')} data-tooltip={t('Cancel Reply')} data-tooltip-placement="above">×</button></div>}
              <div className="composer"><button type="button" onClick={() => fileRef.current?.click()} disabled={busy} aria-label={t('Choose image')} data-tooltip={t('Send Image')} data-tooltip-placement="above"><UiIcon name="plus" size={20} /></button><textarea name="message" autoComplete="off" value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void submitText(); } }} placeholder={t('Write a message…')} maxLength={2000} aria-label={t('Message content')} /><button type="button" className="draw-button" onClick={() => openStudio({})} disabled={busy} aria-label={t('Open canvas')} data-tooltip={t('Open Nét Studio')} data-tooltip-placement="above"><UiIcon name="draw" size={19} /></button><button type="button" className="send-button" onClick={() => void submitText()} disabled={busy || !draft.trim()} aria-label={t('Send message')} data-tooltip={t('Send Message')} data-tooltip-placement="above"><UiIcon name="send" size={18} /></button></div>
              <input ref={fileRef} hidden name="message-image" aria-label={t('Image file')} type="file" accept="image/png,image/jpeg,image/gif,image/webp" onChange={(event) => void attachImage(event)} />
              <p><kbd>Enter</kbd> {t('send')} · <kbd>Shift</kbd> + <kbd>Enter</kbd> {t('new line')} · {t('images up to 8 MB')}</p>
            </footer>
            {infoOpen && <aside className="info-drawer"><button type="button" className="dialog-close" onClick={() => setInfoOpen(false)} aria-label={t('Close')} data-tooltip={t('Close')} data-tooltip-placement="below">×</button><span className="avatar info-avatar" style={avatarStyle(activeRoom.name)}>{activeRoom.name.slice(0, 1)}</span><h2>{activeRoom.name}</h2><p>{t('A space to continue ideas with words and drawings.')}</p><div className="info-stats"><span><strong>{activeRoom.messageCount ?? messages.length}</strong><small>{t('Messages')}</small></span><span><strong>{activeRoom.mediaCount ?? messages.filter((item) => item.assetKey).length}</strong><small>{t('Images & Drawings')}</small></span></div>{activeRoom.kind !== 'direct' && <><label>{t('Invite Link')}<input name="invite-link" readOnly value={`${typeof window !== 'undefined' ? window.location.origin : ''}/?room=${activeRoom.inviteCode}`} /></label><button type="button" className="primary-button wide" onClick={() => void copyInvite()}>{t('Copy Invite Link')}</button></>}<small className="privacy-note"><UiIcon name="lock" size={15} /> {t('Signed-in members keep access long term. Guest messages and attached images remain after they leave.')}</small></aside>}
          </>
        ) : <div className="no-room"><Logo /><h1>{t('No Conversations Yet')}</h1><p>{actor?.kind === 'user' ? t('Find someone to message or create a new group.') : t('This invite link is no longer active.')}</p>{actor?.kind === 'user' && <button type="button" className="primary-button" onClick={() => openConversationStarter()}>{t('Start a Conversation')}</button>}</div>}
      </main>

      <AppDialog open={createRoomOpen} onClose={resetConversationStarter} labelledBy="create-room-title" describedBy="create-room-description">
        <section className="dialog-card conversation-starter">
          <button type="button" className="dialog-close" onClick={resetConversationStarter} aria-label={t('Close')} data-tooltip={t('Close')} data-tooltip-placement="below">×</button>
          <span className="eyebrow">{t('Quick Connect')}</span>
          <h2 id="create-room-title">{t('Start a Conversation')}</h2>
          <p id="create-room-description">{t('Find one person to message now, or select several people to create a group.')}</p>
          <div className="starter-modes" aria-label={t('Choose how to start')}>
            <button type="button" aria-pressed={conversationStartMode === 'direct'} className={conversationStartMode === 'direct' ? 'active' : ''} onClick={() => { setConversationStartMode('direct'); setConversationStartError(''); }}><UiIcon name="user" /><span><strong>{t('Direct Message')}</strong><small>{t('Select to open chat')}</small></span></button>
            <button type="button" aria-pressed={conversationStartMode === 'group'} className={conversationStartMode === 'group' ? 'active' : ''} onClick={() => { setConversationStartMode('group'); setConversationStartError(''); }}><UiIcon name="group" /><span><strong>{t('Create Group')}</strong><small>{t('At least 2 people')}</small></span></button>
          </div>

          <form className="people-picker" onSubmit={conversationStartMode === 'group' ? createRoom : (event) => event.preventDefault()}>
            <label>{conversationStartMode === 'direct' ? t('Who would you like to message?') : t('Add Members')}<div className="starter-search"><UiIcon name="search" /><input name="contact-search" type="search" autoComplete="off" value={contactQuery} onChange={(event) => { const value = event.target.value; setContactQuery(value); setContactResults([]); setContactSearching(value.trim().length >= 2); setConversationStartError(''); }} placeholder={t('Enter a name or email…')} aria-describedby="people-search-status" /></div></label>
            <div id="people-search-status" className="search-status" role="status" aria-live="polite">{contactSearching ? t('Searching…') : contactQuery.trim().length === 1 ? t('Enter 1 more character') : contactQuery.trim().length >= 2 ? t('{count} matching people', { count: availableContacts.length }) : conversationStartMode === 'direct' ? t('Choose someone to open a conversation immediately.') : t('Choose at least 2 people.')}</div>
            {selectedContacts.length > 0 && conversationStartMode === 'group' && <div className="selected-contacts" aria-label={t('Selected members')}>{selectedContacts.map((contact) => <button type="button" key={contact.id} aria-label={t('Remove {name} from group', { name: contact.displayName })} onClick={() => setSelectedContacts((current) => current.filter((item) => item.id !== contact.id))}>{contact.displayName}<span aria-hidden="true">×</span></button>)}</div>}
            {contactQuery.trim().length >= 2 && <div className="contact-results">{availableContacts.map((contact) => <button type="button" key={contact.id} disabled={busy} onClick={() => conversationStartMode === 'direct' ? void startDirectChat(contact) : setSelectedContacts((current) => [...current, contact])}><span className="avatar" style={{ '--avatar': contact.avatarColor } as CSSProperties}>{contact.displayName.slice(0, 1)}</span><span><strong>{contact.displayName}</strong><small>{contact.email}</small></span>{conversationStartMode === 'direct' ? <span className="result-action">{t('Message')} <UiIcon name="arrow" size={16} /></span> : <span className="result-action">{t('Add')} <UiIcon name="plus" size={16} /></span>}</button>)}{!contactSearching && availableContacts.length === 0 && <div className="contact-empty"><UiIcon name="search" /><strong>{t('No Person Found')}</strong><small>{t('Try another name or email.')}</small></div>}</div>}
            {conversationStartError && <p className="form-error" role="alert">{conversationStartError}</p>}
            {conversationStartMode === 'group' && <div className="group-options"><label>{t('Group Name')} <small>{t('(optional)')}</small><input name="room-name" autoComplete="off" value={roomName} onChange={(event) => setRoomName(event.target.value)} placeholder={t('Nét will suggest one from the members')} maxLength={60} /></label><label className="checkbox-row"><input type="checkbox" name="allow-guests" checked={allowGuests} onChange={(event) => setAllowGuests(event.target.checked)} /><span><strong>{t('Allow guests to join by link')}</strong><small>{t('Content sent by guests remains after they leave the session.')}</small></span></label><button type="submit" className="primary-button wide" disabled={busy || selectedContacts.length < 2}>{busy ? t('Creating group…') : t('Create Group{members}', { members: selectedContacts.length ? ` · ${selectedContacts.length + 1} ${t('people')}` : '' })}</button></div>}
          </form>
        </section>
      </AppDialog>
      <AppDialog open={guestEndConfirmOpen} onClose={() => setGuestEndConfirmOpen(false)} labelledBy="end-guest-title" describedBy="end-guest-description" className="confirmation-backdrop">
        <section className="dialog-card confirmation-dialog">
          <span className="eyebrow destructive">{t('Cannot Be Undone')}</span>
          <h2 id="end-guest-title">{t('End Guest Session?')}</h2>
          <p id="end-guest-description">{t('You will lose access immediately. Messages and attached images remain in the room; reactions, palette colors, and unattached uploads are removed.')}</p>
          <div className="confirmation-actions"><button type="button" onClick={() => setGuestEndConfirmOpen(false)}>{t('Keep Session')}</button><button type="button" className="danger-button" onClick={() => void endGuest()}>{t('End Session')}</button></div>
        </section>
      </AppDialog>
      {studio && <Suspense fallback={<div className="studio-loading" role="status">{t('Opening Nét Studio…')}</div>}><DrawingStudio sourceUrl={studio.sourceUrl} version={studio.version} paletteColors={paletteColors} paletteLoading={paletteLoading} paletteMutating={paletteMutating} palettePersistence={actor?.kind === 'user' ? 'account' : 'session'} onClose={closeStudio} onSend={sendDrawing} onSavePalette={savePaletteColor} onDeletePalette={deletePaletteColor} /></Suspense>}
      {viewingMedia && <MediaViewer key={viewingMedia.id} message={viewingMedia} downloading={downloadingAssetKey === (viewingMedia.assetKey ?? viewingMedia.id)} onClose={() => setViewingMedia(null)} onDownload={downloadMedia} onRefresh={(assetKey) => { void refreshAssetUrl(assetKey, true); }} />}
      {(error || notice) && <div className={error ? 'toast error' : 'toast'} role="status" aria-live="polite"><span>{error || notice}</span>{error && <button type="button" onClick={() => setError('')} aria-label={t('Dismiss notification')} data-tooltip={t('Dismiss notification')} data-tooltip-placement="above">×</button>}</div>}
    </div></>
  );
}
