# Vận hành Nét

## Lớp phòng vệ

Không một tiến trình Node hoặc Nginx đơn lẻ nào có thể chặn volumetric DDoS làm đầy đường truyền. Production phải đặt CDN/WAF/load balancer có DDoS protection phía trước `infra/nginx/default.conf`; chỉ mở ingress cho proxy đó và không public trực tiếp cổng API, PostgreSQL, Redis hay collector.

Các lớp trong repository xử lý phần application abuse và resource exhaustion:

1. Nginx giới hạn request rate, connection/IP, upload concurrency, body 1 MB mặc định và 8 MB đúng endpoint upload; timeout header/body/upstream ngắn.
2. NestJS có token bucket và concurrency ceiling để shed load trước controller. Đây là lớp theo process; ngưỡng nghiệp vụ ghi dữ liệu vẫn được kiểm tra atomic trong PostgreSQL để dùng chung giữa các replica.
3. Socket.IO chỉ cho WebSocket, kiểm tra Origin chính xác, buffer tối đa 16 KiB, giới hạn số socket/actor và tần suất event subscribe.
4. PostgreSQL pool có giới hạn connection, connection/query/statement timeout. Transaction được giữ ngắn; outbox worker claim batch bằng `FOR UPDATE SKIP LOCKED`.
5. Asset có giới hạn byte/count/pending theo owner. Vercel production phải dùng private `STORAGE_DRIVER=blob`; local volume chỉ phù hợp local/Docker một host.

Giá trị trong `.env.example` là baseline, không phải con số phổ quát. Điều chỉnh bằng load test với traffic thật; giảm từ từ và theo dõi 429/latency thay vì đoán.

## Request ID và log

- Nginx chấp nhận `X-Request-ID` chỉ khi khớp `[A-Za-z0-9._-]{8,128}`, nếu không tự sinh.
- API tiếp tục xác thực hoặc sinh UUID, echo `X-Request-ID` và log `method`, path không có query string, status, duration, response bytes và trace ID.
- Log không chứa request body, authorization header, guest token, signed asset token hay query string.
- Production đặt `LOG_FORMAT=json`; stdout/stderr phải được log agent thu gom và áp retention/redaction ở nền tảng vận hành.

Các alert tối thiểu nên có: tỷ lệ 5xx, 429 theo `reason`, p95/p99 latency, active connection, PostgreSQL pool wait, outbox pending/oldest age/failure, Redis errors, asset storage errors và memory/event-loop lag.

## Tracing và metrics

Tracing tắt khi `OTEL_EXPORTER_OTLP_ENDPOINT` rỗng. Để kiểm tra local collector mẫu:

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318 \
AUTH_JWT_SECRET="$(openssl rand -base64 48)" \
docker compose --profile observability up --build
```

Collector mẫu dùng memory limiter + batch và ghi summary ra log để xác nhận pipeline; production thay `debug` exporter trong `infra/otel/collector.yaml` bằng backend OTLP đã xác thực/TLS. Không expose cổng 4318 ra Internet. `OTEL_TRACES_SAMPLER_ARG=0.1` lấy mẫu 10% trace gốc nhưng vẫn tôn trọng quyết định sampling từ upstream.

Metrics tùy chỉnh hiện có:

- `net.http.rejected`
- `net.http.active`
- `net.rate_limit.rejected`
- `net.socket.rejected`
- `net.outbox.delivered`
- `net.outbox.failed`
- `net.outbox.pending`
- `net.outbox.oldest_age`
- `net.database.pool.total`, `net.database.pool.idle`, `net.database.pool.waiting`

## Realtime và triển khai nhiều replica

- Cấu hình Redis là bắt buộc khi có nhiều API replica; nếu không, room Socket.IO chỉ tồn tại trong một process.
- Mọi event nghiệp vụ được ghi vào `realtime_outbox` cùng transaction dữ liệu. Request tạo event chờ phát event của chính nó; cron maintenance drain backlog theo batch, lease row, phát at-least-once rồi đánh dấu published. UI phải chịu được event trùng và luôn HTTP catch-up sau reconnect.
- `message.client_request_id` là UUID idempotency key. Client retry với đúng key cũ; không sinh key mới cho cùng một lần bấm gửi.
- `message.sequence` là thứ tự chuẩn cho pagination/read state; không dùng timestamp client.
- Theo dõi số row outbox chưa publish, `attempts`, `last_error` và tuổi row cũ nhất. Row đã publish được dọn sau 24 giờ.

## PostgreSQL

- Dùng pooler ở transaction mode khi số replica/function tăng cao; tổng `replica × DATABASE_POOL_MAX` phải thấp hơn connection budget của database.
- Bật `pg_stat_statements` ở database được quản lý để tìm query tốn total time/mean time/calls; không ghi full SQL parameter nhạy cảm vào application log.
- Backup database và object bucket theo cùng retention; kiểm tra restore định kỳ. Migration chạy bằng service `migrate` duy nhất trước API rollout.

## Checklist production

- Secret JWT ngẫu nhiên tối thiểu 32 byte, lấy từ secret manager; không commit `.env`.
- Neon Auth/OIDC được cấu hình đúng origin; web không tin identity header do trình duyệt tự gửi.
- CDN/WAF/DDoS protection, TLS, origin firewall và health checks.
- Vercel Blob private store, token chỉ đặt ở API, lifecycle/backup phù hợp và không public URL object thô.
- Redis TLS/auth nếu đi qua mạng; PostgreSQL TLS và user quyền tối thiểu.
- Centralized JSON logs, OTLP collector private, dashboard/alerts và retention budget.
- Chạy `pnpm build`, `pnpm lint`, migration và full E2E trước rollout.
