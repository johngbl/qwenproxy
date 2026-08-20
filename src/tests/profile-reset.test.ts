import test from "node:test";
import assert from "node:assert";
import { mkdtempSync, writeFileSync, mkdirSync, renameSync, existsSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.TEST_MOCK_QWEN_AUTH = "true";

import { removePlaywrightProfile } from "../services/playwright.ts";

/**
 * Regressão do Problema 1 (EPERM no reset de perfil): no Windows, o `fs.rmSync`
 * do profile pode falhar com EPERM/EBUSY/Permission denied porque o processo do
 * browser ainda segura um file-lock no diretório. Antes da correção, isso fazia
 * o reset falhar e, numa cadeia, derrubava a conta (reinit 45s + cooldown 300s).
 * Agora o diretório travado é renomeado para `.stale-*` sem lançar, para o
 * re-init criar um profile novo.
 */

function makeFakeProfile(dirBase: string, name: string): { profilePath: string } {
  const profilePath = path.join(dirBase, name);
  mkdirSync(path.join(profilePath, "Default"), { recursive: true });
  writeFileSync(path.join(profilePath, "Default", "Preferences"), "{}", "utf8");
  return { profilePath };
}

/** Removes a tree; on EPERM-style failure, renames it aside (safe teardown). */
function removeOrRenameTree(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    try {
      renameSync(dir, `${dir}.teardown-stale`);
    } catch {
      /* best effort */
    }
  }
}

test("removePlaywrightProfile: deletes an unlocked profile directory", () => {
  const dirBase = mkdtempSync(path.join(tmpdir(), "qwenp-prof-clean-"));
  try {
    const { profilePath } = makeFakeProfile(dirBase, "acc-clean");
    assert.ok(existsSync(path.join(profilePath, "Default", "Preferences")));
    removePlaywrightProfile(profilePath);
    assert.ok(!existsSync(profilePath), "profile must be removed");
    // No .stale-* remnant on a clean removal.
    const leftovers = readdirSync(dirBase).filter((f) => f.includes("acc-clean"));
    assert.deepStrictEqual(leftovers, [], "no stale dirs after clean removal");
  } finally {
    removeOrRenameTree(dirBase);
  }
});

test("removePlaywrightProfile: when deletion fails with EPERM, the dir is renamed to .stale-* without throwing", () => {
  const dirBase = mkdtempSync(path.join(tmpdir(), "qwenp-prof-eperm-"));
  try {
    const name = "acc-locked";
    const { profilePath } = makeFakeProfile(dirBase, name);

    // Inject an rmSync that fails exactly like a Windows file-lock EPERM.
    const eperm: NodeJS.ErrnoException = new Error(
      "EPERM: operation not permitted, unlink '" + profilePath + "'",
    ) as NodeJS.ErrnoException;
    eperm.code = "EPERM";

    assert.doesNotThrow(() => removePlaywrightProfile(profilePath, () => { throw eperm; }));

    // The original dir is gone (renamed aside), and a .stale-* sibling exists.
    assert.ok(!existsSync(profilePath), "locked profile must be moved aside");
    const stale = readdirSync(dirBase).filter((f) => f.startsWith(`${name}.stale-`));
    assert.ok(stale.length >= 1, "a .stale-* dir must be created, got: " + readdirSync(dirBase).join(", "));
  } finally {
    removeOrRenameTree(dirBase);
  }
});

test("removePlaywrightProfile: rename fallback does not throw when the baseline rmSync errors non-EPERM (best-effort)", () => {
  const dirBase = mkdtempSync(path.join(tmpdir(), "qwenp-prof-other-"));
  try {
    const { profilePath } = makeFakeProfile(dirBase, "acc-other");
    // A non-EPERM error (e.g. corrupted profile) must not throw: re-init recovers.
    assert.doesNotThrow(() =>
      removePlaywrightProfile(profilePath, () => {
        const err: NodeJS.ErrnoException = new Error("ENOTEMPTY other deletion failure") as NodeJS.ErrnoException;
        err.code = "ENOTEMPTY";
        throw err;
      }),
    );
  } finally {
    removeOrRenameTree(dirBase);
  }
});
