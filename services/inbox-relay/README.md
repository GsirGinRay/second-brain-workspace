# inbox-relay

Encrypted phone-to-desktop inbox relay. It stores sealed items until the
desktop acknowledges them and never sees task text. It also serves the phone
web app from `apps/mobile-capture`. Protocol, limits and
retention: [docs/inbox-relay.md](../../docs/inbox-relay.md).

## Run

```bash
npm run relay:dev    # listens on 127.0.0.1:8114, data in data/
npm run relay:test
npm run mobile:dev   # phone web app on 127.0.0.1:5175, proxies the API to 8114
```

| Variable | Default | Purpose |
| --- | --- | --- |
| `INBOX_RELAY_ADDR` | `127.0.0.1:8114` | Listen address |
| `INBOX_RELAY_DB` | `data/inbox-relay.sqlite` | SQLite file |
| `INBOX_RELAY_STATIC` | unset | Folder with the built phone web app (`npm run mobile:build` → `apps/mobile-capture/dist`) |
| `INBOX_RELAY_CLIENT_IP_HEADER` | unset | Client IP header set by a trusted proxy, e.g. `cf-connecting-ip`. Leave unset when clients connect directly, or they can spoof it. |
| `GOOGLE_SERVICE_ACCOUNT_JSON`, `GOOGLE_SHEETS_MEMBER_SHEET_ID`, `INBOX_RELAY_MEMBER_TAB`, `RESEND_API_KEY`, `EMAIL_FROM` | unset | Paid features: member Sheet and verification email |

## Deploy

```bash
docker build -f services/inbox-relay/Dockerfile -t inbox-relay .   # from the repository root
docker run -d --memory 64m -p 127.0.0.1:8114:8114 -v inbox-relay:/data inbox-relay
```

Put a TLS reverse proxy in front of it; it must pass WebSocket upgrades and
keep idle connections open for at least 60 seconds (the relay pings every
30 seconds). `GET /api/health` returns `{"ok":true}`.
