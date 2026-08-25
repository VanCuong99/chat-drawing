'use client';

import { ChangeEvent, PointerEvent, useEffect, useRef, useState } from 'react';

type Message = {
  id: number;
  side: 'in' | 'out';
  text?: string;
  image?: string;
  art?: 'sun' | 'note';
  time: string;
};

const initialMessages: Message[] = [
  { id: 1, side: 'in', text: 'Tớ đang nghĩ lại góc ban công. Cậu xem cách này ổn không?', time: '09:41' },
  { id: 2, side: 'in', art: 'sun', time: '09:42' },
  { id: 3, side: 'out', text: 'Ổn đó! Tớ thêm một chiếc bàn nhỏ ở đây nhé.', time: '09:44' },
  { id: 4, side: 'out', art: 'note', time: '09:45' },
  { id: 5, side: 'in', text: 'Đúng ý tớ luôn ✨', time: '09:46' },
];

const conversations = [
  { name: 'Minh Anh', preview: 'Đúng ý tớ luôn ✨', time: '09:46', active: true, color: '#f7a85a' },
  { name: 'Nhóm Nhà Mới', preview: 'Hà đã gửi một bản vẽ', time: 'T3', color: '#7756e8' },
  { name: 'Tuấn', preview: 'Cuối tuần chốt nhé!', time: 'T2', color: '#50b8a7' },
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

  return (
    <div className="studio-backdrop" role="dialog" aria-modal="true" aria-labelledby="studio-title">
      <section className="studio">
        <header className="studio-header">
          <button className="plain-button" onClick={onClose} aria-label="Đóng trình vẽ">Đóng</button>
          <div>
            <span>Canvas mới</span>
            <h2 id="studio-title">Vẽ điều bạn muốn nói</h2>
          </div>
          <button className="send-drawing" onClick={send}>Gửi</button>
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
          <span className="canvas-hint">Dùng ngón tay hoặc chuột để bắt đầu vẽ</span>
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
  const [messages, setMessages] = useState(initialMessages);
  const [draft, setDraft] = useState('');
  const [studioOpen, setStudioOpen] = useState(false);
  const [attachmentMenu, setAttachmentMenu] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const now = () => new Intl.DateTimeFormat('vi-VN', { hour: '2-digit', minute: '2-digit' }).format(new Date());

  const appendMessage = (message: Omit<Message, 'id' | 'time'>) => {
    setMessages((current) => [...current, { ...message, id: Date.now(), time: now() }]);
    window.setTimeout(() => {
      setMessages((current) => [
        ...current,
        { id: Date.now() + 1, side: 'in', text: 'Mình nhận được rồi — để mình vẽ thêm ý của mình nhé 👀', time: now() },
      ]);
    }, 850);
  };

  const sendText = () => {
    const text = draft.trim();
    if (!text) return;
    appendMessage({ side: 'out', text });
    setDraft('');
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

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand-row">
          <div className="brand-mark"><span /></div>
          <div><strong>Nét</strong><small>vẽ điều khó nói</small></div>
          <button className="new-chat" aria-label="Tạo cuộc trò chuyện mới">＋</button>
        </div>
        <label className="search-box">
          <span>⌕</span>
          <input placeholder="Tìm cuộc trò chuyện" aria-label="Tìm cuộc trò chuyện" />
        </label>
        <p className="section-label">Tin nhắn</p>
        <div className="conversation-list">
          {conversations.map((conversation) => (
            <button key={conversation.name} className={conversation.active ? 'conversation active' : 'conversation'}>
              <span className="avatar" style={{ '--avatar': conversation.color } as React.CSSProperties}>{conversation.name.slice(0, 1)}</span>
              <span className="conversation-copy"><strong>{conversation.name}</strong><small>{conversation.preview}</small></span>
              <time>{conversation.time}</time>
            </button>
          ))}
        </div>
        <div className="profile-card">
          <span className="avatar profile-avatar">C</span>
          <div><strong>Chào, Cường</strong><small>Không gian riêng tư</small></div>
          <button aria-label="Mở cài đặt">•••</button>
        </div>
      </aside>

      <section className="chat-panel">
        <header className="chat-header">
          <button className="mobile-back" aria-label="Quay lại">‹</button>
          <span className="avatar header-avatar">M</span>
          <div className="chat-person"><strong>Minh Anh</strong><small><i /> Đang hoạt động</small></div>
          <div className="header-actions">
            <button aria-label="Tìm trong cuộc trò chuyện">⌕</button>
            <button aria-label="Thông tin cuộc trò chuyện">i</button>
          </div>
        </header>

        <div className="message-area">
          <div className="day-divider"><span>Hôm nay</span></div>
          {messages.map((message) => (
            <div key={message.id} className={`message-row ${message.side}`}>
              {message.side === 'in' && <span className="avatar message-avatar">M</span>}
              <div className="message-stack">
                {message.image && <img className="message-image" src={message.image} alt="Hình vẽ được gửi trong cuộc trò chuyện" />}
                {message.art && <ArtCard type={message.art} />}
                {message.text && <div className="bubble">{message.text}</div>}
                <time>{message.time}{message.side === 'out' ? '  ✓✓' : ''}</time>
              </div>
            </div>
          ))}
          <div ref={endRef} />
        </div>

        <footer className="composer-wrap">
          {attachmentMenu && (
            <div className="attachment-menu">
              <button onClick={() => { setStudioOpen(true); setAttachmentMenu(false); }}><span className="tool-icon draw-icon">⌁</span><div><strong>Vẽ mới</strong><small>Tạo nhanh trên canvas</small></div></button>
              <button onClick={() => fileInputRef.current?.click()}><span className="tool-icon photo-icon">▧</span><div><strong>Chọn ảnh</strong><small>Từ thiết bị của bạn</small></div></button>
            </div>
          )}
          <div className="composer">
            <button className={attachmentMenu ? 'plus-button active' : 'plus-button'} onClick={() => setAttachmentMenu((value) => !value)} aria-label="Thêm nội dung">＋</button>
            <input
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); sendText(); } }}
              placeholder="Nhắn điều gì đó…"
              aria-label="Nội dung tin nhắn"
            />
            <button className="quick-draw" onClick={() => setStudioOpen(true)} aria-label="Mở canvas vẽ">⌁</button>
            <button className="send-button" onClick={sendText} aria-label="Gửi tin nhắn">↑</button>
          </div>
          <input ref={fileInputRef} hidden type="file" accept="image/*" onChange={attachImage} />
          <p>Enter để gửi · Tin nhắn và hình vẽ nằm cùng một mạch trò chuyện</p>
        </footer>
      </section>

      {studioOpen && <DrawingStudio onClose={() => setStudioOpen(false)} onSend={sendDrawing} />}
    </main>
  );
}
