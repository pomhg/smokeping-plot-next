VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)
LDFLAGS  = -s -w -X main.version=$(VERSION)
BIN      = bin/smokeping-plot-next
NAME     = smokeping-plot-next
PLATFORMS = linux/amd64 linux/arm64 linux/armv7 darwin/arm64 darwin/amd64

.PHONY: all web build run dev-api dev-web docker dist install install-user uninstall clean

all: build

## Build the frontend into web/dist (embedded by the Go binary).
web:
	cd web && npm ci && npm run build

## Build the single self-contained binary (frontend included).
build: web
	CGO_ENABLED=0 go build -trimpath -ldflags "$(LDFLAGS)" -o $(BIN) ./cmd/smokeping-plot-next

## Build and run locally on :8080 with ./data as the data directory.
run: build
	./$(BIN)

## Development: run the API with `go run`; use together with `make dev-web`.
dev-api:
	go run ./cmd/smokeping-plot-next

## Development: Vite dev server with hot reload, proxying /api to :8080.
dev-web:
	cd web && npm install && npm run dev

docker:
	docker build -t $(NAME):$(VERSION) -t $(NAME):latest .

## Cross-compile release tarballs into dist/ (expects web/dist to be built).
dist:
	@rm -rf dist && mkdir -p dist
	@for p in $(PLATFORMS); do \
	  os=$${p%/*}; arch=$${p#*/}; goarch=$$arch; goarm=; \
	  if [ "$$arch" = armv7 ]; then goarch=arm; goarm=7; fi; \
	  out=dist/$(NAME)_$${os}_$${arch}; mkdir -p $$out; \
	  echo "building $$os/$$arch"; \
	  CGO_ENABLED=0 GOOS=$$os GOARCH=$$goarch GOARM=$$goarm \
	    go build -trimpath -ldflags "$(LDFLAGS)" -o $$out/$(NAME) ./cmd/smokeping-plot-next || exit 1; \
	  cp README.md $$out/; cp -r deploy $$out/; \
	  COPYFILE_DISABLE=1 tar --no-xattrs -C dist -czf $$out.tar.gz $$(basename $$out) 2>/dev/null || COPYFILE_DISABLE=1 tar -C dist -czf $$out.tar.gz $$(basename $$out); rm -rf $$out; \
	done
	@ls -la dist

## Install as a systemd service (system-wide, needs sudo) using the local build.
install: build
	sudo ./deploy/install.sh --system --binary $(BIN)

## Install as a per-user systemd service using the local build.
install-user: build
	./deploy/install.sh --user --binary $(BIN)

uninstall:
	./deploy/install.sh --uninstall

clean:
	rm -rf bin dist web/dist/* && touch web/dist/.gitkeep
