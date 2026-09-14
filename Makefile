VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)
LDFLAGS  = -s -w -X main.version=$(VERSION)
BIN      = bin/smokeping-plot-next

.PHONY: all web build run dev-api dev-web docker clean

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
	docker build -t smokeping-plot-next:$(VERSION) -t smokeping-plot-next:latest .

clean:
	rm -rf bin web/dist/* && touch web/dist/.gitkeep
