build:
	go build -ldflags="-s -w" -o bin/proxy-helper .

test:
	go test ./...

copy-for-dev: build
	mkdir ../../bin || true
	cp bin/proxy-helper ../../bin

.PHONY: build test
