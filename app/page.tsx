'use client';

import {
  ChangeEvent,
  type CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent,
  useEffect,
  useRef,
  useState,
} from 'react';

type Message = {
  id: number;
  side: 'in' | 'out';
  text?: string;
  image?: string;
  art?: 'sun' | 'note';
  time: string;
};

type Conversation = {
  id: string;
  name: string;
  preview: string;
  time: string;
  color: string;
  status: string;
  description: string;
  members: number;
};

const initialMessages: Message[] = [
  { id: 1, side: 'in', text: 'Tớ đang nghĩ lại góc ban công. Cậu xem cách này ổn không?', time: '09:41' },
  { id: 2, side: 'in', art: 'sun', time: '09:42' },
  { id: 3, side: 'out', text: 'Ổn đó! Tớ thêm một chiếc bàn nhỏ ở đây nhé.', time: '09:44' },
  { id: 4, side: 'out', art: 'note', time: '09:45' },
  { id: 5, side: 'in', text: 'Đúng ý tớ luôn ✨', time: '09:46' },
];

const initialConversations: Conversation[] = [
  {
    id: 'minh-anh',
    name: 'Minh Anh',
    preview: 'Đúng ý tớ luôn ✨',
    time: '09:46',
    color: '#f7a85a',
    status: 'Đang hoạt động',
    description: 'Cùng trao đổi ý tưởng cho góc ban công.',
    members: 2,
  },
  {
    id: 'nha-moi',
    name: 'Nhóm Nhà Mới',
    preview: 'Hà đã gửi một bản vẽ',
    time: 'T3',
    color: '#7756e8',
    status: '4 thành viên',
    description: 'Tổng hợp ý tưởng nội thất và tiến độ căn nhà.',
    members: 4,
  },
  {
    id: 'tuan',
    name: 'Tuấn',
    preview: 'Cuối tuần chốt nhé!',
    time: 'T2',
    color: '#50b8a7',
    status: 'Hoạt động 12 phút trước',
    description: 'Các bản phác thảo cho dự án cuối tuần.',
    members: 2,
  },
];

const initialMessagesByConversation: Record<string, Message[]> = {
  'minh-anh': initialMessages,
  'nha-moi': [
    { id: 21, side: 'in', text: 'Mọi người xem bản phối màu mới nhé.', time: '14:08' },
    { id: 22, side: 'in', art: 'note', time: '14:09' },
    { id: 23, side: 'out', text: 'Mình thích hướng này, nhìn ấm hơn nhiều.', time: '14:16' },
  ],
  tuan: [
    { id: 31, side: 'in', text: 'Tớ đã thu gọn phần ghi chú rồi.', time: '20:32' },
    { id: 32, side: 'out', text: 'Ổn rồi. Cuối tuần mình chốt nhé!', time: '20:35' },
  ],
};

const suggestedContacts = [
  { id: 'lan-chi', name: 'Lan Chi', color: '#ef7668', status: 'Đang hoạt động' },
  { id: 'design-sprint', name: 'Nhóm Design Sprint', color: '#4f9db8', status: '6 thành viên' },
  { id: 'gia-dinh', name: 'Gia đình', color: '#d79a42', status: '5 thành viên' },
];

function ArtCard({ type }: { type: 'sun' | 'note' }) {
  if (type === 'note') {
    return (
      <div className="art-card note-card" aria-label="Bản vẽ ghi chú vị trí bàn">
        <span className="plant-pot" />
        <span className="table-line" />
        <span className="note-arrow">↙</span>
        <span className="note-copy">bàn nhỏ<br />ở đây</span>
      </div>
    );
  }

  return (
    <div className="art-card sun-card" aria-label="Bản phác thảo ban công buổi sáng">
      <span className="sun" />
      <span className="cloud cloud-one" />
      <span className="cloud cloud-two" />
      <span className="balcony-line line-one" />
      <span className="balcony-line line-two" />
      <span className="leaf leaf-one">⌁</span>
      <span className="leaf leaf-two">⌁</span>
      <strong>Nắng sáng ☀</strong>
    </div>
  );
}

function DrawingStudio({ onClose, onSend }: { onClose: () => void; onSend: (image: string, caption: string) => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const studioRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const drawing = useRef(false);
  const lastPoint = useRef({ x: 0, y: 0 });
  const [color, setColor] = useState('#6f4ee8');
  const [width, setWidth] = useState(6);
  const [caption, setCaption] = useState('');

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const ratio = window.devicePixelRatio || 1;
    canvas.width = rect.width * ratio;
    canvas.height = rect.height * ratio;
    const context = canvas.getContext('2d');
    if (!context) return;
    context.scale(ratio, ratio);
    context.fillStyle = '#fffdf8';
    context.fillRect(0, 0, rect.width, rect.height);
    context.lineCap = 'round';
    context.lineJoin = 'round';
  }, []);

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const frame = window.requestAnimationFrame(() => closeButtonRef.current?.focus());

    return () => {
      window.cancelAnimationFrame(frame);
      document.body.style.overflow = previousOverflow;
      previousFocus?.focus();
    };
  }, []);

  const point = (event: PointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  const begin = (event: PointerEvent<HTMLCanvasElement>) => {
    drawing.current = true;
    lastPoint.current = point(event);
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const draw = (event: PointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current) return;
    const context = canvasRef.current?.getContext('2d');
    if (!context) return;
    const next = point(event);
    context.beginPath();
    context.moveTo(lastPoint.current.x, lastPoint.current.y);
    context.lineTo(next.x, next.y);
    context.strokeStyle = color;
    context.lineWidth = width;
    context.stroke();
    lastPoint.current = next;
  };

  const clear = () => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !context) return;
    context.save();
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.fillStyle = '#fffdf8';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.restore();
  };

  const send = () => {
    const image = canvasRef.current?.toDataURL('image/png');
    if (image) onSend(image, caption.trim());
  };

  const handleDialogKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
      return;
    }

    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault();
      send();
      return;
    }

    if (event.key !== 'Tab') return;
    const focusable = Array.from(
      studioRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ) ?? [],
    );
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div className="studio-backdrop">
      <section
        ref={studioRef}
        className="studio"
        role="dialog"
        aria-modal="true"
        aria-labelledby="studio-title"
        aria-describedby="studio-description"
        onKeyDown={handleDialogKeyDown}
      >
        <header className="studio-header">
          <button ref={closeButtonRef} className="plain-button" onClick={onClose} aria-label="Đóng trình vẽ">
            Đóng <kbd>Esc</kbd>
          </button>
          <div>
            <span>Canvas mới</span>
            <h2 id="studio-title">Vẽ điều bạn muốn nói</h2>
          </div>
          <button className="send-drawing" onClick={send} aria-keyshortcuts="Control+Enter Meta+Enter">
            Gửi <kbd>⌘↵</kbd>
          </button>
        </header>

        <div className="canvas-wrap">
          <canvas
            ref={canvasRef}
            onPointerDown={begin}
            onPointerMove={draw}
            onPointerUp={() => (drawing.current = false)}
            onPointerCancel={() => (drawing.current = false)}
            aria-label="Vùng vẽ"
          />
          <span id="studio-description" className="canvas-hint">Dùng ngón tay hoặc chuột để bắt đầu vẽ</span>
        </div>

        <div className="drawing-tools">
          <div className="color-row" aria-label="Chọn màu nét vẽ">
            {['#26242a', '#6f4ee8', '#ef6f61', '#efad45', '#3aa694'].map((item) => (
              <button
                key={item}
                className={color === item ? 'color active' : 'color'}
                style={{ background: item }}
                onClick={() => setColor(item)}
                aria-label={`Chọn màu ${item}`}
              />
            ))}
          </div>
          <label className="brush-size">
            <span>Nét</span>
            <input type="range" min="2" max="18" value={width} onChange={(event) => setWidth(Number(event.target.value))} />
          </label>
          <button className="clear-button" onClick={clear}>Xoá canvas</button>
        </div>

        <input
          className="caption-input"
          name="drawing-caption"
          autoComplete="off"
          value={caption}
          onChange={(event) => setCaption(event.target.value)}
          placeholder="Thêm lời nhắn cho bản vẽ…"
          aria-label="Lời nhắn đi kèm bản vẽ"
        />
      </section>
    </div>
  );
}

export default function Home() {
  const [conversationList, setConversationList] = useState(initialConversations);
  const [messagesByConversation, setMessagesByConversation] = useState(initialMessagesByConversation);
  const [activeConversationId, setActiveConversationId] = useState('minh-anh');
  const [draft, setDraft] = useState('');
  const [studioOpen, setStudioOpen] = useState(false);
  const [attachmentMenu, setAttachmentMenu] = useState(false);
  const [shortcutOpen, setShortcutOpen] = useState(false);
  const [conversationQuery, setConversationQuery] = useState('');
  const [messageSearchOpen, setMessageSearchOpen] = useState(false);
  const [messageQuery, setMessageQuery] = useState('');
  const [infoOpen, setInfoOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [newChatOpen, setNewChatOpen] = useState(false);
  const [newChatQuery, setNewChatQuery] = useState('');
  const [mobileListOpen, setMobileListOpen] = useState(false);
  const [compactMode, setCompactMode] = useState(false);
  const [soundOn, setSoundOn] = useState(true);
  const [notificationsByConversation, setNotificationsByConversation] = useState<Record<string, boolean>>({});
  const [announcement, setAnnouncement] = useState('');
  const endRef = useRef<HTMLDivElement>(null);
  const messageAreaRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const messageSearchInputRef = useRef<HTMLInputElement>(null);
  const newChatInputRef = useRef<HTMLInputElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);

  const activeConversation = conversationList.find((item) => item.id === activeConversationId) ?? conversationList[0];
  const messages = messagesByConversation[activeConversationId] ?? [];
  const filteredConversations = conversationList.filter((conversation) =>
    `${conversation.name} ${conversation.preview}`.toLocaleLowerCase('vi').includes(conversationQuery.trim().toLocaleLowerCase('vi')),
  );
  const filteredContacts = suggestedContacts.filter((contact) =>
    contact.name.toLocaleLowerCase('vi').includes(newChatQuery.trim().toLocaleLowerCase('vi')),
  );
  const normalizedMessageQuery = messageQuery.trim().toLocaleLowerCase('vi');
  const messageMatchCount = normalizedMessageQuery
    ? messages.filter((message) => message.text?.toLocaleLowerCase('vi').includes(normalizedMessageQuery)).length
    : 0;
  const sharedMediaCount = messages.filter((message) => message.image || message.art).length;
  const modalOpen = studioOpen || newChatOpen;

  const now = () => new Intl.DateTimeFormat('vi-VN', { hour: '2-digit', minute: '2-digit' }).format(new Date());

  const updateConversationPreview = (conversationId: string, preview: string, time: string) => {
    setConversationList((current) => current.map((conversation) =>
      conversation.id === conversationId ? { ...conversation, preview, time } : conversation,
    ));
  };

  const appendMessage = (message: Omit<Message, 'id' | 'time'>) => {
    const targetId = activeConversationId;
    const sentAt = now();
    const preview = message.text || 'Đã gửi một hình ảnh';
    setMessagesByConversation((current) => ({
      ...current,
      [targetId]: [...(current[targetId] ?? []), { ...message, id: Date.now(), time: sentAt }],
    }));
    updateConversationPreview(targetId, preview, sentAt);
    setAnnouncement(message.text ? `Đã gửi: ${message.text}` : 'Đã gửi một hình ảnh');
    window.setTimeout(() => {
      const target = conversationList.find((conversation) => conversation.id === targetId);
      const reply = target?.members && target.members > 2
        ? 'Cả nhóm đã nhận được rồi — để tụi mình góp thêm ý nhé 👀'
        : 'Mình nhận được rồi — để mình vẽ thêm ý của mình nhé 👀';
      const replyAt = now();
      setMessagesByConversation((current) => ({
        ...current,
        [targetId]: [...(current[targetId] ?? []), { id: Date.now() + 1, side: 'in', text: reply, time: replyAt }],
      }));
      updateConversationPreview(targetId, reply, replyAt);
      setAnnouncement(`${target?.name ?? 'Người nhận'}: ${reply}`);
    }, 850);
  };

  const sendText = () => {
    const text = draft.trim();
    if (!text) return;
    appendMessage({ side: 'out', text });
    setDraft('');
    window.requestAnimationFrame(() => composerRef.current?.focus());
  };

  const sendDrawing = (image: string, caption: string) => {
    appendMessage({ side: 'out', image, text: caption || undefined });
    setStudioOpen(false);
  };

  const attachImage = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') appendMessage({ side: 'out', image: reader.result });
    };
    reader.readAsDataURL(file);
    setAttachmentMenu(false);
    event.target.value = '';
  };

  const selectConversation = (conversationId: string) => {
    setActiveConversationId(conversationId);
    setConversationQuery('');
    setDraft('');
    setMessageQuery('');
    setMessageSearchOpen(false);
    setInfoOpen(false);
    setShortcutOpen(false);
    setSettingsOpen(false);
    setMobileListOpen(false);
    window.requestAnimationFrame(() => composerRef.current?.focus());
  };

  const openMessageSearch = () => {
    setMessageSearchOpen((value) => !value);
    setInfoOpen(false);
    setShortcutOpen(false);
    window.requestAnimationFrame(() => messageSearchInputRef.current?.focus());
  };

  const openNewChat = () => {
    setNewChatQuery('');
    setNewChatOpen(true);
    setSettingsOpen(false);
    setShortcutOpen(false);
    setInfoOpen(false);
    setAttachmentMenu(false);
  };

  const startConversation = (contact: (typeof suggestedContacts)[number]) => {
    const exists = conversationList.some((conversation) => conversation.id === contact.id);
    if (!exists) {
      const members = Number.parseInt(contact.status, 10) || 2;
      setConversationList((current) => [{
        ...contact,
        preview: 'Bắt đầu một câu chuyện bằng chữ hoặc nét vẽ',
        time: 'Mới',
        description: contact.status.includes('thành viên')
          ? 'Một không gian chung để chia sẻ ý tưởng bằng chữ và hình.'
          : `Cuộc trò chuyện riêng với ${contact.name}.`,
        members,
      }, ...current]);
      setMessagesByConversation((current) => ({ ...current, [contact.id]: [] }));
    }
    setNewChatOpen(false);
    selectConversation(contact.id);
  };

  useEffect(() => {
    const area = messageAreaRef.current;
    if (!area) return;
    const frame = window.requestAnimationFrame(() => {
      area.scrollTo({
        top: area.scrollHeight,
        behavior: 'auto',
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [messages.length, activeConversationId]);

  useEffect(() => {
    if (!newChatOpen) return;
    const frame = window.requestAnimationFrame(() => newChatInputRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [newChatOpen]);

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const editing = Boolean(target?.matches('input, textarea, [contenteditable="true"]'));

      if (event.key === 'Escape') {
        setAttachmentMenu(false);
        setShortcutOpen(false);
        setInfoOpen(false);
        setSettingsOpen(false);
        setMessageSearchOpen(false);
        setMobileListOpen(false);
        setNewChatOpen(false);
        return;
      }
      if (modalOpen || editing || event.metaKey || event.ctrlKey || event.altKey) return;

      if (event.key === '/') {
        event.preventDefault();
        searchInputRef.current?.focus();
      } else if (event.key.toLowerCase() === 'a') {
        event.preventDefault();
        setAttachmentMenu((value) => !value);
        setShortcutOpen(false);
      } else if (event.key.toLowerCase() === 'd') {
        event.preventDefault();
        setStudioOpen(true);
        setAttachmentMenu(false);
        setShortcutOpen(false);
      } else if (event.key === '?') {
        event.preventDefault();
        setShortcutOpen((value) => !value);
        setAttachmentMenu(false);
      }
    };

    window.addEventListener('keydown', handleShortcut);
    return () => window.removeEventListener('keydown', handleShortcut);
  }, [modalOpen]);

  return (
    <div className="app-root">
    <main className={compactMode ? 'app-shell compact' : 'app-shell'} inert={modalOpen ? true : undefined} aria-hidden={modalOpen || undefined}>
      {mobileListOpen && <button className="mobile-scrim" onClick={() => setMobileListOpen(false)} aria-label="Đóng danh sách trò chuyện" />}
      <aside className={mobileListOpen ? 'sidebar mobile-open' : 'sidebar'}>
        <div className="brand-row">
          <button className="mobile-sidebar-close" onClick={() => setMobileListOpen(false)} aria-label="Đóng danh sách trò chuyện">‹</button>
          <div className="brand-mark" aria-hidden="true"><span /></div>
          <div><strong>Nét</strong><small>vẽ điều khó nói</small></div>
          <button className="new-chat" onClick={openNewChat} aria-label="Tạo cuộc trò chuyện mới">＋</button>
        </div>
        <label className="search-box">
          <span aria-hidden="true">⌕</span>
          <input
            ref={searchInputRef}
            name="conversation-search"
            autoComplete="off"
            value={conversationQuery}
            onChange={(event) => setConversationQuery(event.target.value)}
            placeholder="Tìm cuộc trò chuyện"
            aria-label="Tìm cuộc trò chuyện"
            aria-keyshortcuts="/"
          />
          <kbd>/</kbd>
        </label>
        <p className="section-label">Tin nhắn</p>
        <div className="conversation-list">
          {filteredConversations.map((conversation) => (
            <button
              key={conversation.id}
              className={conversation.id === activeConversationId ? 'conversation active' : 'conversation'}
              onClick={() => selectConversation(conversation.id)}
              aria-current={conversation.id === activeConversationId ? 'page' : undefined}
            >
              <span className="avatar" style={{ '--avatar': conversation.color } as CSSProperties}>{conversation.name.slice(0, 1)}</span>
              <span className="conversation-copy"><strong>{conversation.name}</strong><small>{conversation.preview}</small></span>
              <time>{conversation.time}</time>
            </button>
          ))}
          {!filteredConversations.length && <p className="conversation-empty">Không tìm thấy cuộc trò chuyện phù hợp.</p>}
        </div>
        {settingsOpen && (
          <section className="settings-panel" aria-label="Cài đặt nhanh">
            <div><strong>Cài đặt nhanh</strong><small>Áp dụng ngay trên thiết bị này</small></div>
            <button className="setting-row" onClick={() => setCompactMode((value) => !value)} aria-pressed={compactMode}>
              <span><strong>Chế độ gọn</strong><small>Giảm khoảng cách tin nhắn</small></span><i className={compactMode ? 'switch on' : 'switch'} />
            </button>
            <button className="setting-row" onClick={() => setSoundOn((value) => !value)} aria-pressed={soundOn}>
              <span><strong>Âm thanh</strong><small>Báo khi có phản hồi mới</small></span><i className={soundOn ? 'switch on' : 'switch'} />
            </button>
          </section>
        )}
        <div className="profile-card">
          <span className="avatar profile-avatar">C</span>
          <div><strong>Chào, Cường</strong><small>Không gian riêng tư</small></div>
          <button onClick={() => setSettingsOpen((value) => !value)} aria-label="Mở cài đặt" aria-expanded={settingsOpen}>•••</button>
        </div>
      </aside>

      <section className="chat-panel">
        <header className="chat-header">
          <button className="mobile-back" onClick={() => setMobileListOpen(true)} aria-label="Mở danh sách trò chuyện">‹</button>
          <span className="avatar header-avatar" style={{ '--avatar': activeConversation.color } as CSSProperties}>{activeConversation.name.slice(0, 1)}</span>
          <div className="chat-person"><strong>{activeConversation.name}</strong><small><i /> {activeConversation.status}</small></div>
          <div className="header-actions">
            <button onClick={openMessageSearch} aria-label="Tìm trong cuộc trò chuyện" aria-expanded={messageSearchOpen}>⌕</button>
            <button
              className={shortcutOpen ? 'shortcut-trigger active' : 'shortcut-trigger'}
              onClick={() => { setShortcutOpen((value) => !value); setInfoOpen(false); setMessageSearchOpen(false); }}
              aria-label="Xem phím tắt"
              aria-expanded={shortcutOpen}
              aria-keyshortcuts="?"
            >?</button>
            <button onClick={() => { setInfoOpen((value) => !value); setShortcutOpen(false); setMessageSearchOpen(false); }} aria-label="Thông tin cuộc trò chuyện" aria-expanded={infoOpen}>i</button>
          </div>
          {shortcutOpen && (
            <aside className="shortcut-panel" aria-label="Danh sách phím tắt">
              <div className="shortcut-title"><strong>Phím tắt</strong><small>Dùng Nét nhanh hơn trên web</small></div>
              <dl>
                <div><dt>Tìm trò chuyện</dt><dd><kbd>/</kbd></dd></div>
                <div><dt>Mở tệp & công cụ</dt><dd><kbd>A</kbd></dd></div>
                <div><dt>Mở canvas</dt><dd><kbd>D</kbd></dd></div>
                <div><dt>Gửi tin nhắn</dt><dd><kbd>Enter</kbd></dd></div>
                <div><dt>Xuống dòng</dt><dd><kbd>Shift</kbd><span>+</span><kbd>Enter</kbd></dd></div>
                <div><dt>Đóng bảng / canvas</dt><dd><kbd>Esc</kbd></dd></div>
              </dl>
            </aside>
          )}
        </header>

        {messageSearchOpen && (
          <div className="message-search-bar">
            <label><span aria-hidden="true">⌕</span><input ref={messageSearchInputRef} value={messageQuery} onChange={(event) => setMessageQuery(event.target.value)} placeholder="Tìm nội dung tin nhắn" aria-label="Tìm nội dung tin nhắn" /></label>
            <small>{normalizedMessageQuery ? `${messageMatchCount} kết quả` : 'Nhập từ khoá để tìm'}</small>
            <button onClick={() => { setMessageSearchOpen(false); setMessageQuery(''); }} aria-label="Đóng tìm kiếm">×</button>
          </div>
        )}

        {infoOpen && (
          <aside className="conversation-info" aria-label="Thông tin cuộc trò chuyện">
            <button className="info-close" onClick={() => setInfoOpen(false)} aria-label="Đóng thông tin">×</button>
            <span className="avatar info-avatar" style={{ '--avatar': activeConversation.color } as CSSProperties}>{activeConversation.name.slice(0, 1)}</span>
            <h2>{activeConversation.name}</h2>
            <p>{activeConversation.description}</p>
            <dl><div><dt>Thành viên</dt><dd>{activeConversation.members}</dd></div><div><dt>Ảnh & bản vẽ</dt><dd>{sharedMediaCount}</dd></div></dl>
            <button className="setting-row" onClick={() => setNotificationsByConversation((current) => ({ ...current, [activeConversationId]: !(current[activeConversationId] ?? true) }))} aria-pressed={notificationsByConversation[activeConversationId] ?? true}>
              <span><strong>Thông báo</strong><small>Nhận phản hồi mới</small></span><i className={(notificationsByConversation[activeConversationId] ?? true) ? 'switch on' : 'switch'} />
            </button>
          </aside>
        )}

        <div ref={messageAreaRef} className="message-area">
          <div className="message-lane">
          <div className="day-divider"><span>Hôm nay</span></div>
          {!messages.length && <div className="empty-state"><span>⌁</span><h2>Chưa có nét nào ở đây</h2><p>Gửi một lời nhắn, ảnh hoặc mở canvas để bắt đầu.</p></div>}
          {messages.map((message) => (
            <div key={message.id} className={`message-row ${message.side}`}>
              {message.side === 'in' && <span className="avatar message-avatar" style={{ '--avatar': activeConversation.color } as CSSProperties}>{activeConversation.name.slice(0, 1)}</span>}
              <div className="message-stack">
                {message.image && (
                  // Images can be local data URLs from the canvas or file picker, so they cannot use a remote image loader.
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    className="message-image"
                    src={message.image}
                    alt="Hình vẽ được gửi trong cuộc trò chuyện"
                    width="660"
                    height="465"
                    loading="lazy"
                    onLoad={() => endRef.current?.scrollIntoView({ block: 'end' })}
                  />
                )}
                {message.art && <ArtCard type={message.art} />}
                {message.text && <div className={normalizedMessageQuery && message.text.toLocaleLowerCase('vi').includes(normalizedMessageQuery) ? 'bubble search-match' : 'bubble'}>{message.text}</div>}
                <time>{message.time}{message.side === 'out' ? '  ✓✓' : ''}</time>
              </div>
            </div>
          ))}
          <div ref={endRef} />
          </div>
        </div>

        <footer className="composer-wrap">
          {attachmentMenu && (
            <div className="attachment-menu" role="menu" aria-label="Thêm nội dung">
              <button role="menuitem" onClick={() => { setStudioOpen(true); setAttachmentMenu(false); }}><span className="tool-icon draw-icon" aria-hidden="true">⌁</span><div><strong>Vẽ mới</strong><small>Tạo nhanh trên canvas</small></div><kbd>D</kbd></button>
              <button role="menuitem" onClick={() => fileInputRef.current?.click()}><span className="tool-icon photo-icon" aria-hidden="true">▧</span><div><strong>Chọn ảnh</strong><small>Từ thiết bị của bạn</small></div></button>
            </div>
          )}
          <div className="composer">
            <button
              className={attachmentMenu ? 'plus-button active' : 'plus-button'}
              onClick={() => { setAttachmentMenu((value) => !value); setShortcutOpen(false); }}
              aria-label="Thêm nội dung"
              aria-expanded={attachmentMenu}
              aria-keyshortcuts="A"
            >＋</button>
            <textarea
              ref={composerRef}
              name="message"
              autoComplete="off"
              rows={1}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); sendText(); } }}
              placeholder="Nhắn điều gì đó…"
              aria-label="Nội dung tin nhắn"
              aria-keyshortcuts="Enter Control+Enter Meta+Enter"
            />
            <button className="quick-draw" onClick={() => setStudioOpen(true)} aria-label="Mở canvas vẽ" aria-keyshortcuts="D">⌁</button>
            <button className="send-button" onClick={sendText} disabled={!draft.trim()} aria-label="Gửi tin nhắn" aria-keyshortcuts="Enter Control+Enter Meta+Enter">↑</button>
          </div>
          <input ref={fileInputRef} hidden type="file" accept="image/*" onChange={attachImage} />
          <p><kbd>Enter</kbd> gửi · <kbd>Shift</kbd> + <kbd>Enter</kbd> xuống dòng · <kbd>?</kbd> xem phím tắt</p>
        </footer>
      </section>
    </main>
    <div className="sr-only" aria-live="polite" aria-atomic="true">{announcement}</div>
    {newChatOpen && (
      <div className="new-chat-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setNewChatOpen(false); }}>
        <section className="new-chat-dialog" role="dialog" aria-modal="true" aria-labelledby="new-chat-title">
          <header><div><small>Cuộc trò chuyện mới</small><h2 id="new-chat-title">Bạn muốn gửi một nét cho ai?</h2></div><button onClick={() => setNewChatOpen(false)} aria-label="Đóng">×</button></header>
          <label className="new-chat-search"><span aria-hidden="true">⌕</span><input ref={newChatInputRef} value={newChatQuery} onChange={(event) => setNewChatQuery(event.target.value)} placeholder="Tìm người hoặc nhóm" aria-label="Tìm người hoặc nhóm" /></label>
          <div className="contact-list">
            {filteredContacts.map((contact) => (
              <button key={contact.id} onClick={() => startConversation(contact)}>
                <span className="avatar" style={{ '--avatar': contact.color } as CSSProperties}>{contact.name.slice(0, 1)}</span>
                <span><strong>{contact.name}</strong><small>{contact.status}</small></span><b>›</b>
              </button>
            ))}
            {!filteredContacts.length && <p>Không tìm thấy người hoặc nhóm phù hợp.</p>}
          </div>
        </section>
      </div>
    )}
    {studioOpen && <DrawingStudio onClose={() => setStudioOpen(false)} onSend={sendDrawing} />}
    </div>
  );
}
