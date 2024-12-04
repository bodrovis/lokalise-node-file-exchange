import * as dotenv from "dotenv";
dotenv.config();

import { MockAgent, setGlobalDispatcher } from "undici";
import type {
	Interceptable,
	MockInterceptor,
} from "undici/types/mock-interceptor.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

export {
	describe,
	expect,
	it,
	MockAgent,
	setGlobalDispatcher,
	beforeEach,
	afterEach,
	type Interceptable,
	type MockInterceptor,
};
