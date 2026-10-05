.PHONY: dev stop test-e2e test-e2e-ui lint lint-backend lint-frontend lint-fix

dev: stop
	@trap 'trap - INT TERM HUP EXIT; kill 0' INT TERM HUP EXIT; \
	(cd backend && . venv/bin/activate && exec uvicorn app.main:app --reload --port 8000) & \
	(cd frontend && exec pnpm run dev) & \
	wait

# Reap servers left behind by a killed `make dev` (or an editor run task).
stop:
	-@pkill -f 'uvicorn app.main:app --reload'
	-@pkill -f 'next dev -p 4001'
	-@fuser -k 4001/tcp 8000/tcp 2>/dev/null

test-e2e:
	cd frontend && E2E_TEST_MODE=1 GOOGLE_API_KEY=mock pnpm exec playwright test

test-e2e-ui:
	cd frontend && E2E_TEST_MODE=1 GOOGLE_API_KEY=mock pnpm exec playwright test --ui

lint: lint-backend lint-frontend

lint-backend:
	ruff check backend/

lint-frontend:
	cd frontend && pnpm run lint
	cd frontend && pnpm exec next typegen
	cd frontend && pnpm exec tsc --noEmit

lint-fix:
	ruff check backend/ --fix
	cd frontend && pnpm run lint:fix
