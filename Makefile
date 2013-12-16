BIN = ./node_modules/.bin/

build:
	@mkdir -p build
	@$(BIN)regenerator \
		--include-runtime \
		lib/package.js > build/package.js

node_modules: package.json
	@npm install

test: node_modules
	@$(BIN)mocha \
		--require should \
		--reporter spec

.PHONY: build test
