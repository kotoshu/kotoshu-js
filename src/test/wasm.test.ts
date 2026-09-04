import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { KotoshuError, Suggestion } from "../index.js";
import {
  AUTO,
  ENV_VAR,
  HTTP,
  NATIVE,
  NativeUnavailableError,
  backend,
  createWasmDictionary,
  isWasmAvailable,
  resolveBackend,
  KotoshuWasmInstance,
  WasmModule,
} from "../wasm.js";

// ---- A fake @kotoshu/wasm module ---------------------------------------
//
// Same surface, engine-free. Injected through createWasmDictionary's
// loadModule option -- the only seam that must fake the import; the
// decision logic itself is tested purely below.

const suggestCalls: Array<{ word: string; limit: number | null | undefined }> = [];

class FakeKotoshuWasm {
  static readonly VERSION = "0.1.0-fake";

  constructor(readonly aff: string, readonly dic: string) {
    if (aff.includes("BOOM")) throw new Error("invalid aff source");
  }

  correct(word: string): boolean {
    return word === "hello" || word === "world";
  }

  suggest(
    word: string,
    limit?: number | null,
  ): Array<{ word: string; distance: number; confidence: number; source: string; junk?: string }> {
    suggestCalls.push({ word, limit });
    // "junk" must NOT survive the wrapper's field-for-field mapping.
    return [
      { word: "hello", distance: 1, confidence: 1, source: "edit_distance", junk: "must-not-leak" },
    ];
  }
}

function fakeModule(): WasmModule {
  return { KotoshuWasm: FakeKotoshuWasm };
}

function missingModule(): Promise<WasmModule> {
  return Promise.reject(new Error("Cannot find package '@kotoshu/wasm'"));
}

/** Runs `fn` with KOTOSHU_BACKEND pinned, restoring it after. */
async function withEnv(value: string | undefined, fn: () => Promise<void>): Promise<void> {
  const saved = process.env[ENV_VAR];
  if (value === undefined) delete process.env[ENV_VAR];
  else process.env[ENV_VAR] = value;
  try {
    await fn();
  } finally {
    if (saved === undefined) delete process.env[ENV_VAR];
    else process.env[ENV_VAR] = saved;
  }
}

// ---- Backend decision logic (pure; no imports, no environment) ----------

describe("resolveBackend decision logic", () => {
  it("defaults to auto: native when available, http otherwise", () => {
    assert.equal(resolveBackend(undefined, true), NATIVE);
    assert.equal(resolveBackend(undefined, false), HTTP);
    assert.equal(resolveBackend("", false), HTTP); // empty means auto
    assert.equal(resolveBackend("auto", false), HTTP);
    assert.equal(resolveBackend(" AUTO ", true), NATIVE); // trimmed, case-insensitive
  });

  it("forces http when asked, regardless of availability", () => {
    assert.equal(resolveBackend("http", true), HTTP);
    assert.equal(resolveBackend("http", false), HTTP);
  });

  it("forces native when available", () => {
    assert.equal(resolveBackend("native", true), NATIVE);
  });

  it("raises NativeUnavailableError when native is forced but unavailable", () => {
    assert.throws(
      () => resolveBackend("native", false),
      (err: unknown) => {
        assert.ok(err instanceof NativeUnavailableError);
        assert.ok(err instanceof KotoshuError);
        assert.match(err.message, /@kotoshu\/wasm/); // the pending npm publish
        assert.match(err.message, /wasm-pack/); // the local build path
        assert.match(err.message, /kotoshu-rs/);
        assert.match(err.message, new RegExp(`KOTOSHU_BACKEND=http`)); // the escape hatch
        return true;
      },
    );
  });

  it("rejects unknown values", () => {
    assert.throws(
      () => resolveBackend("grpc", true),
      (err: unknown) => {
        assert.ok(err instanceof KotoshuError);
        assert.match(err.message, /KOTOSHU_BACKEND.*grpc/);
        return true;
      },
    );
  });
});

describe("backend()", () => {
  it("uses the wasm module when auto and available", async () => {
    await withEnv(undefined, async () => {
      assert.equal(await backend(async () => fakeModule()), NATIVE);
    });
  });

  it("falls back to http when auto and unavailable", async () => {
    await withEnv(undefined, async () => {
      assert.equal(await backend(missingModule), HTTP);
    });
  });

  it("honors KOTOSHU_BACKEND=native", async () => {
    await withEnv("native", async () => {
      assert.equal(await backend(async () => fakeModule()), NATIVE);
      await assert.rejects(() => backend(missingModule), NativeUnavailableError);
    });
  });

  it("honors KOTOSHU_BACKEND=http", async () => {
    await withEnv("http", async () => {
      assert.equal(await backend(async () => fakeModule()), HTTP);
    });
  });
});

// ---- The wrapper: shape mapping over an injected module -----------------

describe("createWasmDictionary shape mapping", () => {
  it("returns a wrapper exposing the engine version", async () => {
    const dict = await createWasmDictionary("SET UTF-8\n", "1\nhello\n", {
      backend: "native",
      loadModule: async () => fakeModule(),
    });
    assert.ok(dict);
    assert.equal(dict.version(), "0.1.0-fake");
  });

  it("delegates correct()", async () => {
    const dict = await createWasmDictionary("SET UTF-8\n", "1\nhello\n", {
      backend: "native",
      loadModule: async () => fakeModule(),
    });
    assert.ok(dict);
    assert.equal(dict.correct("hello"), true);
    assert.equal(dict.correct("ruby"), false);
  });

  it("maps suggest rows to the HTTP client's Suggestion shape, field-for-field", async () => {
    const dict = await createWasmDictionary("SET UTF-8\n", "1\nhello\n", {
      backend: "native",
      loadModule: async () => fakeModule(),
    });
    assert.ok(dict);
    suggestCalls.length = 0;
    const suggestions: Suggestion[] = dict.suggest("helo", 3);
    // Exactly the four Suggestion fields the HTTP client returns; the
    // fake row's extra key is dropped and no metadata key appears.
    assert.deepEqual(suggestions, [
      { word: "hello", distance: 1, confidence: 1, source: "edit_distance" },
    ]);
    assert.deepEqual(Object.keys(suggestions[0]).sort(), [
      "confidence",
      "distance",
      "source",
      "word",
    ]);
  });

  it("defaults the suggestion limit to 5 and passes custom limits through", async () => {
    const dict = await createWasmDictionary("SET UTF-8\n", "1\nhello\n", {
      backend: "native",
      loadModule: async () => fakeModule(),
    });
    assert.ok(dict);
    suggestCalls.length = 0;
    dict.suggest("helo");
    assert.equal(suggestCalls[0].limit, 5);
    dict.suggest("helo", 3);
    assert.equal(suggestCalls[1].limit, 3);
  });

  it("wraps engine load failures in KotoshuError with the engine message", async () => {
    await assert.rejects(
      () =>
        createWasmDictionary("SET BOOM\n", "1\nhello\n", {
          backend: "native",
          loadModule: async () => fakeModule(),
        }),
      (err: unknown) => {
        assert.ok(err instanceof KotoshuError);
        assert.match(err.message, /loading wasm dictionary failed: invalid aff source/);
        return true;
      },
    );
  });
});

// ---- Backend resolution through the factory ------------------------------

describe("createWasmDictionary backend resolution", () => {
  it("resolves null when http is forced, even with the module present", async () => {
    const dict = await createWasmDictionary("SET UTF-8\n", "1\nhello\n", {
      backend: "http",
      loadModule: async () => fakeModule(),
    });
    assert.equal(dict, null);
  });

  it("resolves null in auto mode when the module is missing (quiet fallback)", async () => {
    const dict = await createWasmDictionary("SET UTF-8\n", "1\nhello\n", {
      backend: "auto",
      loadModule: missingModule,
    });
    assert.equal(dict, null);
  });

  it("raises NativeUnavailableError when native is forced and the module is missing", async () => {
    await assert.rejects(
      () =>
        createWasmDictionary("SET UTF-8\n", "1\nhello\n", {
          backend: "native",
          loadModule: missingModule,
        }),
      (err: unknown) => {
        assert.ok(err instanceof NativeUnavailableError);
        assert.match(err.message, /@kotoshu\/wasm/);
        assert.match(err.message, /wasm-pack/);
        return true;
      },
    );
  });

  it("reads KOTOSHU_BACKEND when no option is given", async () => {
    await withEnv(undefined, async () => {
      assert.ok(await createWasmDictionary("SET UTF-8\n", "1\nhello\n", {
        loadModule: async () => fakeModule(),
      }));
    });
    await withEnv("http", async () => {
      assert.equal(
        await createWasmDictionary("SET UTF-8\n", "1\nhello\n", {
          loadModule: async () => fakeModule(),
        }),
        null,
      );
    });
    await withEnv("native", async () => {
      await assert.rejects(
        () => createWasmDictionary("SET UTF-8\n", "1\nhello\n", { loadModule: missingModule }),
        NativeUnavailableError,
      );
    });
  });
});

// ---- The real @kotoshu/wasm module (skipped until it is installed) -------

const realWasmAvailable = await isWasmAvailable();

describe("real @kotoshu/wasm module", { skip: realWasmAvailable ? false : "@kotoshu/wasm is not installed" }, () => {
  // The engine's own from_bytes test dictionary (kotoshu-rs lookup.rs):
  // the minimal real .aff/.dic pair the engine documents.
  const AFF = "SET UTF-8\nTRY esethntoaiolrd\n";
  const DIC = "2\nhello\nworld/MS\n";

  it("smokes correct/suggest over an inline dictionary", async () => {
    const dict = await createWasmDictionary(AFF, DIC, { backend: "native" });
    assert.ok(dict, "native was forced and the module is available");
    assert.match(dict.version(), /^\d+\.\d+\.\d+$/);
    assert.equal(dict.correct("hello"), true);
    assert.equal(dict.correct("ruby"), false);
    const suggestions = dict.suggest("helo", 5);
    assert.ok(Array.isArray(suggestions));
    for (const s of suggestions) {
      assert.deepEqual(Object.keys(s).sort(), ["confidence", "distance", "source", "word"]);
    }
    assert.ok(suggestions.some((s) => s.word === "hello"));
  });
});
