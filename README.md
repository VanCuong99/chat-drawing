# Nét

Messenger chia sẻ chữ, ảnh và canvas có lịch sử phiên bản. Dự án dùng pnpm workspace với frontend Next.js, backend NestJS, PostgreSQL/Drizzle ORM và Socket.IO.

Studio Nét có bộ pha nhiều sắc tố gần đúng theo Kubelka–Munk với 2–12 màu thành phần. Người dùng nhập phần pha cho từng màu, xem nồng độ đầu vào đã chuẩn hóa, lưu cả công thức và nạp lại để chỉnh tiếp; bảng màu riêng lưu tối đa 24 công thức. Model `spectral-kubelka-munk-rgb` v2 đảo đúng phép biến đổi factor/luminance của spectral.js để tỷ lệ UI đi vào phép trộn đồng thời như nồng độ đã khai báo. Đây vẫn là mô phỏng sRGB/D65; công thức vật liệu thật cần phổ K/S đo cho từng pigment, binder và substrate.

## Kiến trúc

```text
apps/web/                    Next.js App Router web client + Neon Auth
apps/api/                    NestJS REST API + Socket.IO gateway
packages/database/           Drizzle schema, client và migration PostgreSQL
packages/pigment/            mô hình pha nhiều sắc tố dùng chung
tests/e2e/                   kiểm thử luồng trình duyệt và realtime
infra/nginx/                 reverse proxy, rate/connection limit
infra/otel/                  OpenTelemetry Collector mẫu cho local
scripts/                     lệnh bảo trì workspace có phạm vi rõ ràng
```

Mỗi thư mục trên có đúng một trách nhiệm; frontend không còn nằm lẫn ở root và migration chỉ còn một nguồn tại `packages/database/drizzle/`. Chạy `pnpm clean` để xóa riêng build output/test artifact có thể tạo lại, không chạm vào upload local.

PostgreSQL là nguồn dữ liệu nghiệp vụ, rate-limit dùng chung và transactional realtime outbox. File ảnh local nằm trong volume API; production bắt buộc `STORAGE_DRIVER=blob` với Vercel Blob private. Metadata và quyền sở hữu luôn nằm trong PostgreSQL, còn URL đọc ảnh được ký ngắn hạn theo actor + room. Redis adapter đồng bộ Socket.IO giữa nhiều NestJS instance; API production từ chối khởi động nếu thiếu `REDIS_URL`.

## Chạy local

Yêu cầu Node.js 22+, pnpm 10 và PostgreSQL. Cách nhanh nhất khi Docker đang chạy:

```bash
cp .env.example .env.local
cp apps/web/.env.example apps/web/.env.local
pnpm install
pnpm db:up
pnpm db:migrate
pnpm dev
```

Điền `NEON_AUTH_BASE_URL` và một `NEON_AUTH_COOKIE_SECRET` riêng trong `apps/web/.env.local`; giữ `AUTH_JWT_SECRET` giống API. API đọc `.env.local` ở root, còn Next.js đọc file trong `apps/web`.

- Web: `http://localhost:3000`
- API health: `http://localhost:3001/api/health`

Nếu chỉ muốn chạy hạ tầng và ứng dụng production bằng container:

```bash
cp .env.example .env
docker compose up --build
```

Trước khi chạy Compose, điền `AUTH_JWT_SECRET`, `NEON_AUTH_BASE_URL` và `NEON_AUTH_COOKIE_SECRET` trong `.env`.

Ứng dụng được phục vụ tại `http://localhost:8080` qua Nginx.

## Build

```bash
pnpm build
pnpm lint
pnpm check:infra
pnpm security:audit
```

Lệnh này lần lượt build package database, NestJS API và frontend. Các lệnh database:

```bash
pnpm db:generate
pnpm db:migrate
pnpm db:studio
```

## Bảo đảm realtime không nhận sai phòng

1. HTTP cấp token Socket.IO ngắn hạn từ actor đã xác thực.
2. Socket không tự join phòng; client phải gửi `room.subscribe`.
3. Gateway kiểm tra membership hoặc guest session trước khi join `room:{roomId}`.
4. Mỗi lần subscribe, gateway rời toàn bộ room chat cũ trước khi join room mới.
5. Mọi event đều mang `roomId`; client bỏ qua event không khớp `activeRoomRef`.
6. Redis adapter phân phối event đúng room khi chạy nhiều API instance.
7. Socket còn join `actor:{id}`; event `room.activity` chỉ đi tới socket không ở room đang mở để cập nhật unread/preview mà không phát `message.created` sai phòng.
8. Token realtime hết hạn chủ động ngắt socket; client đổi token, subscribe lại và tải bù bootstrap/messages.
9. Polling chỉ là fallback khi WebSocket mất kết nối.
10. Mọi thay đổi realtime được ghi vào transactional outbox cùng transaction nghiệp vụ; request tạo event chờ phát event của chính nó, còn maintenance drain backlog theo batch với lease + `FOR UPDATE SKIP LOCKED`. Client coi event là at-least-once và đồng bộ lại state qua HTTP.

`tests/e2e/realtime-isolation.spec.ts` tạo hai guest ở hai phòng, thử subscribe trái phép, xác nhận event phòng A không xuất hiện trên socket phòng B, và kiểm tra actor channel chỉ báo hoạt động cho phòng nền.

Message có `sequence` tăng đơn điệu do PostgreSQL cấp; phân trang và read status dùng sequence thay cho timestamp/UUID nên không bị sai thứ tự khi nhiều tin được tạo cùng mili-giây. `clientRequestId` UUID làm idempotency key để retry không tạo tin trùng. Guest create, room create, message, reaction và upload đều qua rate-limit atomic trong PostgreSQL; migration được chạy bởi service `migrate` riêng trước API, không chạy lặp trong mọi replica. Reverse proxy chặn burst và giới hạn bốn kết nối upload đồng thời theo IP trước khi body ảnh được buffer; mỗi owner còn bị giới hạn 500 asset, ba upload pending và 256 MB.

Asset URL mặc định sống 10 phút (`ASSET_URL_TTL`) và chỉ mang quyền actor + room + asset. Client tự xin URL mới khi ảnh hết hạn và luôn refresh ngay trước luồng **Vẽ tiếp**, nên TTL ngắn không làm hỏng một phiên guest còn hiệu lực.

## Authentication

Authenticated mode dùng Neon Auth ở Next.js. Route server của web đọc session đã ký, sau đó cấp JWT sống ngắn với `issuer=net-web`, `audience=net-api`; NestJS chỉ tin JWT ký bởi `AUTH_JWT_SECRET`. Web và API phải dùng cùng secret, dài tối thiểu 32 byte.

Guest không cần tài khoản và mất quyền khi phiên kết thúc. Message/asset guest đã gửi được giữ lại trong phòng kể cả khi chưa có thành viên đăng nhập; guest session, reaction và dữ liệu tạm chưa gắn vào tin nhắn bị thu hồi. `joinRoom`, guest send và guest end dùng chung PostgreSQL advisory lock theo room để không sai retention khi chạy đồng thời.

## Production hiện tại

- Web: [chat-drawing.vercel.app](https://chat-drawing.vercel.app)
- API: [chat-drawing-api.vercel.app/api/health](https://chat-drawing-api.vercel.app/api/health)
- Database/auth: Neon Postgres + Neon Auth
- Media: Vercel Blob private
- Realtime fan-out: Upstash Redis + Socket.IO Redis adapter

Hai Vercel project trỏ lần lượt tới `apps/web` và `apps/api`. Chạy migration Drizzle trước khi deploy API. Các biến production tối thiểu gồm `DATABASE_URL`, `AUTH_JWT_SECRET`, `REDIS_URL`, `STORAGE_DRIVER=blob`, `BLOB_READ_WRITE_TOKEN`, `CRON_SECRET`, `WEB_ORIGIN`; web cần `NEON_AUTH_BASE_URL`, `NEON_AUTH_COOKIE_SECRET`, `AUTH_JWT_SECRET`, `NEXT_PUBLIC_API_URL` và `NEXT_PUBLIC_REALTIME_URL`.

## Vận hành và quan sát

API trả `X-Request-ID`, log JSON trong production và gắn request ID + trace ID vào lỗi 5xx. Nếu đặt `OTEL_EXPORTER_OTLP_ENDPOINT`, API xuất traces/metrics qua OTLP/HTTP. Cấu hình hardening, ngưỡng cảnh báo, object storage và cách chạy collector local nằm trong [docs/OPERATIONS.md](docs/OPERATIONS.md).
