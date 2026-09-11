SHELL := /bin/bash
CALLS_ENV_FILE ?= infra/calls/.env.calls

.PHONY: help install build typecheck test check check-truth api-dev web-dev \
	apple-test android-test desktop-typecheck docker-build compose-config check-local-env \
	otp-console-build \
	calls-config calls-smoke compose-security-check check-calls-env calls-up calls-down prometheus-check \
	api-log-canary s3-live-gate backup-restore-test compose-up compose-observability-up compose-down

help:
	@echo "Luxora Beta-0.1 — common commands"
	@echo "  make install           Install all JavaScript dependencies"
	@echo "  make check             Known truth guards, type, unit and integration checks"
	@echo "  make build             Build protocol, passkey/call domains, API, Web and desktop main process"
	@echo "  make apple-test        Run the Swift package tests"
	@echo "  make android-test      Run Android unit tests and lint"
	@echo "  make compose-config    Validate Compose with placeholder-only .env.example"
	@echo "  make otp-console-build Build the local development-only OTP console"
	@echo "  make calls-config      Validate the local SFU/TURN Compose harness"
	@echo "  make calls-smoke       Run disposable SFU/TURN health and auth probes"
	@echo "  make compose-security-check  Check loopback, digest and privilege invariants"
	@echo "  make calls-up          Start SFU/TURN after validating independent secrets"
	@echo "  make prometheus-check  Validate Prometheus config and alert rules"
	@echo "  make api-log-canary    Run disposable production API log/content/token probes"
	@echo "  make s3-live-gate      Run disposable live S3 provider/IAM/versioning/failure probes"
	@echo "  make backup-restore-test  Run the disposable offline preview recovery drill"
	@echo "  make compose-up        Start the local API after validating .env"
	@echo "  make compose-observability-up  Start API and local Prometheus"

install:
	npm --prefix packages/protocol ci --no-audit --no-fund
	npm --prefix packages/passkey-domain ci --no-audit --no-fund
	npm --prefix packages/call-control ci --no-audit --no-fund
	npm --prefix services/api ci --no-audit --no-fund
	npm --prefix apps/web ci --no-audit --no-fund
	npm --prefix apps/desktop ci --no-audit --no-fund

build:
	npm --prefix packages/protocol run build
	npm --prefix packages/passkey-domain run build
	npm --prefix packages/call-control run build
	npm --prefix services/api run build
	npm --prefix apps/web run build
	npm --prefix apps/desktop run compile

typecheck:
	npm --prefix packages/protocol run typecheck
	npm --prefix packages/passkey-domain run typecheck
	npm --prefix packages/call-control run typecheck
	npm --prefix services/api run typecheck
	npm --prefix apps/web run typecheck
	npm --prefix apps/desktop run typecheck

test:
	npm --prefix packages/protocol test
	npm --prefix packages/passkey-domain test
	npm --prefix packages/call-control test
	npm --prefix services/api test

check: check-truth typecheck test

check-truth:
	bash infra/validate-public-metadata.sh
	@rg -q '^    release: Beta-0\.1$$' infra/observability/prometheus/prometheus.yml || { \
		echo "Prometheus external release label must be exactly Beta-0.1."; exit 1; \
	}
	@rg -q '^Owner and developer: \*\*Flenym\*\*\.$$' infra/README.md || { \
		echo "Infrastructure ownership metadata must be exactly Flenym."; exit 1; \
	}
	@if rg -n --glob '*.{ts,tsx,js,jsx,swift,kt}' 'Сквозное шифрование|Защищённый звонок' apps; then \
		echo "Unverified E2EE/call copy found in the Beta-0.1 clients."; exit 1; \
	fi

api-dev:
	npm --prefix services/api run dev

web-dev:
	npm --prefix apps/web run dev

apple-test:
	swift test --package-path apps/apple

android-test:
	apps/android/gradlew --no-daemon testDebugUnitTest lintDebug

desktop-typecheck:
	npm --prefix apps/desktop run typecheck

docker-build:
	docker build --pull --file services/api/Dockerfile --tag luxora-api:beta-0.1 .

otp-console-build:
	docker build --pull --file tools/otp-console/Dockerfile --tag luxora-otp-console:beta-0.1 .

api-log-canary: docker-build
	bash infra/operations/smoke-api-log-canary.sh

s3-live-gate: docker-build
	bash infra/operations/smoke-s3-provider.sh

compose-config:
	LUXORA_ENV_FILE=.env.example docker compose --env-file .env.example --profile observability --profile development config --quiet

calls-config:
	docker compose --env-file infra/calls/environment.example --file docker-compose.calls.yml config --quiet

calls-smoke:
	bash infra/calls/smoke.sh

compose-security-check:
	bash infra/validate-compose.sh

check-calls-env:
	@test -f "$(CALLS_ENV_FILE)" || { echo "Copy infra/calls/environment.example to $(CALLS_ENV_FILE) and replace both secrets first."; exit 1; }
	@livekit_secret="$$(sed -n 's/^LIVEKIT_API_SECRET=//p' "$(CALLS_ENV_FILE)" | tail -n 1)"; \
		turn_secret="$$(sed -n 's/^TURN_SHARED_SECRET=//p' "$(CALLS_ENV_FILE)" | tail -n 1)"; \
		if [ "$${#livekit_secret}" -lt 32 ] || [ "$${#turn_secret}" -lt 32 ]; then \
			echo "Calls secrets must each contain at least 32 random characters."; exit 1; \
		fi; \
		case "$$livekit_secret:$$turn_secret" in *replace_with_*) \
			echo "Replace both calls example secrets before startup."; exit 1;; \
		esac; \
		if [ "$$livekit_secret" = "$$turn_secret" ]; then \
			echo "LIVEKIT_API_SECRET and TURN_SHARED_SECRET must be independent."; exit 1; \
		fi

calls-up: check-calls-env
	docker compose --env-file "$(CALLS_ENV_FILE)" --file docker-compose.calls.yml config --quiet
	docker compose --env-file "$(CALLS_ENV_FILE)" --file docker-compose.calls.yml up --detach --wait

calls-down:
	docker compose --env-file infra/calls/environment.example --file docker-compose.calls.yml down

check-local-env:
	@test -f .env || { echo "Copy .env.example to .env and replace local credentials first."; exit 1; }
	@jwt_secret="$$(sed -n 's/^JWT_SECRET=//p' .env | tail -n 1)"; \
		if [ "$${#jwt_secret}" -lt 32 ] || [ "$$jwt_secret" = "replace-me" ]; then \
			echo "JWT_SECRET must be replaced with at least 32 random characters."; exit 1; \
		fi

prometheus-check:
	docker run --rm --network none --read-only --cap-drop ALL \
		--security-opt no-new-privileges:true \
		--volume "$(CURDIR)/infra/observability/prometheus/prometheus.yml:/etc/prometheus/prometheus.yml:ro" \
		--volume "$(CURDIR)/infra/observability/prometheus/alerts.yml:/etc/prometheus/alerts.yml:ro" \
		--entrypoint /bin/promtool \
		prom/prometheus:v3.14.0-distroless@sha256:50c707e96da5ade383cb1707790576480485e93de06aa60ad8802cb5f744bd0a \
		check config /etc/prometheus/prometheus.yml

backup-restore-test:
	bash infra/operations/test-backup-restore.sh

compose-up: check-local-env
	LUXORA_ENV_FILE=.env docker compose --env-file .env config --quiet
	LUXORA_ENV_FILE=.env docker compose --env-file .env up --build --detach api

compose-observability-up: check-local-env
	LUXORA_ENV_FILE=.env docker compose --env-file .env --profile observability config --quiet
	LUXORA_ENV_FILE=.env docker compose --env-file .env --profile observability up --build --detach

compose-down:
	LUXORA_ENV_FILE=.env.example docker compose --env-file .env.example --profile observability --profile development down
