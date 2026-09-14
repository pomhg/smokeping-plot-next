# ---- frontend ---------------------------------------------------------
FROM node:22-alpine AS web
WORKDIR /src/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

# ---- backend ----------------------------------------------------------
FROM golang:1.25-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
COPY --from=web /src/web/dist ./web/dist
ARG VERSION=docker
RUN CGO_ENABLED=0 go build -trimpath -ldflags "-s -w -X main.version=${VERSION}" \
      -o /out/smokeping-plot-next ./cmd/smokeping-plot-next

# ---- runtime ----------------------------------------------------------
FROM alpine:3.21
RUN apk add --no-cache ca-certificates tzdata
COPY --from=build /out/smokeping-plot-next /usr/local/bin/smokeping-plot-next
ENV DATA_DIR=/data LISTEN=:8080
VOLUME ["/data"]
EXPOSE 8080
# Runs as root so raw ICMP sockets work out of the box (Docker grants
# CAP_NET_RAW by default). See README for a non-root alternative.
ENTRYPOINT ["smokeping-plot-next"]
