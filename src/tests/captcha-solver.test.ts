import { test } from "node:test";
import assert from "node:assert/strict";
import type { FrameLocator, Locator, Page } from "playwright";
import {
  extractBaxiaChallengeUrl,
  solveBaxiaCaptcha,
} from "../services/captcha-solver.ts";

type LocatorOptions = {
  isVisible?: () => Promise<boolean>;
  waitFor?: (options?: unknown) => Promise<void>;
  boundingBox?: () => Promise<{
    x: number;
    y: number;
    width: number;
    height: number;
  } | null>;
};

function locator(options: LocatorOptions = {}): Locator {
  const value = {
    first: () => value,
    isVisible: options.isVisible ?? (async () => false),
    waitFor: options.waitFor ?? (async () => undefined),
    boundingBox: options.boundingBox ?? (async () => null),
  };
  return value as unknown as Locator;
}

function pageWithLocators(
  locators: Record<string, Locator>,
  frame: FrameLocator,
  mouse: Page["mouse"] = {
    move: async () => undefined,
    down: async () => undefined,
    up: async () => undefined,
  } as unknown as Page["mouse"],
): Page {
  const fallback = locator();
  const resolveLocator = (selector: string): Locator =>
    locators[selector] ??
    (selector.includes("nc_1_n1z") ? locators["#nc_1_n1z"] : undefined) ??
    (selector.includes("nc_1_n1t") ? locators["#nc_1_n1t"] : undefined) ??
    fallback;
  return {
    locator: resolveLocator,
    frameLocator: () => frame,
    mouse,
  } as unknown as Page;
}

function captureWarnings(): {
  warnings: string[];
  restore: () => void;
} {
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map((arg) => String(arg)).join(" "));
  };
  return {
    warnings,
    restore: () => {
      console.warn = originalWarn;
    },
  };
}

function baxiaFrame(slider: Locator, track: Locator): FrameLocator {
  return {
    locator: (selector: string) => {
      if (
        selector.includes("nc_1_n1z") ||
        selector.includes(".btn_slide")
      ) {
        return slider;
      }
      if (
        selector.includes("nc_1_n1t") ||
        selector.includes(".nc_scale")
      ) {
        return track;
      }
      return locator();
    },
  } as unknown as FrameLocator;
}

test("captcha solver returns false when no Baxia challenge is visible", async () => {
  const page = pageWithLocators({}, baxiaFrame(locator(), locator()));

  assert.equal(await solveBaxiaCaptcha(page), false);
});

test("captcha solver handles the current container with a nested iframe", async () => {
  let challengeVisible = true;
  let mouseDownCalls = 0;
  let mouseUpCalls = 0;
  const visible = () => Promise.resolve(challengeVisible);
  const dialog = locator({ isVisible: visible });
  const content = locator({ isVisible: visible });
  const iframe = locator({ isVisible: visible });
  const slider = locator({
    waitFor: async () => undefined,
    boundingBox: async () => ({ x: 10, y: 20, width: 40, height: 40 }),
  });
  const track = locator({
    boundingBox: async () => ({ x: 10, y: 20, width: 300, height: 40 }),
  });
  const frame = baxiaFrame(slider, track);
  const page = pageWithLocators(
    {
      ".baxia-dialog": dialog,
      "#baxia-dialog-content": content,
      ".baxia-dialog #baxia-dialog-content iframe": iframe,
    },
    frame,
    {
      move: async () => undefined,
      down: async () => {
        mouseDownCalls++;
      },
      up: async () => {
        mouseUpCalls++;
        challengeVisible = false;
      },
    } as unknown as Page["mouse"],
  );
  const captured = captureWarnings();

  try {
    const solved = await solveBaxiaCaptcha(page, {
      maxAttempts: 1,
      retryDelayMs: 0,
      settleMs: 0,
    });

    assert.equal(solved, true);
    assert.equal(mouseDownCalls, 1);
    assert.equal(mouseUpCalls, 1);
    assert.ok(
      captured.warnings.some(
        (warning) =>
          warning.startsWith("✅ [Captcha] solve_succeeded") &&
          warning.includes("scope=\"iframe\"") &&
          warning.includes("attempt=1") &&
          warning.includes("track=300") &&
          warning.includes("slider=40") &&
          warning.includes("distance=260"),
      ),
    );
  } finally {
    captured.restore();
  }
});

test("captcha solver handles a standalone NC document without an iframe", async () => {
  let challengeVisible = true;
  const challenge = locator({
    isVisible: () => Promise.resolve(challengeVisible),
  });
  const slider = locator({
    waitFor: async () => undefined,
    boundingBox: async () => ({ x: 10, y: 20, width: 40, height: 40 }),
  });
  const track = locator({
    boundingBox: async () => ({ x: 10, y: 20, width: 300, height: 40 }),
  });
  const page = pageWithLocators(
    {
      "#nocaptcha": challenge,
      "#baxia-punish": challenge,
      "#nc_1_n1z": slider,
      "#nc_1_n1t": track,
    },
    baxiaFrame(slider, track),
    {
      move: async () => undefined,
      down: async () => undefined,
      up: async () => {
        challengeVisible = false;
      },
    } as unknown as Page["mouse"],
  );
  const captured = captureWarnings();

  try {
    assert.equal(
      await solveBaxiaCaptcha(page, {
        maxAttempts: 1,
        retryDelayMs: 0,
        settleMs: 0,
      }),
      true,
    );
    assert.ok(
      captured.warnings.some(
        (warning) =>
          warning.startsWith("✅ [Captcha] solve_succeeded") &&
          warning.includes("scope=\"top_level\""),
      ),
    );
  } finally {
    captured.restore();
  }
});

test("captcha solver keeps supporting the legacy iframe id", async () => {
  let iframeVisible = true;
  const iframe = locator({ isVisible: () => Promise.resolve(iframeVisible) });
  const slider = locator({
    waitFor: async () => undefined,
    boundingBox: async () => ({ x: 10, y: 20, width: 40, height: 40 }),
  });
  const track = locator({
    boundingBox: async () => ({ x: 10, y: 20, width: 300, height: 40 }),
  });

  const originalWarn = console.warn;
  console.warn = () => undefined;
  try {
    // The legacy mock has no outer dialog. The iframe disappearing is the
    // success signal used by older Baxia versions.
    const mouse = {
      move: async () => undefined,
      down: async () => undefined,
      up: async () => {
        iframeVisible = false;
      },
    } as unknown as Page["mouse"];
    const legacyPage = pageWithLocators(
      {
        "iframe#baxia-dialog-content": iframe,
      },
      baxiaFrame(slider, track),
      mouse,
    );

    assert.equal(
      await solveBaxiaCaptcha(legacyPage, {
        maxAttempts: 1,
        retryDelayMs: 0,
        settleMs: 0,
      }),
      true,
    );
  } finally {
    console.warn = originalWarn;
  }
});

test("captcha solver reports a visible dialog without an iframe", async () => {
  const captured = captureWarnings();
  try {
    const page = pageWithLocators(
      {
        ".baxia-dialog": locator({ isVisible: async () => true }),
        "#baxia-dialog-content": locator({ isVisible: async () => true }),
      },
      baxiaFrame(locator(), locator()),
    );

    assert.equal(
      await solveBaxiaCaptcha(page, {
        waitForMs: 0,
        maxAttempts: 1,
      }),
      false,
    );
    // Intermediate detection events are debug-only; the important behavior is
    // that the solver returns false without emitting a false success/failure.
    assert.equal(
      captured.warnings.some((warning) =>
        warning.includes("solve_succeeded"),
      ),
      false,
    );
    assert.equal(
      captured.warnings.some((warning) =>
        warning.includes("solve_failed"),
      ),
      false,
    );
  } finally {
    captured.restore();
  }
});

test("captcha solver reports an iframe with no slider", async () => {
  const captured = captureWarnings();
  try {
    const page = pageWithLocators(
      {
        ".baxia-dialog": locator({ isVisible: async () => true }),
        "#baxia-dialog-content": locator({ isVisible: async () => true }),
        ".baxia-dialog #baxia-dialog-content iframe": locator({
          isVisible: async () => true,
        }),
      },
      baxiaFrame(
        locator({
          waitFor: async () => {
            throw new Error("slider timeout");
          },
        }),
        locator(),
      ),
    );

    assert.equal(
      await solveBaxiaCaptcha(page, {
        waitForMs: 0,
        maxAttempts: 1,
        retryDelayMs: 0,
      }),
      false,
    );
    assert.ok(
      captured.warnings.some(
        (warning) =>
          warning.startsWith("❌ [Captcha] solve_failed") &&
          warning.includes("scope=\"iframe\"") &&
          warning.includes("attempts=1") &&
          warning.includes("reason=\"slider_not_found\""),
      ),
    );
  } finally {
    captured.restore();
  }
});

test("captcha solver recovers from error300/errloading state by clicking the reload link", async () => {
  let refreshClicked = false;
  let sliderVisible = false;

  const refreshLocator = locator({
    isVisible: async () => !sliderVisible,
    waitFor: async () => undefined,
  });
  // Mock click on the reload link makes the slider visible on the next pass
  (refreshLocator as any).click = async () => {
    refreshClicked = true;
    sliderVisible = true;
  };

  const sliderLocator = locator({
    isVisible: async () => sliderVisible,
    waitFor: async () => {
      if (!sliderVisible) throw new Error("slider not visible yet");
    },
    boundingBox: async () => ({ x: 100, y: 100, width: 40, height: 40 }),
  });

  const trackLocator = locator({
    isVisible: async () => true,
    boundingBox: async () => ({ x: 100, y: 100, width: 300, height: 40 }),
  });

  const successLocator = locator({
    isVisible: async () => true,
  });

  const frame = {
    locator: (selector: string) => {
      if (selector.includes("nc_1_refresh") || selector.includes("errloading") || selector.includes("btn_refresh")) {
        return refreshLocator;
      }
      if (selector.includes("nc_1_n1z") || selector.includes(".btn_slide")) {
        return sliderLocator;
      }
      if (selector.includes("nc_1_n1t") || selector.includes(".nc_scale")) {
        return trackLocator;
      }
      if (selector.includes("btn_ok") || selector.includes("nc_ok") || selector.includes("nc_result")) {
        return successLocator;
      }
      return locator();
    },
  } as unknown as FrameLocator;

  const page = pageWithLocators(
    {
      ".baxia-dialog": locator({ isVisible: async () => true }),
      "#baxia-dialog-content": locator({ isVisible: async () => true }),
      ".baxia-dialog #baxia-dialog-content iframe": locator({ isVisible: async () => true }),
    },
    frame,
  );

  const solved = await solveBaxiaCaptcha(page, {
    waitForMs: 0,
    maxAttempts: 2,
    retryDelayMs: 0,
    settleMs: 0,
    sliderTimeoutMs: 50,
  });

  assert.equal(refreshClicked, true, "expected refresh link to be clicked when error state is active");
  assert.equal(solved, true, "expected captcha to be solved after recovering from error state");
});

const QWEN_BASE = "https://chat.qwen.ai";

test("extractBaxiaChallengeUrl reads a protocol-relative punish url", () => {
  const body =
    '{"host":"chat.qwen.ai","action":"captcha","url":"//chat.qwen.ai/_____tmd_____/punish?x5secdata=abc&x5step=2"}';

  assert.equal(
    extractBaxiaChallengeUrl(body, QWEN_BASE),
    "https://chat.qwen.ai/_____tmd_____/punish?x5secdata=abc&x5step=2",
  );
});

test("extractBaxiaChallengeUrl unescapes JSON and HTML wrappers", () => {
  const jsonEscaped =
    '{"url":"https:\/\/chat.qwen.ai\/_____tmd_____\/punish?x5secdata=abc"}';
  assert.equal(
    extractBaxiaChallengeUrl(jsonEscaped, QWEN_BASE),
    "https://chat.qwen.ai/_____tmd_____/punish?x5secdata=abc",
  );

  const metaRefresh =
    '<meta http-equiv="refresh" content="0;url=/_____tmd_____/punish?x5secdata=abc&amp;x5step=2">';
  assert.equal(
    extractBaxiaChallengeUrl(metaRefresh, QWEN_BASE),
    "https://chat.qwen.ai/_____tmd_____/punish?x5secdata=abc&x5step=2",
  );
});

test("extractBaxiaChallengeUrl accepts a punish url identified only by x5secdata", () => {
  const body = '{"url":"https://chat.qwen.ai/punish?x5secdata=abc&action=captcha"}';

  assert.equal(
    extractBaxiaChallengeUrl(body, QWEN_BASE),
    "https://chat.qwen.ai/punish?x5secdata=abc&action=captcha",
  );
});

test("extractBaxiaChallengeUrl never navigates the account page off the Qwen origin", () => {
  const foreignHost =
    '{"url":"https://evil.example.com/_____tmd_____/punish?x5secdata=abc"}';
  assert.equal(extractBaxiaChallengeUrl(foreignHost, QWEN_BASE), null);

  // A non-http scheme can never survive: anything returned is resolved against
  // the Qwen origin, so the account page cannot be sent somewhere else.
  const foreignScheme = '{"url":"javascript:alert(1)/_____tmd_____/punish"}';
  const resolved = extractBaxiaChallengeUrl(foreignScheme, QWEN_BASE);
  assert.ok(resolved === null || resolved.startsWith(`${QWEN_BASE}/`));
});

test("extractBaxiaChallengeUrl returns null for a challenge body without a url", () => {
  assert.equal(
    extractBaxiaChallengeUrl(
      '<!doctype html><meta name="aliyun_waf_aa" content="challenge">',
      QWEN_BASE,
    ),
    null,
  );
  assert.equal(extractBaxiaChallengeUrl("", QWEN_BASE), null);
});

test("challenge recovery opens the punish url before solving", async () => {
  const { solveChallengeOnPage } = await import(
    "../services/captcha-coordinator.ts"
  );

  const visited: string[] = [];
  let currentUrl = "https://chat.qwen.ai/";
  let challengeVisible = false;
  const challenge = locator({ isVisible: async () => challengeVisible });
  const slider = locator({
    waitFor: async () => undefined,
    boundingBox: async () => ({ x: 10, y: 20, width: 40, height: 40 }),
  });
  const track = locator({
    boundingBox: async () => ({ x: 10, y: 20, width: 300, height: 40 }),
  });

  const page = {
    ...pageWithLocators(
      {
        "#nocaptcha": challenge,
        "#baxia-punish": challenge,
        "#nc_1_n1z": slider,
        "#nc_1_n1t": track,
      },
      baxiaFrame(slider, track),
      {
        move: async () => undefined,
        down: async () => undefined,
        up: async () => {
          challengeVisible = false;
        },
      } as unknown as Page["mouse"],
    ),
    url: () => currentUrl,
    goto: async (url: string) => {
      visited.push(url);
      currentUrl = url;
      // The WAF renders the slider only once the page opens the punish document.
      challengeVisible = url.includes("_____tmd_____");
    },
  } as unknown as Page;

  const captured = captureWarnings();
  try {
    assert.equal(
      await solveChallengeOnPage(
        page,
        "https://chat.qwen.ai/_____tmd_____/punish?x5secdata=abc",
      ),
      true,
    );
  } finally {
    captured.restore();
  }

  assert.deepEqual(visited, [
    "https://chat.qwen.ai/_____tmd_____/punish?x5secdata=abc",
    "https://chat.qwen.ai",
  ]);
  assert.ok(
    captured.warnings.includes(
      '🚪 [Captcha] challenge_opened | source="response_body"',
    ),
  );
});

test("challenge recovery reloads the chat page when the body carries no url", async () => {
  const { solveChallengeOnPage } = await import(
    "../services/captcha-coordinator.ts"
  );

  const visited: string[] = [];
  const page = {
    ...pageWithLocators({}, baxiaFrame(locator(), locator())),
    url: () => "https://chat.qwen.ai/",
    goto: async (url: string) => {
      visited.push(url);
    },
  } as unknown as Page;

  const captured = captureWarnings();
  try {
    assert.equal(await solveChallengeOnPage(page, null, 50), false);
  } finally {
    captured.restore();
  }

  assert.deepEqual(visited, ["https://chat.qwen.ai"]);
  assert.ok(
    captured.warnings.includes(
      '🚪 [Captcha] challenge_opened | source="chat_reload"',
    ),
  );
});
