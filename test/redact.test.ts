import assert from "node:assert/strict";
import { test } from "node:test";
import { redactSecrets } from "../src/core/live/capture.ts";

test("masks credential fields and JWTs in captured bodies", () => {
	const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl";
	assert.equal(redactSecrets('{"email":"a@b.c","password":"hunter2"}'), '{"email":"a@b.c","password":"[redacted]"}');
	assert.equal(redactSecrets(`{"data":{"access_token":"${jwt}","refreshToken":"r1","user":{"name":"kim","otpEnabled":true}}}`),
		'{"data":{"access_token":"[redacted]","refreshToken":"[redacted]","user":{"name":"kim","otpEnabled":true}}}');
	assert.equal(redactSecrets('{"variables":{"input":{"newPassword":"p","code":"keep"}}}'), '{"variables":{"input":{"newPassword":"[redacted]","code":"keep"}}}');
	assert.equal(redactSecrets("username=kim&password=hunter%21&grant_type=password"), "username=kim&password=[redacted]&grant_type=password");
	assert.equal(redactSecrets('{"password":"hun\\"ter2","email":"x"'), '{"password":"[redacted]","email":"x"', "truncated JSON");
	assert.equal(redactSecrets(`Bearer ${jwt} trailing`), "Bearer [redacted] trailing");
});

test("leaves text without secrets byte-for-byte unchanged", () => {
	for (const text of ['{\n  "rows": [{ "id": 1, "name": "a" }]\n}', "page=1&size=10", "plain text", "", '{"password":""}']) assert.equal(redactSecrets(text), text);
});
