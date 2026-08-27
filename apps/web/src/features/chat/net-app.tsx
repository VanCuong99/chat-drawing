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

const DrawingStudio = lazy(() => import('@/src/features/drawing/drawing-studio'));

type InitialUser = { id: string; displayName: string; email: string } | null;
type Phase = 'loading' | 'landing' | 'app';
type InstallPromptEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> };

class ApiRequestError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

const EMOJIS = ['❤️', '👍', '✨', '😂', '👀'];

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
  const [inviteCode, setInviteCode] = useState(() => typeof window === 'undefined' ? '' : new URLSearchParams(window.location.search).get('room') ?? '');
  const [createRoomOpen, setCreateRoomOpen] = useState(false);
  const [roomName, setRoomName] = useState('');
  const [contactQuery, setContactQuery] = useState('');
  const [contactResults, setContactResults] = useState<UserSummary[]>([]);
  const [selectedContacts, setSelectedContacts] = useState<UserSummary[]>([]);
  const [allowGuests, setAllowGuests] = useState(true);
  const [infoOpen, setInfoOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [studio, setStudio] = useState<{ sourceUrl?: string | null; parentId?: string | null; version?: number | null } | null>(null);
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
  const paletteMutationActiveRef = useRef(false);
  const paletteAbortRef = useRef<AbortController | null>(null);
  const actorIdRef = useRef<string | null>(null);
  const readMarkers = useRef(new Map<string, string>());
  const socketRef = useRef<Socket | null>(null);
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
    setActiveRoomId(null); setReplyTo(null); setPhase('landing'); setSidebarOpen(false); setInfoOpen(false);
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
    setSidebarOpen(false); setInfoOpen(false); setMessageQuery(''); setConversationAtBottom(false);
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
        if (queryInvite && data.actor?.kind === 'user' && !joinedInvite.current && !data.rooms.some((room) => room.inviteCode === queryInvite)) {
          joinedInvite.current = true;
          try {
            await api('/api/rooms/join', { method: 'POST', body: JSON.stringify({ inviteCode: queryInvite }) }, null);
            await loadBootstrap(null);
            setNotice('Đã tham gia cuộc trò chuyện từ link mời.');
          } catch (joinError) { setError(joinError instanceof Error ? joinError.message : 'Link mời không hợp lệ.'); }
        } else if (queryInvite && data.actor?.kind === 'guest' && !data.rooms.some((room) => room.inviteCode === queryInvite)) {
          setError('Bạn đang ở một phiên khách khác. Hãy kết thúc phiên hiện tại trước khi mở link mời mới.');
        }
      }).catch((bootstrapError) => {
        if (bootstrapError instanceof ApiRequestError && bootstrapError.status === 401 && savedGuest) {
          clearGuestSession('Phiên khách đã hết hạn. Nội dung tạm thời đã được xoá.');
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
  }, [api, bootstrapRetry, clearGuestSession, guestSession, initialUser, inviteCode, loadBootstrap]);

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
          clearGuestSession('Phiên khách đã hết hạn. Nội dung tạm thời đã được xoá.');
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
      const cursor = before ? `?before=${encodeURIComponent(before)}` : '';
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
        clearGuestSession('Phiên khách đã hết hạn. Nội dung tạm thời đã được xoá.');
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
          clearGuestSession('Phiên khách đã hết hạn. Nội dung tạm thời đã được xoá.');
        }
      });
  }, [activeRoomId, api, clearGuestSession, conversationAtBottom, guestSession, infoOpen, messages, normalizedMessageQuery, pageVisible, studio]);

  useEffect(() => {
    if (!actorId || phase !== 'app') return;
    let disposed = false;
    let refreshing = false;
    let lastRefresh = 0;
    const connect = async () => {
      try {
        const credentials = await api<{ token: string }>('/api/realtime/token', { method: 'POST' });
        if (disposed) return;
        const realtimeEndpoint = process.env.NEXT_PUBLIC_REALTIME_URL
          ?? (window.location.hostname === 'localhost' ? 'http://localhost:3001/chat' : '/chat');
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
            const next = await api<{ token: string }>('/api/realtime/token', { method: 'POST' });
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
        socket.on('guest.ended', (payload: { roomId?: string; guestSessionId?: string; messageIds?: string[] }) => {
          if (actor?.kind === 'guest' && payload.guestSessionId === actorId) {
            endingGuestRef.current = true;
            clearGuestSession('');
            setNotice('Phiên khách và nội dung tạm thời đã được xoá.');
            return;
          }
          if (payload.roomId === activeRoomRef.current && payload.messageIds?.length) {
            const deletedIds = new Set(payload.messageIds);
            setMessages((current) => current.filter((message) => !deletedIds.has(message.id)));
            setMessageSearchResults((current) => current.filter((message) => !deletedIds.has(message.id)));
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
  }, [actor?.kind, actorId, api, clearGuestSession, loadBootstrap, loadMessages, phase]);

  useEffect(() => {
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
    const poll = realtimeConnected ? null : window.setInterval(() => void loadMessages(activeRoomId, true), 3000);
    return () => { window.clearTimeout(initialLoad); if (poll) window.clearInterval(poll); };
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

  const startGuest = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true); setError('');
    try {
      const data = await api<{ sessionId: string }>('/api/guest', { method: 'POST', body: JSON.stringify({ displayName: guestName, inviteCode: inviteCode || undefined }) }, null);
      sessionStorage.setItem('net_guest_session', data.sessionId);
      endingGuestRef.current = false;
      setGuestSession(data.sessionId);
      setGuestModal(false);
      await loadBootstrap(data.sessionId);
    } catch (startError) { setError(startError instanceof Error ? startError.message : 'Không thể bắt đầu phiên khách.'); }
    setBusy(false);
  };

  const endGuest = async () => {
    if (endingGuestRef.current) return;
    setGuestEndConfirmOpen(false);
    endingGuestRef.current = true;
    try {
      await api('/api/guest', { method: 'DELETE' });
      clearGuestSession('');
      setNotice('Phiên khách và nội dung tạm thời đã được xoá.');
    } catch (endError) {
      if (endError instanceof ApiRequestError && endError.status === 401) {
        clearGuestSession('');
        setNotice('Phiên khách đã hết hạn và dữ liệu tạm thời đã được dọn dẹp.');
      } else {
        endingGuestRef.current = false;
        setError(endError instanceof Error ? endError.message : 'Chưa thể kết thúc phiên. Vui lòng thử lại.');
      }
    }
  };

  const createRoom = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true); setError('');
    try {
      const created = await api<{ id: string }>('/api/rooms', { method: 'POST', body: JSON.stringify({ name: roomName, allowGuests, memberIds: selectedContacts.map((contact) => contact.id) }) });
      await loadBootstrap();
      selectRoom(created.id); setCreateRoomOpen(false); setRoomName(''); setContactQuery(''); setContactResults([]); setSelectedContacts([]); setNotice('Đã tạo cuộc trò chuyện mới.');
    } catch (createError) { setError(createError instanceof Error ? createError.message : 'Không thể tạo phòng.'); }
    setBusy(false);
  };

  const searchContacts = async () => {
    if (contactQuery.trim().length < 2) { setContactResults([]); return; }
    try {
      const data = await api<{ users: UserSummary[] }>(`/api/users?q=${encodeURIComponent(contactQuery.trim())}`);
      setContactResults(data.users.filter((user) => !selectedContacts.some((selected) => selected.id === user.id)));
    } catch (searchError) { setError(searchError instanceof Error ? searchError.message : 'Không thể tìm thành viên.'); }
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
  const visibleMessages = useMemo(() => normalizedMessageQuery
    ? normalizedMessageQuery.length >= 2 ? messageSearchResults : []
    : messages, [messageSearchResults, messages, normalizedMessageQuery]);

  if (phase === 'loading') return <div className="boot-screen"><Logo /><span className="loading-line" /><p>{error || 'Đang mở không gian của bạn…'}</p>{error && <button className="primary-button" onClick={() => { setError(''); setBootstrapRetry((current) => current + 1); }}>Thử kết nối lại</button>}</div>;

  if (phase === 'landing') {
    return (
      <><a className="skip-link" href="#main-content">Bỏ qua đến nội dung chính</a><main id="main-content" className="landing-page">
        <nav className="landing-nav"><Logo /><div><a href="#how">Cách hoạt động</a><a href={signInPath} className="nav-signin">Đăng nhập</a></div></nav>
        <section className="hero">
          <div className="hero-copy">
            <span className="eyebrow">Nhắn bằng chữ. Tiếp lời bằng nét.</span>
            <h1>Có những điều,<br /><em>vẽ ra dễ hơn nói.</em></h1>
            <p>Nét là messenger dành cho những ý tưởng còn dang dở — gửi text, ảnh hoặc canvas; người nhận có thể vẽ tiếp thành một phiên bản mới.</p>
            <div className="hero-actions"><a className="hero-primary" href={signInPath}>Đăng nhập với ChatGPT <span>→</span></a><button onClick={() => setGuestModal(true)}>Tiếp tục với tư cách khách</button></div>
            <small>{inviteCode ? 'Bạn đang mở một link mời. Đăng nhập hoặc nhập tên để tham gia.' : 'Khách không cần tài khoản · Nội dung tự xoá khi kết thúc phiên'}</small>
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
          <article><b>03</b><span>Riêng tư theo cách của bạn</span><p>Tài khoản lưu lâu dài; phiên khách biến mất khi kết thúc.</p></article>
        </section>
        <AppDialog open={guestModal} onClose={() => setGuestModal(false)} labelledBy="guest-dialog-title" describedBy="guest-dialog-description">
            <form className="dialog-card guest-dialog" onSubmit={startGuest}>
              <button type="button" className="dialog-close" onClick={() => setGuestModal(false)} aria-label="Đóng">×</button>
              <span className="eyebrow">Phiên khách</span><h2 id="guest-dialog-title">{inviteCode ? 'Tham gia cuộc trò chuyện' : 'Bắt đầu một phiên tạm thời'}</h2>
              <p id="guest-dialog-description">Dữ liệu bạn tạo sẽ bị xoá khi phiên kết thúc hoặc hết hạn sau 2 giờ không hoạt động.</p>
              <label>Tên hiển thị<input name="guest-name" autoComplete="nickname" value={guestName} onChange={(event) => setGuestName(event.target.value)} placeholder="Ví dụ: Cường…" minLength={2} maxLength={60} /></label>
              <label>Mã mời <small>(không bắt buộc)</small><input name="invite-code" autoComplete="off" spellCheck={false} value={inviteCode} onChange={(event) => setInviteCode(event.target.value)} placeholder="Dán mã hoặc mở link mời…" /></label>
              {error && <p className="form-error" role="alert">{error}</p>}
              <button className="primary-button wide" disabled={busy}>{busy ? 'Đang mở phiên…' : 'Vào không gian Nét'}</button>
            </form>
        </AppDialog>
        {(error || notice) && <div className={error ? 'toast error' : 'toast'} role="status"><span>{error || notice}</span>{error && <button onClick={() => setError('')} aria-label="Đóng thông báo">×</button>}</div>}
      </main></>
    );
  }

  return (
    <><a className="skip-link" href="#main-content">Bỏ qua đến nội dung chính</a><div className="product-root">
      <button type="button" className={sidebarOpen ? 'sidebar-scrim show' : 'sidebar-scrim'} onClick={() => setSidebarOpen(false)} aria-label="Đóng danh sách trò chuyện" />
      <aside className={sidebarOpen ? 'product-sidebar open' : 'product-sidebar'}>
        <div className="sidebar-head"><Logo compact /><button className="mobile-close" onClick={() => setSidebarOpen(false)} aria-label="Đóng danh sách">×</button>{actor?.kind === 'user' && <button className="new-room-button" onClick={() => setCreateRoomOpen(true)} aria-label="Tạo cuộc trò chuyện">＋</button>}</div>
        <label className="product-search"><span>⌕</span><input name="room-search" type="search" autoComplete="off" value={roomQuery} onChange={(event) => setRoomQuery(event.target.value)} placeholder="Tìm cuộc trò chuyện…" aria-label="Tìm cuộc trò chuyện" /></label>
        <div className="sidebar-label"><span>Gần đây</span><small>{rooms.length} cuộc trò chuyện</small></div>
        <div className="room-list">
          {filteredRooms.map((room) => <button key={room.id} className={room.id === activeRoomId ? 'room-item active' : 'room-item'} onClick={() => selectRoom(room.id)}><span className="avatar" style={avatarStyle(room.name)}>{room.name.slice(0, 1)}</span><span><strong>{room.name}</strong><small>{room.preview}</small></span><span className="room-meta"><time>{timeLabel(room.lastActivity)}</time>{room.unreadCount > 0 && <b aria-label={`${room.unreadCount} tin chưa đọc`}>{Math.min(room.unreadCount, 99)}</b>}</span></button>)}
          {!filteredRooms.length && <p className="empty-copy">Không tìm thấy cuộc trò chuyện.</p>}
        </div>
        {actor?.kind === 'guest' && <div className="guest-retention"><span>Phiên tạm thời</span><p>Nội dung của bạn sẽ bị xoá khi kết thúc phiên.</p></div>}
        <div className="account-card"><span className="avatar" style={avatarStyle(actor?.id ?? 'guest')}>{actor?.displayName.slice(0, 1)}</span><span><strong>{actor?.displayName}</strong><small>{actor?.kind === 'user' ? actor.email : 'Khách · tối đa 2 giờ'}</small></span>{actor?.kind === 'user' ? <a href={signOutPath} title="Đăng xuất" aria-label="Đăng xuất">↗</a> : <button className="end-session-button" onClick={() => setGuestEndConfirmOpen(true)} aria-label="Kết thúc phiên khách">Kết thúc phiên</button>}</div>
      </aside>

      <main id="main-content" className="conversation-panel">
        {activeRoom ? (
          <>
            <header className="conversation-header"><button className="mobile-menu" onClick={() => setSidebarOpen(true)} aria-label="Mở danh sách trò chuyện">☰</button><span className="avatar" style={avatarStyle(activeRoom.name)}>{activeRoom.name.slice(0, 1)}</span><div><strong>{activeRoom.name}</strong><small><i className={realtimeConnected && networkOnline ? '' : 'offline'} /> {realtimeConnected && networkOnline ? 'kết nối trực tiếp' : 'đồng bộ dự phòng'}</small></div><div className="conversation-actions">{installPrompt && <button onClick={() => { void installPrompt.prompt(); setInstallPrompt(null); }} aria-label="Cài ứng dụng">⇩</button>}<button onClick={() => setMessageQuery((value) => value ? '' : ' ')} aria-label="Tìm trong tin nhắn">⌕</button><button onClick={() => setInfoOpen((value) => !value)} aria-label="Thông tin cuộc trò chuyện">i</button></div></header>
            {messageQuery !== '' && <div className="message-search"><span>⌕</span><input name="message-search" autoComplete="off" value={messageQuery.trimStart()} onChange={(event) => setMessageQuery(event.target.value || ' ')} placeholder="Tìm nội dung hoặc người gửi…" aria-label="Tìm nội dung tin nhắn" /><small>{messageSearchLoading ? 'Đang tìm…' : normalizedMessageQuery.length === 1 ? 'Nhập thêm 1 ký tự' : normalizedMessageQuery ? `${messageSearchTotal} kết quả trong toàn bộ lịch sử` : 'Tìm trong cuộc trò chuyện'}</small><button onClick={() => setMessageQuery('')} aria-label="Đóng tìm kiếm">×</button></div>}
            <section ref={messageScrollRef} className="message-scroll" aria-live="polite" aria-label="Lịch sử tin nhắn">
              <div className="message-lane"><div className="day-pill">Hôm nay</div>
                {nextCursor && !normalizedMessageQuery && <button className="load-older" onClick={() => void loadOlder()} disabled={loadingOlder}>{loadingOlder ? 'Đang tải…' : 'Tải tin nhắn cũ hơn'}</button>}
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
                          {message.assetUrl && (
                            // Assets use a short-lived, room-scoped signed URL so a plain img request can load them.
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={message.assetUrl} width="1200" height="720" loading="lazy" decoding="async" alt={message.type === 'canvas' ? `Bản vẽ phiên bản ${message.canvasVersion ?? 1}` : 'Hình ảnh trong cuộc trò chuyện'} onLoad={() => { if (message.assetKey) automaticAssetRefreshAttempts.current.delete(message.assetKey); }} onError={() => { if (message.assetKey) void refreshAssetUrl(message.assetKey, true); }} />
                          )}
                          {message.type === 'canvas' && <span className="version-badge">Phiên bản {message.canvasVersion ?? 1}</span>}
                          {message.body && <div className="message-bubble">{message.body}</div>}
                        </div>
                        <div className="message-meta"><time>{timeLabel(message.createdAt)}</time>{own && <span>{message.readCount > 0 ? 'Đã xem' : 'Đã gửi'}</span>}</div>
                        <div className="reaction-list">{message.reactions.map((reaction) => <button key={reaction.emoji} className={reaction.reacted ? 'reacted' : ''} onClick={() => void react(message.id, reaction.emoji)}>{reaction.emoji} <span>{reaction.count}</span></button>)}</div>
                        <div className="message-tools"><button onClick={() => setReplyTo(message)}>↩ <span>Trả lời</span></button>{message.type === 'canvas' && <button onClick={() => void continueDrawing(message)}>⌁ <span>Vẽ tiếp</span></button>}<div>{EMOJIS.map((emoji) => <button key={emoji} onClick={() => void react(message.id, emoji)} aria-label={`Thả ${emoji}`}>{emoji}</button>)}</div></div>
                      </div>
                    </article>
                  );
                })}
                <div ref={endRef} />
              </div>
            </section>
            <footer className="composer-zone">
              {replyTo && <div className="reply-draft"><span>Đang trả lời <strong>{replyTo.senderName}</strong><small>{replyTo.body || (replyTo.type === 'canvas' ? 'Bản vẽ' : 'Hình ảnh')}</small></span><button onClick={() => setReplyTo(null)} aria-label="Bỏ trả lời">×</button></div>}
              <div className="composer"><button onClick={() => fileRef.current?.click()} disabled={busy} aria-label="Chọn ảnh">＋</button><textarea name="message" autoComplete="off" value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void submitText(); } }} placeholder="Nhắn điều gì đó…" maxLength={2000} aria-label="Nội dung tin nhắn" /><button className="draw-button" onClick={() => openStudio({})} disabled={busy} aria-label="Mở canvas">⌁</button><button className="send-button" onClick={() => void submitText()} disabled={busy || !draft.trim()} aria-label="Gửi tin nhắn">↑</button></div>
              <input ref={fileRef} hidden name="message-image" aria-label="Tệp hình ảnh" type="file" accept="image/png,image/jpeg,image/gif,image/webp" onChange={(event) => void attachImage(event)} />
              <p><kbd>Enter</kbd> gửi · <kbd>Shift</kbd> + <kbd>Enter</kbd> xuống dòng · ảnh tối đa 8 MB</p>
            </footer>
            {infoOpen && <aside className="info-drawer"><button className="dialog-close" onClick={() => setInfoOpen(false)} aria-label="Đóng">×</button><span className="avatar info-avatar" style={avatarStyle(activeRoom.name)}>{activeRoom.name.slice(0, 1)}</span><h2>{activeRoom.name}</h2><p>Không gian để mọi người tiếp nối ý tưởng bằng chữ và nét vẽ.</p><div className="info-stats"><span><strong>{activeRoom.messageCount ?? messages.length}</strong><small>Tin nhắn</small></span><span><strong>{activeRoom.mediaCount ?? messages.filter((item) => item.assetKey).length}</strong><small>Ảnh & nét</small></span></div>{activeRoom.allowGuests && <><label>Link mời<input name="invite-link" readOnly value={`${typeof window !== 'undefined' ? window.location.origin : ''}/?room=${activeRoom.inviteCode}`} /></label><button className="primary-button wide" onClick={() => void copyInvite()}>Sao chép link mời</button></>}<small className="privacy-note">🔒 Thành viên đăng nhập được lưu lâu dài. Nội dung do khách tạo sẽ hết hạn theo phiên.</small></aside>}
          </>
        ) : <div className="no-room"><Logo /><h1>Chưa có cuộc trò chuyện</h1><p>{actor?.kind === 'user' ? 'Tạo một không gian mới rồi mời ai đó cùng vẽ.' : 'Link mời không còn hiệu lực.'}</p>{actor?.kind === 'user' && <button className="primary-button" onClick={() => setCreateRoomOpen(true)}>Tạo cuộc trò chuyện</button>}</div>}
      </main>

      <AppDialog open={createRoomOpen} onClose={() => setCreateRoomOpen(false)} labelledBy="create-room-title" describedBy="create-room-description">
        <form className="dialog-card" onSubmit={createRoom}>
          <button type="button" className="dialog-close" onClick={() => setCreateRoomOpen(false)} aria-label="Đóng">×</button>
          <span className="eyebrow">Không gian mới</span>
          <h2 id="create-room-title">Tạo một cuộc trò chuyện</h2>
          <p id="create-room-description">Tìm người đã dùng Nét hoặc tạo link để mời thành viên và khách.</p>
          <label>Tìm người bằng tên hoặc email
            <div className="contact-search"><input name="contact-search" type="search" autoComplete="off" value={contactQuery} onChange={(event) => setContactQuery(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); void searchContacts(); } }} placeholder="Nhập ít nhất 2 ký tự…" /><button type="button" onClick={() => void searchContacts()}>Tìm</button></div>
          </label>
          {selectedContacts.length > 0 && <div className="selected-contacts">{selectedContacts.map((contact) => <button type="button" key={contact.id} onClick={() => setSelectedContacts((current) => current.filter((item) => item.id !== contact.id))}>{contact.displayName} ×</button>)}</div>}
          {contactResults.length > 0 && <div className="contact-results">{contactResults.map((contact) => <button type="button" key={contact.id} onClick={() => { setSelectedContacts((current) => [...current, contact]); setContactResults((current) => current.filter((item) => item.id !== contact.id)); }}><span className="avatar" style={{ '--avatar': contact.avatarColor } as CSSProperties}>{contact.displayName.slice(0, 1)}</span><span><strong>{contact.displayName}</strong><small>{contact.email}</small></span><b>＋</b></button>)}</div>}
          <label>Tên cuộc trò chuyện <small>{selectedContacts.length === 1 ? '(có thể để trống)' : ''}</small><input name="room-name" autoComplete="off" value={roomName} onChange={(event) => setRoomName(event.target.value)} placeholder={selectedContacts.length === 1 ? 'Tự đặt theo hai thành viên…' : 'Ví dụ: Góc ban công…'} minLength={2} maxLength={60} /></label>
          <label className="checkbox-row"><input type="checkbox" name="allow-guests" checked={allowGuests} onChange={(event) => setAllowGuests(event.target.checked)} /><span><strong>Cho phép khách tham gia</strong><small>Dữ liệu do khách tạo chỉ tồn tại trong phiên</small></span></label>
          <button className="primary-button wide" disabled={busy || (!roomName.trim() && selectedContacts.length !== 1)}>{busy ? 'Đang tạo…' : selectedContacts.length === 1 ? 'Bắt đầu trò chuyện' : 'Tạo và lấy link mời'}</button>
        </form>
      </AppDialog>
      <AppDialog open={guestEndConfirmOpen} onClose={() => setGuestEndConfirmOpen(false)} labelledBy="end-guest-title" describedBy="end-guest-description" className="confirmation-backdrop">
        <section className="dialog-card confirmation-dialog">
          <span className="eyebrow destructive">Không thể hoàn tác</span>
          <h2 id="end-guest-title">Kết thúc phiên khách?</h2>
          <p id="end-guest-description">Toàn bộ tin nhắn, bản vẽ, hình ảnh, reaction và màu đã lưu của phiên này sẽ bị xoá vĩnh viễn.</p>
          <div className="confirmation-actions"><button type="button" onClick={() => setGuestEndConfirmOpen(false)}>Giữ lại phiên</button><button type="button" className="danger-button" onClick={() => void endGuest()}>Xoá và kết thúc phiên</button></div>
        </section>
      </AppDialog>
      {studio && <Suspense fallback={<div className="studio-loading" role="status">Đang mở Studio Nét…</div>}><DrawingStudio sourceUrl={studio.sourceUrl} version={studio.version} paletteColors={paletteColors} paletteLoading={paletteLoading} paletteMutating={paletteMutating} onClose={closeStudio} onSend={sendDrawing} onSavePalette={savePaletteColor} onDeletePalette={deletePaletteColor} /></Suspense>}
      {(error || notice) && <div className={error ? 'toast error' : 'toast'} role="status"><span>{error || notice}</span>{error && <button onClick={() => setError('')} aria-label="Đóng thông báo">×</button>}</div>}
    </div></>
  );
}
