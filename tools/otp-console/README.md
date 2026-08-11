# Luxora local OTP console

This tool exposes the fixed local phone-verification code to a developer using
Xcode or another client. It is deliberately separate from the Luxora API and is
available only through the explicit Compose `development` profile.

```bash
docker compose --profile development up --build -d otp-console
open http://127.0.0.1:8081
curl --fail http://127.0.0.1:8081/api/code
```

The process refuses startup unless all of these are true:

- `NODE_ENV=development`;
- `LUXORA_LOCAL_OTP_CONSOLE=enabled`;
- `PHONE_AUTH_PROVIDER=development`;
- `PHONE_AUTH_DEVELOPMENT_CODE` is exactly six digits.

Compose passes the configured loopback host port separately, so changing
`LUXORA_OTP_CONSOLE_HOST_PORT` keeps the strict local Host allowlist usable.

Compose additionally publishes the port only on `127.0.0.1`, runs the pinned
distroless image as UID/GID `65532`, drops all capabilities and uses a read-only
root filesystem. Responses are non-cacheable, deny framing/sniffing and reject
non-local Host headers to limit DNS-rebinding access. The code is never printed
to container logs.

This is test convenience, not an SMS provider or production administrator
feature. Production phone authentication remains fail-closed until an external
provider is wired and qualified.
