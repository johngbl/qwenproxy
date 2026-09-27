import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { parseJwtExpiry, isTokenExpiringSoon } from "../services/auth-playwright.ts";
import { isAuthTokenValidFrom, isPageLoggedIn, hasValidAuthToken } from "../services/playwright.ts";
import { wipeAccountSessionFiles } from "../core/accounts.ts";
import { getProfilesDir, getAccountProfilePath } from "../core/paths.ts";

function makeJwt(exp: number): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ sub: "user-123", exp })).toString("base64url");
  return `${header}.${payload}.mock-signature`;
}

test("parseJwtExpiry: extracts exp timestamp from token string or cookie string", () => {
  const nowSec = Math.floor(Date.now() / 1000);
  const jwt = makeJwt(nowSec + 3600);

  // Direct raw token
  assert.equal(parseJwtExpiry(jwt), nowSec + 3600);

  // In cookie format
  assert.equal(parseJwtExpiry(`token=${jwt}; path=/; domain=.qwen.ai`), nowSec + 3600);

  // Opaque tokens return null
  assert.equal(parseJwtExpiry("opaque-token-value"), null);
  assert.equal(parseJwtExpiry("token=opaque-value; path=/"), null);

  // Invalid JWT structures return null
  assert.equal(parseJwtExpiry("header.invalid-base64.sig"), null);
  assert.equal(parseJwtExpiry(""), null);
});

test("isAuthTokenValidFrom: decodes JWT exp and rejects expired token even if cookie Max-Age is 1 year", () => {
  const nowSec = Math.floor(Date.now() / 1000);
  const oneYearFromNow = nowSec + 31536000;

  // Case 1: JWT expired 10 minutes ago, but cookie header says expires in 1 year
  const expiredJwt = makeJwt(nowSec - 600);
  const expiredCookies: any = [
    {
      name: "token",
      value: expiredJwt,
      domain: ".qwen.ai",
      expires: oneYearFromNow,
    },
  ];
  assert.equal(
    isAuthTokenValidFrom(expiredCookies),
    false,
    "Must reject token whose JWT exp is in the past, regardless of cookie.expires",
  );

  // Case 2: JWT expires in 2 minutes (< 5 min safety margin), cookie expires in 1 year
  const expiringSoonJwt = makeJwt(nowSec + 120);
  const expiringSoonCookies: any = [
    {
      name: "token",
      value: expiringSoonJwt,
      domain: ".qwen.ai",
      expires: oneYearFromNow,
    },
  ];
  assert.equal(
    isAuthTokenValidFrom(expiringSoonCookies),
    false,
    "Must reject token within 5-minute safety margin",
  );

  // Case 3: JWT is fresh (expires in 2 hours), cookie expires in 1 year
  const freshJwt = makeJwt(nowSec + 7200);
  const freshCookies: any = [
    {
      name: "token",
      value: freshJwt,
      domain: ".qwen.ai",
      expires: oneYearFromNow,
    },
  ];
  assert.equal(
    isAuthTokenValidFrom(freshCookies),
    true,
    "Must accept fresh JWT token",
  );

  // Case 4: Opaque non-JWT token falls back to cookie.expires
  const opaqueCookies: any = [
    {
      name: "token",
      value: "opaque-session-token",
      domain: ".qwen.ai",
      expires: oneYearFromNow,
    },
  ];
  assert.equal(
    isAuthTokenValidFrom(opaqueCookies),
    true,
    "Opaque token falls back to cookie.expires",
  );
});

test("hasValidAuthToken: verifies that cookie contains non-empty token and checks expiration", () => {
  const nowSec = Math.floor(Date.now() / 1000);
  const freshJwt = makeJwt(nowSec + 3600);
  const expiredJwt = makeJwt(nowSec - 600);

  assert.equal(hasValidAuthToken(`token=${freshJwt}; path=/`), true);
  assert.equal(hasValidAuthToken(`token=${expiredJwt}; path=/`), false);
  assert.equal(hasValidAuthToken("token=opaque_valid; other=1"), true);
  assert.equal(hasValidAuthToken("token=; other=1"), false);
  assert.equal(hasValidAuthToken('token=""; other=1'), false);
  assert.equal(hasValidAuthToken("acw_tc=123; other=456"), false);
  assert.equal(hasValidAuthToken(""), false);
  assert.equal(hasValidAuthToken(undefined as any), false);
});

test("isPageLoggedIn: rejects guest 200 responses and validates authenticated user", async () => {
  // Mock page simulating guest response (status 200 with data: null)
  const guestPageNull: any = {
    isClosed: () => false,
    url: () => "https://chat.qwen.ai/",
    evaluate: async (fn: any) => {
      // Evaluate simulating the in-browser probe for guest
      return false;
    },
  };
  assert.equal(await isPageLoggedIn(guestPageNull), false);

  // Mock page simulating authenticated response
  const authPage: any = {
    isClosed: () => false,
    url: () => "https://chat.qwen.ai/",
    evaluate: async (fn: any) => {
      return true;
    },
  };
  assert.equal(await isPageLoggedIn(authPage), true);
});

test("wipeAccountSessionFiles: cleans up profile directory and state file cleanly", () => {
  const testId = `test-wipe-${Date.now()}`;
  const profilePath = getAccountProfilePath(testId);
  const siblingState = path.join(getProfilesDir(), `${testId}_state.json`);

  fs.mkdirSync(profilePath, { recursive: true });
  fs.writeFileSync(path.join(profilePath, "dummy.txt"), "hello");
  fs.writeFileSync(siblingState, JSON.stringify({ cookies: [] }));

  assert.ok(fs.existsSync(profilePath));
  assert.ok(fs.existsSync(siblingState));

  wipeAccountSessionFiles(testId);

  assert.equal(fs.existsSync(profilePath), false);
  assert.equal(fs.existsSync(siblingState), false);
});
