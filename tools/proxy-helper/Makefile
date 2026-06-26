build:
	go build -ldflags="-s -w" -o bin/proxy-helper .

build-windows:
	go build -ldflags="-s -w -extldflags=-static" -o bin/proxy-helper.exe .

build-windows-compat:
	GOOS=windows GOARCH=amd64 go build -ldflags="-s -w -extldflags=-static" -o bin/proxy-helper.exe .

test:
	go test ./...

copy-for-dev: build
	mkdir ../../bin || true
	cp bin/proxy-helper ../../bin

.PHONY: build build-windows build-windows-compat test copy-for-dev
