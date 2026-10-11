FROM golang:1.26 AS build

WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/ip-gateway .

FROM alpine:3.21

RUN apk add --no-cache ca-certificates wget
WORKDIR /app
COPY --from=build /out/ip-gateway /app/ip-gateway
COPY config.example.yaml /app/config.yaml

EXPOSE 18080
ENTRYPOINT ["/app/ip-gateway"]
CMD ["-config", "/app/config.yaml"]
