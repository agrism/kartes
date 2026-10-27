# Multi-stage Dockerfile Go API servisam (viss tiek būvēts un palaists Docker iekšienē)

# 1. Būvēšanas stadija
FROM golang:1.23-alpine AS builder

WORKDIR /app

# Nokopē moduļa failus un lejupielādē atkarības
COPY go.mod ./
RUN go mod download

# Nokopē pārējo kodu un nokompilē statisku mašīnkoda bināro failu
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o /app/kartes-api main.go

# 2. Minimālais produkcijas konteiners (~15 MB)
FROM alpine:3.20

RUN apk --no-cache add ca-certificates tzdata
WORKDIR /app

COPY --from=builder /app/kartes-api /app/kartes-api

ENV PORT=8080
EXPOSE 8080

CMD ["/app/kartes-api"]
