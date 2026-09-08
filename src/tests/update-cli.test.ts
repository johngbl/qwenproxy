import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isNewerVersion, getUpdateArgs, detectPackageManager } from "../update-cli.js";

describe("update-cli helper", () => {
  describe("isNewerVersion", () => {
    it("returns true when latest is greater than current", () => {
      assert.equal(isNewerVersion("1.0.0", "1.0.1"), true);
      assert.equal(isNewerVersion("1.0.0", "1.1.0"), true);
      assert.equal(isNewerVersion("1.0.0", "2.0.0"), true);
      assert.equal(isNewerVersion("v1.0.0", "v1.0.1"), true);
    });

    it("returns false when latest is equal or lower than current", () => {
      assert.equal(isNewerVersion("1.0.1", "1.0.1"), false);
      assert.equal(isNewerVersion("1.0.1", "1.0.0"), false);
      assert.equal(isNewerVersion("2.0.0", "1.9.9"), false);
      assert.equal(isNewerVersion("v1.0.1", "v1.0.1"), false);
    });
  });

  describe("getUpdateArgs", () => {
    it("generates correct update command per package manager", () => {
      assert.deepEqual(getUpdateArgs("npm", "qwenproxy-cli"), {
        cmd: "npm",
        args: ["install", "-g", "qwenproxy-cli@latest"],
      });
      assert.deepEqual(getUpdateArgs("pnpm", "qwenproxy-cli"), {
        cmd: "pnpm",
        args: ["update", "-g", "qwenproxy-cli"],
      });
      assert.deepEqual(getUpdateArgs("bun", "qwenproxy-cli"), {
        cmd: "bun",
        args: ["add", "-g", "qwenproxy-cli@latest"],
      });
      assert.deepEqual(getUpdateArgs("yarn", "qwenproxy-cli"), {
        cmd: "yarn",
        args: ["global", "upgrade", "qwenproxy-cli"],
      });
    });
  });

  describe("detectPackageManager", () => {
    it("returns a valid package manager string", () => {
      const pm = detectPackageManager();
      assert.ok(["npm", "pnpm", "bun", "yarn"].includes(pm));
    });
  });
});
