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

type UiIconName = 'arrow' | 'check' | 'close' | 'download' | 'draw' | 'external' | 'group' | 'info' | 'install' | 'link' | 'menu' | 'message' | 'plus' | 'reply' | 'search' | 'send' | 'user';

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

function timeLabel(value: number) {
  const date = new Date(value);
  const today = new Date();
  return date.toDateString() === today.toDateString()
    ? new Intl.DateTimeFormat('vi-VN', { hour: '2-digit', minute: '2-digit' }).format(date)
    : new Intl.DateTimeFormat('vi-VN', { day: '2-digit', month: '2-digit' }).format(date);
}

function localDateStamp(value: number) {
  const date = new Date(value);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function Logo({ compact = false }: { compact?: boolean }) {
  return (
    <div className={compact ? 'net-logo compact-logo' : 'net-logo'}>
      <span className="logo-mark" aria-hidden="true"><i /><i /><i /></span>
      <span><strong>Nét</strong>{!compact && <small>vẽ điều khó nói</small>}</span>
    </div>
  );
}

export default function NetApp({ initialUser, initialApiToken, signInPath, signOutPath }: { initialUser: InitialUser; initialApiToken: string | null; signInPath: string; signOutPath: string }) {
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
  const normalizedMessageQuery = messageQuery.trim().toLocaleLowerCase('vi');

  const api = useCallback(async <T,>(path: string, init: RequestInit = {}, sessionOverride?: string | null): Promise<T> => {
    const session = sessionOverride === undefined ? guestSession : sessionOverride;
    const headers = new Headers(init.headers);
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
    if (!response.ok) throw new ApiRequestError(response.status, data.error ?? 'Không thể hoàn tất yêu cầu.');
    return data;
  }, [apiToken, guestSession, initialUser]);

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
            setNotice('Đã mở cuộc trò chuyện từ link mời.');
          } catch (joinError) {
            joinedInvite.current = false;
            setPhase('app');
            setError(joinError instanceof Error ? joinError.message : 'Link mời không hợp lệ.');
          }
        } else if (queryInvite && data.actor?.kind === 'guest') {
          const invitedRoom = data.rooms.find((room) => room.inviteCode === queryInvite);
          if (invitedRoom) {
            selectRoom(invitedRoom.id);
            consumeInvite();
          } else {
            setError('Bạn đang ở một phiên khách khác. Hãy kết thúc phiên hiện tại trước khi mở link mời mới.');
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
          clearGuestSession('Phiên khách đã hết hạn. Bạn không còn quyền truy cập; nội dung chỉ được giữ nếu phòng có thành viên đăng nhập.');
          return;
        }
        setError(navigator.onLine
          ? 'Chưa thể kết nối tới Nét. Phiên của bạn vẫn được giữ; hãy thử lại sau một chút.'
          : 'Bạn đang ngoại tuyến. Phiên của bạn vẫn được giữ và sẽ khôi phục khi có mạng.');
        setPhase(savedGuest || initialUser ? 'loading' : 'landing');
      });
    }, 0);
    const onInstall = (event: Event) => { event.preventDefault(); setInstallPrompt(event as InstallPromptEvent); };
    window.addEventListener('beforeinstallprompt', onInstall);
    return () => { window.clearTimeout(boot); window.removeEventListener('beforeinstallprompt', onInstall); };
  }, [api, bootstrapRetry, clearGuestSession, consumeInvite, guestSession, initialUser, inviteCode, loadBootstrap, selectRoom]);

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
      if (target instanceof Element && target.closest('[aria-label="Kết thúc phiên khách"]')) return;
      const now = Date.now();
      if (now - lastTouch < 5 * 60 * 1000) return;
      lastTouch = now;
      void api('/api/guest/activity', { method: 'POST' }).catch((activityError) => {
        if (activityError instanceof ApiRequestError && activityError.status === 401 && sessionStorage.getItem('net_guest_session')) {
          clearGuestSession('Phiên khách đã hết hạn. Bạn không còn quyền truy cập; nội dung chỉ được giữ nếu phòng có thành viên đăng nhập.');
        }
      });
    };
    window.addEventListener('pointerdown', touch, { passive: true });
    window.addEventListener('keydown', touch);
    return () => { window.removeEventListener('pointerdown', touch); window.removeEventListener('keydown', touch); };
  }, [actor?.kind, api, clearGuestSession]);

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
        clearGuestSession('Phiên khách đã hết hạn. Bạn không còn quyền truy cập; nội dung chỉ được giữ nếu phòng có thành viên đăng nhập.');
        return;
      }
      if (!quiet) setError(loadError instanceof Error ? loadError.message : 'Không thể tải tin nhắn.');
    }
  }, [api, clearGuestSession, guestSession]);

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
    if (!activeRoomId || !conversationAtBottom || !pageVisible || normalizedMessageQuery || infoOpen || studio || !messages.length) return;
    const newest = messages[messages.length - 1];
    if (!newest || newest.id === readMarkers.current.get(activeRoomId)) return;
    readMarkers.current.set(activeRoomId, newest.id);
    void api(`/api/rooms/${activeRoomId}/messages`, { method: 'PATCH', body: JSON.stringify({ messageId: newest.id }) })
      .then(() => setRooms((current) => current.map((room) => room.id === activeRoomId ? { ...room, unreadCount: 0 } : room)))
      .catch((readError) => {
        readMarkers.current.delete(activeRoomId);
        if (readError instanceof ApiRequestError && readError.status === 401 && guestSession) {
          clearGuestSession('Phiên khách đã hết hạn. Bạn không còn quyền truy cập; nội dung chỉ được giữ nếu phòng có thành viên đăng nhập.');
        }
      });
  }, [activeRoomId, api, clearGuestSession, conversationAtBottom, guestSession, infoOpen, messages, normalizedMessageQuery, pageVisible, studio]);

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
              ? 'Phiên khách đã kết thúc. Bạn không còn quyền truy cập; nội dung đã gửi vẫn được giữ lại trong phòng.'
              : 'Phiên khách đã kết thúc. Phòng chưa có thành viên đăng nhập nên nội dung tạm thời đã được xoá.');
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
  }, [activeRoomId, actor?.kind, actorId, api, clearGuestSession, loadBootstrap, loadMessages, networkOnline, phase]);

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
          setRealtimeConnected(true);
          const roomId = activeRoomRef.current;
          if (roomId) socket.emit('room.subscribe', { roomId }, (ack: { ok: boolean; roomId?: string }) => {
            if (!ack?.ok || ack.roomId !== activeRoomRef.current) {
              setRealtimeConnected(false);
              return;
            }
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
        socket.on('message.created', (payload: { roomId?: string }) => {
          refreshActiveRoom(payload);
          void loadBootstrap();
        });
        socket.on('reaction.updated', refreshActiveRoom);
        socket.on('messages.read', refreshActiveRoom);
        socket.on('guest.ended', (payload: { roomId?: string; guestSessionId?: string; messageIds?: string[]; retained?: boolean; removedReactions?: Array<{ messageId: string; emoji: string }> }) => {
          if (actor?.kind === 'guest' && payload.guestSessionId === actorId) {
            endingGuestRef.current = true;
            clearGuestSession('');
            setNotice(payload.retained
              ? 'Phiên khách đã kết thúc. Bạn không còn quyền truy cập; nội dung đã gửi vẫn được giữ lại trong phòng.'
              : 'Phiên khách đã kết thúc. Phòng chưa có thành viên đăng nhập nên nội dung tạm thời đã được xoá.');
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
  }, [activeRoomId, actor?.kind, actorId, api, clearGuestSession, loadBootstrap, loadMessages, phase]);

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
    if (!activeRoomId || phase !== 'app' || realtimeConnected) return;
    const poll = window.setInterval(() => void loadMessages(activeRoomId, true), 3000);
    return () => window.clearInterval(poll);
  }, [activeRoomId, loadMessages, phase, realtimeConnected]);

  useEffect(() => {
    if (!notice) return;
    const timeout = window.setTimeout(() => setNotice(''), 2600);
    return () => window.clearTimeout(timeout);
  }, [notice]);

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
        setError(searchError instanceof Error ? searchError.message : 'Không thể tìm tin nhắn.');
      }).finally(() => {
        if (generation === messageSearchGeneration.current) setMessageSearchLoading(false);
      });
    }, 250);
    return () => window.clearTimeout(timeout);
  }, [activeRoomId, api, normalizedMessageQuery]);

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
          setConversationStartError(searchError instanceof Error ? searchError.message : 'Không thể tìm thành viên.');
        })
        .finally(() => {
          if (generation === contactSearchGeneration.current) setContactSearching(false);
        });
    }, 220);
    return () => window.clearTimeout(timeout);
  }, [actor?.kind, api, contactQuery, conversationStartMode, createRoomOpen]);

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
      setGuestFormError('Vui lòng nhập tên hiển thị.');
      setGuestErrorField('name');
      guestNameRef.current?.focus();
      return;
    }
    if (displayName.length < 2) {
      setGuestFormError('Tên hiển thị cần ít nhất 2 ký tự.');
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
      setGuestFormError(startError instanceof Error ? startError.message : 'Không thể bắt đầu phiên khách.');
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
        ? 'Phiên khách đã kết thúc. Bạn không còn quyền truy cập; nội dung đã gửi vẫn được giữ lại trong phòng.'
        : 'Phiên khách đã kết thúc. Phòng chưa có thành viên đăng nhập nên nội dung tạm thời đã được xoá.');
    } catch (endError) {
      if (endError instanceof ApiRequestError && endError.status === 401) {
        clearGuestSession('');
        setNotice('Phiên khách đã hết hạn. Bạn không còn quyền truy cập; nội dung chỉ được giữ nếu phòng có thành viên đăng nhập.');
      } else {
        endingGuestRef.current = false;
        setError(endError instanceof Error ? endError.message : 'Chưa thể kết thúc phiên. Vui lòng thử lại.');
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
      setNotice(created.reused ? `Đã mở lại cuộc trò chuyện với ${contact.displayName}.` : `Đã bắt đầu trò chuyện với ${contact.displayName}.`);
    } catch (createError) {
      const message = createError instanceof Error ? createError.message : 'Không thể bắt đầu cuộc trò chuyện.';
      if (createRoomOpen) setConversationStartError(message);
      else setError(message);
    }
    setBusy(false);
  };

  const createRoom = async (event: FormEvent) => {
    event.preventDefault();
    if (selectedContacts.length < 2) {
      setConversationStartError('Chọn ít nhất 2 người để tạo nhóm. Nếu chỉ có một người, hãy nhắn riêng.');
      return;
    }
    setBusy(true); setConversationStartError('');
    try {
      const created = await api<{ id: string }>('/api/rooms', { method: 'POST', body: JSON.stringify({ name: roomName, allowGuests, memberIds: selectedContacts.map((contact) => contact.id) }) });
      await loadBootstrap();
      selectRoom(created.id);
      resetConversationStarter();
      setNotice('Đã tạo nhóm mới.');
    } catch (createError) { setConversationStartError(createError instanceof Error ? createError.message : 'Không thể tạo nhóm.'); }
    setBusy(false);
  };

  const sendMessage = async (payload: { type: 'text' | 'image' | 'canvas'; text?: string; assetKey?: string; canvasParentId?: string | null }) => {
    if (!activeRoomId) return;
    const clientRequestId = crypto.randomUUID();
    const request = () => api(`/api/rooms/${activeRoomId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ ...payload, replyToId: replyTo?.id ?? null, clientRequestId }),
    });
    try { await request(); }
    catch (requestError) {
      if (!(requestError instanceof TypeError)) throw requestError;
      await request();
    }
    setDraft(''); setReplyTo(null);
    await Promise.all([loadMessages(activeRoomId), loadBootstrap()]);
  };

  const submitText = async () => {
    const text = draft.trim();
    if (!text || busy) return;
    setBusy(true); setError('');
    try { await sendMessage({ type: 'text', text }); }
    catch (sendError) { setError(sendError instanceof Error ? sendError.message : 'Không thể gửi tin nhắn.'); }
    setBusy(false);
  };

  const uploadAsset = async (blob: Blob) => {
    if (!activeRoomId) throw new Error('Chưa chọn cuộc trò chuyện.');
    return api<{ key: string }>(`/api/assets?room=${encodeURIComponent(activeRoomId)}`, { method: 'POST', headers: { 'content-type': blob.type }, body: blob });
  };

  const attachImage = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setBusy(true); setError('');
    try {
      const asset = await uploadAsset(file);
      await sendMessage({ type: 'image', assetKey: asset.key });
    } catch (uploadError) { setError(uploadError instanceof Error ? uploadError.message : 'Không thể gửi ảnh.'); }
    setBusy(false);
  };

  const closeStudio = () => {
    if (paletteMutationActiveRef.current) {
      setError('Bảng màu đang được cập nhật. Studio sẽ đóng được ngay sau khi hoàn tất.');
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
      await sendMessage({ type: 'canvas', assetKey: asset.key, text: caption || undefined, canvasParentId: studio?.parentId ?? null });
      closeStudio();
    } catch (drawingError) { setError(drawingError instanceof Error ? drawingError.message : 'Không thể gửi bản vẽ.'); }
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
          setError(paletteError instanceof Error ? paletteError.message : 'Không thể mở bảng màu.');
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
        setError(assetError instanceof Error ? assetError.message : 'Không thể làm mới quyền xem ảnh.');
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
        if (!refreshed) throw new Error('Không thể làm mới quyền tải ảnh.');
        assetUrl = refreshed;
        response = await fetch(assetUrl);
      }
      if (!response.ok) throw new Error('Không thể tải dữ liệu ảnh.');
      const blob = await response.blob();
      const extension = ({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp' } as Record<string, string>)[blob.type] ?? 'png';
      const date = localDateStamp(message.createdAt);
      const label = message.type === 'canvas' ? `ban-ve-v${message.canvasVersion ?? 1}` : 'hinh-anh';
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = objectUrl;
      anchor.download = `net-${label}-${date}.${extension}`;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
      setNotice('Đã tải ảnh về thiết bị.');
    } catch (downloadError) {
      setError(downloadError instanceof Error ? downloadError.message : 'Không thể tải ảnh xuống.');
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
    if (paletteLoading || paletteMutationActiveRef.current) throw new Error('Bảng màu đang bận. Vui lòng thử lại sau một chút.');
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
    if (paletteLoading || paletteMutationActiveRef.current) throw new Error('Bảng màu đang bận. Vui lòng thử lại sau một chút.');
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
    } catch (reactionError) { setError(reactionError instanceof Error ? reactionError.message : 'Không thể thả reaction.'); }
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
      setNotice('Đã sao chép link mời.');
    } catch { setError('Trình duyệt chưa cho phép sao chép. Bạn có thể chọn link và sao chép thủ công.'); }
  };

  const filteredRooms = rooms.filter((room) => `${room.name} ${room.preview}`.toLocaleLowerCase('vi').includes(roomQuery.trim().toLocaleLowerCase('vi')));
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

  if (phase === 'loading') return <div className="boot-screen"><Logo /><span className="loading-line" /><p>{error || 'Đang mở không gian của bạn…'}</p>{error && <button className="primary-button" onClick={() => { setError(''); setBootstrapRetry((current) => current + 1); }}>Thử kết nối lại</button>}</div>;

  if (phase === 'landing') {
    return (
      <><a className="skip-link" href="#main-content">Bỏ qua đến nội dung chính</a><main id="main-content" className="landing-page">
        <nav className="landing-nav"><Logo /><div><a href="#how">Cách hoạt động</a><a href={inviteStatus === 'invalid' ? homeSignInPath : inviteSignInPath} className="nav-signin">Đăng nhập</a></div></nav>
        <section className="hero">
          <div className="hero-copy">
            <span className="eyebrow">{inviteReady ? 'Lời mời đang chờ bạn' : inviteStatus === 'auth-only' ? 'Lời mời dành cho thành viên' : inviteStatus === 'invalid' ? 'Không thể mở lời mời' : inviteStatus === 'unavailable' ? 'Kết nối đang gián đoạn' : 'Nhắn bằng chữ. Tiếp lời bằng nét.'}</span>
            <h1>{inviteReady ? <>Vào phòng,<br /><em>chỉ cần một cái tên.</em></> : inviteStatus === 'auth-only' ? <>Đăng nhập,<br /><em>rồi vào phòng ngay.</em></> : inviteStatus === 'invalid' ? <>Link mời,<br /><em>không còn hiệu lực.</em></> : inviteStatus === 'unavailable' ? <>Chưa thể,<br /><em>kiểm tra lời mời.</em></> : <>Có những điều,<br /><em>vẽ ra dễ hơn nói.</em></>}</h1>
            <p>{inviteReady ? 'Không cần tìm phòng, không cần nhập lại mã. Chọn tên hiển thị rồi bắt đầu trò chuyện và vẽ cùng mọi người.' : inviteStatus === 'auth-only' ? 'Phòng này không nhận khách. Sau khi đăng nhập, Nét sẽ tự đưa bạn vào đúng cuộc trò chuyện.' : inviteStatus === 'invalid' ? 'Lời mời có thể đã hết hạn hoặc phòng không còn tồn tại. Hãy nhờ người gửi chia sẻ một link mới.' : inviteStatus === 'unavailable' ? 'Nét chưa thể xác minh link do kết nối tạm thời gián đoạn. Link của bạn vẫn được giữ nguyên để thử lại.' : 'Nét là messenger dành cho những ý tưởng còn dang dở — gửi text, ảnh hoặc canvas; người nhận có thể vẽ tiếp thành một phiên bản mới.'}</p>
            {inviteReady ? <section className="invite-join-panel" aria-labelledby="invite-join-title">
              <div className="invite-join-status"><span><UiIcon name="check" /></span><div><strong id="invite-join-title">Phòng đã sẵn sàng</strong><small>Chúng tôi đã nhận link mời của bạn.</small></div></div>
              <form className="invite-join-form" onSubmit={startGuest} noValidate>
                <label>Tên hiển thị<input ref={guestNameRef} autoFocus name="guest-invite-name" autoComplete="nickname" value={guestName} onChange={(event) => { setGuestName(event.target.value); setGuestFormError(''); setGuestErrorField(null); }} placeholder="Ví dụ: Cường…" maxLength={60} aria-invalid={guestErrorField === 'name'} aria-describedby={guestFormError ? 'guest-form-error' : undefined} /></label>
                <button className="hero-primary" disabled={busy}>{busy ? 'Đang vào phòng…' : <>Tham gia <UiIcon name="arrow" size={18} /></>}</button>
              </form>
              {guestFormError && <p id="guest-form-error" className="form-error" role="alert" aria-live="polite">{guestFormError}</p>}
              <div className="invite-join-alternatives"><a href={inviteSignInPath}>Đăng nhập để vào ngay</a><button type="button" onClick={() => { consumeInvite(); setGuestFormError(''); setGuestErrorField(null); }}>Về trang chủ</button></div>
              <small>Khách mất quyền truy cập khi phiên kết thúc. Nội dung chỉ được lưu lâu dài khi phòng có thành viên đăng nhập.</small>
            </section> : inviteStatus === 'auth-only' ? <section className="invite-join-panel invite-state-panel" aria-labelledby="invite-auth-title">
              <div className="invite-join-status"><span><UiIcon name="user" /></span><div><strong id="invite-auth-title">Phòng chỉ nhận thành viên đăng nhập</strong><small>Link đã được kiểm tra và vẫn còn hiệu lực.</small></div></div>
              <a className="hero-primary" href={inviteSignInPath}>Đăng nhập và vào phòng <UiIcon name="arrow" size={18} /></a>
              <button type="button" onClick={consumeInvite}>Về trang chủ</button>
            </section> : inviteStatus === 'invalid' ? <section className="invite-join-panel invite-state-panel invalid" aria-labelledby="invite-invalid-title">
              <div className="invite-join-status"><span><UiIcon name="link" /></span><div><strong id="invite-invalid-title">Không tìm thấy phòng từ link này</strong><small>Nét chưa yêu cầu tên hoặc thông tin đăng nhập của bạn.</small></div></div>
              <button type="button" className="hero-primary" onClick={consumeInvite}>Về trang chủ</button>
            </section> : inviteStatus === 'unavailable' ? <section className="invite-join-panel invite-state-panel" aria-labelledby="invite-unavailable-title">
              <div className="invite-join-status"><span><UiIcon name="link" /></span><div><strong id="invite-unavailable-title">Link vẫn đang được giữ</strong><small>Thử lại khi kết nối ổn định hơn.</small></div></div>
              <button type="button" className="hero-primary" onClick={() => setBootstrapRetry((current) => current + 1)}>Thử kiểm tra lại</button>
              <button type="button" onClick={consumeInvite}>Về trang chủ</button>
            </section> : <>
              <div className="hero-actions"><a className="hero-primary" href={signInPath}>Đăng nhập tài khoản <UiIcon name="arrow" size={18} /></a><button onClick={() => { setError(''); setGuestFormError(''); setGuestErrorField(null); setGuestModal(true); }}>Dùng thử không cần tài khoản</button></div>
              <small>Khách không cần tài khoản · Mất quyền truy cập khi kết thúc phiên</small>
            </>}
          </div>
          <div className="hero-demo" aria-label="Minh hoạ cuộc trò chuyện bằng chữ và nét vẽ">
            <div className="demo-top"><span className="avatar" style={avatarStyle('minh')}>M</span><div><strong>Minh Anh</strong><small><i /> đang vẽ cùng bạn</small></div><b>•••</b></div>
            <div className="demo-canvas"><span className="demo-sun" /><span className="demo-line line-a" /><span className="demo-line line-b" /><strong>Góc này<br />thêm cây nhé?</strong><i>↙</i></div>
            <div className="demo-message">Để tớ vẽ tiếp ý này ✨</div>
            <div className="demo-version"><span>⌁</span><div><small>Phiên bản 2</small><strong>Một ý tưởng được tiếp nối</strong></div></div>
          </div>
        </section>
        <section className="feature-strip" id="how">
          <article><b>01</b><span>Gửi như một tin nhắn</span><p>Text, ảnh và canvas nằm chung trong dòng hội thoại.</p></article>
          <article><b>02</b><span>Vẽ tiếp, không ghi đè</span><p>Mỗi lần chỉnh sửa tạo một phiên bản có lịch sử rõ ràng.</p></article>
          <article><b>03</b><span>Riêng tư theo cách của bạn</span><p>Tài khoản lưu lâu dài; khách mất quyền truy cập khi phiên kết thúc.</p></article>
        </section>
        <AppDialog open={guestModal} onClose={() => { setGuestModal(false); setGuestFormError(''); setGuestErrorField(null); }} labelledBy="guest-dialog-title" describedBy="guest-dialog-description">
            <form className="dialog-card guest-dialog" onSubmit={startGuest} noValidate>
              <button type="button" className="dialog-close" onClick={() => { setGuestModal(false); setGuestFormError(''); setGuestErrorField(null); }} aria-label="Đóng" data-tooltip="Đóng" data-tooltip-placement="below">×</button>
              <span className="eyebrow">Phiên khách</span><h2 id="guest-dialog-title">Bạn muốn được gọi là gì?</h2>
              <p id="guest-dialog-description">Chọn một tên để mọi người nhận ra bạn trong cuộc trò chuyện.</p>
              <label>Tên hiển thị<input ref={guestNameRef} name="guest-name" autoComplete="nickname" value={guestName} onChange={(event) => { setGuestName(event.target.value); setGuestFormError(''); setGuestErrorField(null); }} placeholder="Ví dụ: Cường…" maxLength={60} aria-invalid={guestErrorField === 'name'} aria-describedby={guestErrorField === 'name' ? 'guest-form-error' : undefined} /></label>
              {guestFormError && <p id="guest-form-error" className="form-error" role="alert" aria-live="polite">{guestFormError}</p>}
              <div className="guest-session-note"><UiIcon name="info" size={17} /><span>Phiên hết hạn sau 2 giờ không hoạt động. Nội dung được lưu lâu dài khi phòng có thành viên đăng nhập.</span></div>
              <button className="primary-button wide" disabled={busy}>{busy ? 'Đang mở Nét…' : 'Vào Nét'}</button>
            </form>
        </AppDialog>
        {(error || notice) && <div className={error ? 'toast error' : 'toast'} role="status"><span>{error || notice}</span>{error && <button onClick={() => setError('')} aria-label="Đóng thông báo" data-tooltip="Đóng thông báo" data-tooltip-placement="above">×</button>}</div>}
      </main></>
    );
  }

  return (
    <><a className="skip-link" href="#main-content">Bỏ qua đến nội dung chính</a><div className="product-root">
      <button type="button" className={sidebarOpen ? 'sidebar-scrim show' : 'sidebar-scrim'} onClick={() => setSidebarOpen(false)} aria-label="Đóng danh sách trò chuyện" />
      <aside className={sidebarOpen ? 'product-sidebar open' : 'product-sidebar'}>
        <div className="sidebar-head"><Logo compact /><button className="mobile-close" onClick={() => setSidebarOpen(false)} aria-label="Đóng danh sách" data-tooltip="Đóng danh sách" data-tooltip-placement="below">×</button></div>
        {actor?.kind === 'user' && <button className="new-conversation-button" onClick={() => openConversationStarter()}><span><UiIcon name="message" /></span>Bắt đầu trò chuyện<UiIcon name="plus" size={18} /></button>}
        <label className="product-search"><UiIcon name="search" size={17} /><input name="room-search" type="search" autoComplete="off" value={roomQuery} onChange={(event) => { const value = event.target.value; setRoomQuery(value); setSidebarPeople([]); setSidebarPeopleLoading(actor?.kind === 'user' && value.trim().length >= 2); }} placeholder={actor?.kind === 'user' ? 'Tìm chat hoặc người…' : 'Tìm cuộc trò chuyện…'} aria-label={actor?.kind === 'user' ? 'Tìm cuộc trò chuyện hoặc người' : 'Tìm cuộc trò chuyện'} /></label>
        <div className="sidebar-label"><span>Gần đây</span><small>{rooms.length} cuộc trò chuyện</small></div>
        <div className="room-list">
          {filteredRooms.map((room) => <button key={room.id} className={room.id === activeRoomId ? 'room-item active' : 'room-item'} onClick={() => selectRoom(room.id)}><span className="avatar" style={avatarStyle(room.name)}>{room.name.slice(0, 1)}</span><span><strong>{room.name}</strong><small>{room.preview}</small></span><span className="room-meta"><time>{timeLabel(room.lastActivity)}</time>{room.unreadCount > 0 && <b aria-label={`${room.unreadCount} tin chưa đọc`}>{Math.min(room.unreadCount, 99)}</b>}</span></button>)}
          {!filteredRooms.length && !roomQuery.trim() && <p className="empty-copy">Chưa có cuộc trò chuyện nào.</p>}
          {actor?.kind === 'user' && roomQuery.trim().length >= 2 && <section className="sidebar-people" aria-label="Mọi người"><div className="sidebar-label"><span>Mọi người</span><small>{sidebarPeopleLoading ? 'Đang tìm…' : `${sidebarPeople.length} kết quả`}</small></div>{sidebarPeople.map((person) => <button type="button" key={person.id} onClick={() => void startDirectChat(person)} disabled={busy}><span className="avatar" style={{ '--avatar': person.avatarColor } as CSSProperties}>{person.displayName.slice(0, 1)}</span><span><strong>{person.displayName}</strong><small>{person.email}</small></span><UiIcon name="message" size={18} /></button>)}{!sidebarPeopleLoading && !filteredRooms.length && !sidebarPeople.length && <p className="empty-copy">Không thấy kết quả. Thử tên hoặc email khác.</p>}</section>}
        </div>
        {actor?.kind === 'guest' && <div className="guest-retention"><span>Phiên tạm thời</span><p>Bạn mất quyền truy cập khi kết thúc. Nội dung chỉ được lưu lâu dài khi phòng có thành viên đăng nhập.</p></div>}
        <div className="account-card"><span className="avatar" style={avatarStyle(actor?.id ?? 'guest')}>{actor?.displayName.slice(0, 1)}</span><span><strong>{actor?.displayName}</strong><small>{actor?.kind === 'user' ? actor.email : 'Khách · tối đa 2 giờ'}</small></span>{actor?.kind === 'user' ? <a href={signOutPath} aria-label="Đăng xuất" data-tooltip="Đăng xuất" data-tooltip-placement="above"><UiIcon name="external" size={18} /></a> : <button className="end-session-button" onClick={() => setGuestEndConfirmOpen(true)} aria-label="Kết thúc phiên khách">Kết thúc phiên</button>}</div>
      </aside>

      <main id="main-content" className="conversation-panel">
        {activeRoom ? (
          <>
            <header className="conversation-header"><button className="mobile-menu" onClick={() => setSidebarOpen(true)} aria-label="Mở danh sách trò chuyện" data-tooltip="Danh sách trò chuyện" data-tooltip-placement="below"><UiIcon name="menu" size={19} /></button><span className="avatar" style={avatarStyle(activeRoom.name)}>{activeRoom.name.slice(0, 1)}</span><div className="conversation-title"><strong>{activeRoom.name}</strong><small><i className={realtimeConnected && networkOnline ? '' : 'offline'} /> {realtimeConnected && networkOnline ? 'Đã đồng bộ' : 'Đang kết nối lại'}</small></div><div className="conversation-actions">{activeRoom.kind !== 'direct' && <button className="invite-header-action" onClick={() => void copyInvite()} aria-label="Sao chép link mời" data-tooltip="Mời bằng link" data-tooltip-placement="below"><UiIcon name="link" size={17} /><span>Mời</span></button>}{installPrompt && <button className="install-header-action" onClick={() => { void installPrompt.prompt(); setInstallPrompt(null); }} aria-label="Cài ứng dụng" data-tooltip="Cài ứng dụng" data-tooltip-placement="below"><UiIcon name="install" size={18} /></button>}<button onClick={() => setMessageQuery((value) => value ? '' : ' ')} aria-label="Tìm trong tin nhắn" data-tooltip="Tìm tin nhắn" data-tooltip-placement="below"><UiIcon name="search" size={18} /></button><button onClick={() => setInfoOpen((value) => !value)} aria-label="Thông tin cuộc trò chuyện" data-tooltip="Thông tin" data-tooltip-placement="below"><UiIcon name="info" size={18} /></button></div></header>
            {messageQuery !== '' && <div className="message-search"><span><UiIcon name="search" size={18} /></span><input name="message-search" autoComplete="off" value={messageQuery.trimStart()} onChange={(event) => setMessageQuery(event.target.value || ' ')} placeholder="Tìm nội dung hoặc người gửi…" aria-label="Tìm nội dung tin nhắn" /><small>{messageSearchLoading ? 'Đang tìm…' : normalizedMessageQuery.length === 1 ? 'Nhập thêm 1 ký tự' : normalizedMessageQuery ? `${messageSearchTotal} kết quả trong toàn bộ lịch sử` : 'Tìm trong cuộc trò chuyện'}</small><button onClick={() => setMessageQuery('')} aria-label="Đóng tìm kiếm" data-tooltip="Đóng tìm kiếm"><UiIcon name="close" size={17} /></button></div>}
            <section ref={messageScrollRef} className="message-scroll" aria-live="polite" aria-label="Lịch sử tin nhắn">
              <div className="message-lane"><div className="day-pill">Hôm nay</div>
                {nextCursor && !normalizedMessageQuery && <button className="load-older" onClick={() => void loadOlder()} disabled={loadingOlder}>{loadingOlder ? 'Đang tải…' : 'Tải tin nhắn cũ hơn'}</button>}
                {showInviteOnboarding && <section className="invite-onboarding" aria-labelledby="invite-onboarding-title"><span className="invite-onboarding-icon" aria-hidden="true"><UiIcon name="draw" size={22} /></span><div><h2 id="invite-onboarding-title">Bắt đầu theo cách của bạn</h2><p>Mời một người cùng vẽ, hoặc đặt nét đầu tiên rồi chia sẻ sau.</p></div><div className="invite-onboarding-actions"><button className="primary-button" onClick={() => void copyInvite()}><UiIcon name="link" size={17} /> Mời người cùng vẽ</button><button className="secondary-button" onClick={() => openStudio({})}><UiIcon name="draw" size={17} /> Vẽ ngay</button></div></section>}
                {!visibleMessages.length && <div className="conversation-empty"><span>⌁</span><h2>{normalizedMessageQuery ? 'Không tìm thấy tin nhắn' : 'Bắt đầu bằng một lời hoặc một nét'}</h2><p>{normalizedMessageQuery.length === 1 ? 'Nhập ít nhất 2 ký tự để tìm trong toàn bộ lịch sử.' : normalizedMessageQuery ? 'Thử một từ khoá khác.' : 'Nhắn điều gì đó, gửi ảnh hoặc mở canvas.'}</p></div>}
                {visibleMessages.map((message) => {
                  const own = actor?.kind === 'user' ? message.senderId === actor.id : message.guestSessionId === actor?.id;
                  const replied = message.replyToId ? messages.find((item) => item.id === message.replyToId) : null;
                  if (message.type === 'system') return <div key={message.id} className="system-message">{message.body}</div>;
                  return (
                    <article key={message.id} className={own ? 'message-row own' : 'message-row'}>
                      {!own && <span className="avatar message-avatar" style={avatarStyle(message.senderName)}>{message.senderName.slice(0, 1)}</span>}
                      <div className="message-content">
                        {!own && <small className="sender-name">{message.senderName}</small>}
                        {replied && <button className="reply-context" onClick={() => document.getElementById(`message-${replied.id}`)?.scrollIntoView({ block: 'center' })}><strong>{replied.senderName}</strong><span>{replied.body || (replied.type === 'canvas' ? 'Bản vẽ' : 'Hình ảnh')}</span></button>}
                        <div id={`message-${message.id}`} className="message-payload">
                          {message.assetUrl && <button type="button" className="message-media-button" onClick={() => setViewingMedia(message)} aria-label={message.type === 'canvas' ? `Mở bản vẽ phiên bản ${message.canvasVersion ?? 1}` : 'Mở hình ảnh toàn màn hình'} data-tooltip="Xem toàn màn hình" data-tooltip-placement="above">
                            {/* Assets use a short-lived, room-scoped signed URL so a plain img request can load them. */}
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img src={message.assetUrl} width="1200" height="720" loading="lazy" decoding="async" alt={message.type === 'canvas' ? `Bản vẽ phiên bản ${message.canvasVersion ?? 1}` : 'Hình ảnh trong cuộc trò chuyện'} onLoad={() => { if (message.assetKey) automaticAssetRefreshAttempts.current.delete(message.assetKey); }} onError={() => { if (message.assetKey) void refreshAssetUrl(message.assetKey, true); }} />
                            <span className="media-open-hint" aria-hidden="true"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5" /></svg></span>
                          </button>}
                          {message.type === 'canvas' && <span className="version-badge">Phiên bản {message.canvasVersion ?? 1}</span>}
                          {message.body && <div className="message-bubble">{message.body}</div>}
                        </div>
                        <div className="message-meta"><time>{timeLabel(message.createdAt)}</time>{own && <span>{message.readCount > 0 ? 'Đã xem' : 'Đã gửi'}</span>}</div>
                        <div className="reaction-list">{message.reactions.map((reaction) => <button key={reaction.emoji} className={reaction.reacted ? 'reacted' : ''} onClick={() => void react(message.id, reaction.emoji)} aria-label={`${reaction.reacted ? 'Gỡ' : 'Thả'} cảm xúc ${reaction.emoji}`}>{reaction.emoji} <span>{reaction.count}</span></button>)}</div>
                        <div className="message-tools"><button onClick={() => setReplyTo(message)}><UiIcon name="reply" size={16} /> <span>Trả lời</span></button>{message.assetUrl && <button onClick={() => void downloadMedia(message)} disabled={downloadingAssetKey === (message.assetKey ?? message.id)} aria-label={downloadingAssetKey === (message.assetKey ?? message.id) ? 'Đang tải hình ảnh' : 'Tải hình ảnh xuống'} data-tooltip={downloadingAssetKey === (message.assetKey ?? message.id) ? 'Đang tải…' : 'Tải ảnh'} data-tooltip-placement="above"><UiIcon name="download" size={16} /> <span>{downloadingAssetKey === (message.assetKey ?? message.id) ? 'Đang tải…' : 'Tải ảnh'}</span></button>}{message.type === 'canvas' && <button onClick={() => void continueDrawing(message)}><UiIcon name="draw" size={16} /> <span>Vẽ tiếp</span></button>}<div>{EMOJIS.map((emoji) => <button key={emoji} onClick={() => void react(message.id, emoji)} aria-label={`Thả ${emoji}`} data-tooltip={`Thả ${emoji}`}>{emoji}</button>)}</div></div>
                      </div>
                    </article>
                  );
                })}
                <div ref={endRef} />
              </div>
            </section>
            <footer className="composer-zone">
              {replyTo && <div className="reply-draft"><span>Đang trả lời <strong>{replyTo.senderName}</strong><small>{replyTo.body || (replyTo.type === 'canvas' ? 'Bản vẽ' : 'Hình ảnh')}</small></span><button onClick={() => setReplyTo(null)} aria-label="Bỏ trả lời" data-tooltip="Bỏ trả lời" data-tooltip-placement="above">×</button></div>}
              <div className="composer"><button onClick={() => fileRef.current?.click()} disabled={busy} aria-label="Chọn ảnh" data-tooltip="Gửi ảnh" data-tooltip-placement="above"><UiIcon name="plus" size={20} /></button><textarea name="message" autoComplete="off" value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void submitText(); } }} placeholder="Nhắn điều gì đó…" maxLength={2000} aria-label="Nội dung tin nhắn" /><button className="draw-button" onClick={() => openStudio({})} disabled={busy} aria-label="Mở canvas" data-tooltip="Mở Studio Nét" data-tooltip-placement="above"><UiIcon name="draw" size={19} /></button><button className="send-button" onClick={() => void submitText()} disabled={busy || !draft.trim()} aria-label="Gửi tin nhắn" data-tooltip="Gửi tin nhắn" data-tooltip-placement="above"><UiIcon name="send" size={18} /></button></div>
              <input ref={fileRef} hidden name="message-image" aria-label="Tệp hình ảnh" type="file" accept="image/png,image/jpeg,image/gif,image/webp" onChange={(event) => void attachImage(event)} />
              <p><kbd>Enter</kbd> gửi · <kbd>Shift</kbd> + <kbd>Enter</kbd> xuống dòng · ảnh tối đa 8 MB</p>
            </footer>
            {infoOpen && <aside className="info-drawer"><button className="dialog-close" onClick={() => setInfoOpen(false)} aria-label="Đóng" data-tooltip="Đóng" data-tooltip-placement="below">×</button><span className="avatar info-avatar" style={avatarStyle(activeRoom.name)}>{activeRoom.name.slice(0, 1)}</span><h2>{activeRoom.name}</h2><p>Không gian để mọi người tiếp nối ý tưởng bằng chữ và nét vẽ.</p><div className="info-stats"><span><strong>{activeRoom.messageCount ?? messages.length}</strong><small>Tin nhắn</small></span><span><strong>{activeRoom.mediaCount ?? messages.filter((item) => item.assetKey).length}</strong><small>Ảnh & nét</small></span></div>{activeRoom.kind !== 'direct' && <><label>Link mời<input name="invite-link" readOnly value={`${typeof window !== 'undefined' ? window.location.origin : ''}/?room=${activeRoom.inviteCode}`} /></label><button className="primary-button wide" onClick={() => void copyInvite()}>Sao chép link mời</button></>}<small className="privacy-note">🔒 Thành viên đăng nhập được lưu lâu dài. Nội dung khách chỉ được giữ sau khi họ rời phiên nếu phòng có thành viên đăng nhập.</small></aside>}
          </>
        ) : <div className="no-room"><Logo /><h1>Chưa có cuộc trò chuyện</h1><p>{actor?.kind === 'user' ? 'Tìm một người để nhắn ngay hoặc tạo nhóm mới.' : 'Link mời không còn hiệu lực.'}</p>{actor?.kind === 'user' && <button className="primary-button" onClick={() => openConversationStarter()}>Bắt đầu trò chuyện</button>}</div>}
      </main>

      <AppDialog open={createRoomOpen} onClose={resetConversationStarter} labelledBy="create-room-title" describedBy="create-room-description">
        <section className="dialog-card conversation-starter">
          <button type="button" className="dialog-close" onClick={resetConversationStarter} aria-label="Đóng" data-tooltip="Đóng" data-tooltip-placement="below">×</button>
          <span className="eyebrow">Kết nối nhanh</span>
          <h2 id="create-room-title">Bắt đầu trò chuyện</h2>
          <p id="create-room-description">Tìm một người để nhắn ngay, hoặc chọn nhiều người để tạo nhóm.</p>
          <div className="starter-modes" aria-label="Chọn cách bắt đầu">
            <button type="button" aria-pressed={conversationStartMode === 'direct'} className={conversationStartMode === 'direct' ? 'active' : ''} onClick={() => { setConversationStartMode('direct'); setConversationStartError(''); }}><UiIcon name="user" /><span><strong>Nhắn riêng</strong><small>Chọn là mở chat</small></span></button>
            <button type="button" aria-pressed={conversationStartMode === 'group'} className={conversationStartMode === 'group' ? 'active' : ''} onClick={() => { setConversationStartMode('group'); setConversationStartError(''); }}><UiIcon name="group" /><span><strong>Tạo nhóm</strong><small>Từ 2 người</small></span></button>
          </div>

          <form className="people-picker" onSubmit={conversationStartMode === 'group' ? createRoom : (event) => event.preventDefault()}>
            <label>{conversationStartMode === 'direct' ? 'Bạn muốn nhắn cho ai?' : 'Thêm thành viên'}<div className="starter-search"><UiIcon name="search" /><input autoFocus name="contact-search" type="search" autoComplete="off" value={contactQuery} onChange={(event) => { const value = event.target.value; setContactQuery(value); setContactResults([]); setContactSearching(value.trim().length >= 2); setConversationStartError(''); }} placeholder="Nhập tên hoặc email…" aria-describedby="people-search-status" /></div></label>
            <div id="people-search-status" className="search-status" role="status" aria-live="polite">{contactSearching ? 'Đang tìm…' : contactQuery.trim().length === 1 ? 'Nhập thêm 1 ký tự' : contactQuery.trim().length >= 2 ? `${availableContacts.length} người phù hợp` : conversationStartMode === 'direct' ? 'Chọn một người để mở cuộc trò chuyện ngay.' : 'Chọn ít nhất 2 người.'}</div>
            {selectedContacts.length > 0 && conversationStartMode === 'group' && <div className="selected-contacts" aria-label="Thành viên đã chọn">{selectedContacts.map((contact) => <button type="button" key={contact.id} aria-label={`Xóa ${contact.displayName} khỏi nhóm`} onClick={() => setSelectedContacts((current) => current.filter((item) => item.id !== contact.id))}>{contact.displayName}<span aria-hidden="true">×</span></button>)}</div>}
            {contactQuery.trim().length >= 2 && <div className="contact-results">{availableContacts.map((contact) => <button type="button" key={contact.id} disabled={busy} onClick={() => conversationStartMode === 'direct' ? void startDirectChat(contact) : setSelectedContacts((current) => [...current, contact])}><span className="avatar" style={{ '--avatar': contact.avatarColor } as CSSProperties}>{contact.displayName.slice(0, 1)}</span><span><strong>{contact.displayName}</strong><small>{contact.email}</small></span>{conversationStartMode === 'direct' ? <span className="result-action">Nhắn tin <UiIcon name="arrow" size={16} /></span> : <span className="result-action">Thêm <UiIcon name="plus" size={16} /></span>}</button>)}{!contactSearching && availableContacts.length === 0 && <div className="contact-empty"><UiIcon name="search" /><strong>Chưa tìm thấy người này</strong><small>Thử tên hoặc email khác.</small></div>}</div>}
            {conversationStartError && <p className="form-error" role="alert">{conversationStartError}</p>}
            {conversationStartMode === 'group' && <div className="group-options"><label>Tên nhóm <small>(không bắt buộc)</small><input name="room-name" autoComplete="off" value={roomName} onChange={(event) => setRoomName(event.target.value)} placeholder="Nét sẽ gợi ý theo thành viên" maxLength={60} /></label><label className="checkbox-row"><input type="checkbox" name="allow-guests" checked={allowGuests} onChange={(event) => setAllowGuests(event.target.checked)} /><span><strong>Cho phép khách tham gia bằng link</strong><small>Nội dung khách gửi vẫn được giữ lại khi họ rời phiên.</small></span></label><button className="primary-button wide" disabled={busy || selectedContacts.length < 2}>{busy ? 'Đang tạo nhóm…' : `Tạo nhóm${selectedContacts.length ? ` · ${selectedContacts.length + 1} người` : ''}`}</button></div>}
          </form>
        </section>
      </AppDialog>
      <AppDialog open={guestEndConfirmOpen} onClose={() => setGuestEndConfirmOpen(false)} labelledBy="end-guest-title" describedBy="end-guest-description" className="confirmation-backdrop">
        <section className="dialog-card confirmation-dialog">
          <span className="eyebrow destructive">Không thể hoàn tác</span>
          <h2 id="end-guest-title">Kết thúc phiên khách?</h2>
          <p id="end-guest-description">Bạn sẽ mất quyền truy cập ngay. Nội dung chỉ được giữ lâu dài nếu phòng đã có thành viên đăng nhập; nếu chưa, nội dung tạm thời sẽ bị xoá.</p>
          <div className="confirmation-actions"><button type="button" onClick={() => setGuestEndConfirmOpen(false)}>Giữ lại phiên</button><button type="button" className="danger-button" onClick={() => void endGuest()}>Kết thúc phiên</button></div>
        </section>
      </AppDialog>
      {studio && <Suspense fallback={<div className="studio-loading" role="status">Đang mở Studio Nét…</div>}><DrawingStudio sourceUrl={studio.sourceUrl} version={studio.version} paletteColors={paletteColors} paletteLoading={paletteLoading} paletteMutating={paletteMutating} palettePersistence={actor?.kind === 'user' ? 'account' : 'session'} onClose={closeStudio} onSend={sendDrawing} onSavePalette={savePaletteColor} onDeletePalette={deletePaletteColor} /></Suspense>}
      {viewingMedia && <MediaViewer key={viewingMedia.id} message={viewingMedia} downloading={downloadingAssetKey === (viewingMedia.assetKey ?? viewingMedia.id)} onClose={() => setViewingMedia(null)} onDownload={downloadMedia} onRefresh={(assetKey) => { void refreshAssetUrl(assetKey, true); }} />}
      {(error || notice) && <div className={error ? 'toast error' : 'toast'} role="status"><span>{error || notice}</span>{error && <button onClick={() => setError('')} aria-label="Đóng thông báo" data-tooltip="Đóng thông báo" data-tooltip-placement="above">×</button>}</div>}
    </div></>
  );
}
