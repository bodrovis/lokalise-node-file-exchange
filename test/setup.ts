import * as dotenv from "@dotenvx/dotenvx";

dotenv.config({ quiet: true });

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
	describe,
	expect,
	it,
	MockAgent,
	setGlobalDispatcher,
	beforeEach,
	afterEach,
	beforeAll,
	afterAll,
	vi,
	type Interceptable,
	type MockInterceptor,
};
