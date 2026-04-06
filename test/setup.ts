import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { install } from "undici";

if (existsSync(".env")) {
	loadEnvFile();
}

install();

import { MockAgent, setGlobalDispatcher } from "undici";
import type {
	Interceptable,
	MockInterceptor,
} from "undici/types/mock-interceptor.js";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";

export {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	type Interceptable,
	it,
	MockAgent,
	type MockInterceptor,
	setGlobalDispatcher,
	vi,
};
