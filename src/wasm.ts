/**
 * Optional WASM engine backend.
 *
 * Wraps the `@kotoshu/wasm` npm package -- the wasm-pack build of the
 * kotoshu-rs engine -- behind the same result shapes the HTTP client
 * returns, so `Suggestion` objects are identical across backends.
 *
 * The package is not published to npm yet (blocked on org credentials),
 * so `npm install @kotoshu/client` has no WASM engine: `isWasmAvailable()`
 * resolves false and the default `auto` backend quietly yields to HTTP.
 * Build the module locally to use it today (see README, "WASM backend").
 *
 * Word-level only: the offline engine has no document parsing and no
 * language detection.
 */

import { KotoshuError, Suggestion } from "./index.js";

/** Environment variable selecting the backend: "native", "http" or "auto". */
export const ENV_VAR = "KOTOSHU_BACKEND";

export const NATIVE = "native";
export const HTTP = "http";
export const AUTO = "auto";

/** A `KOTOSHU_BACKEND` value: "native" (WASM), "http" or "auto". */
export type BackendSetting = typeof NATIVE | typeof HTTP | typeof AUTO;

/** The backend in effect after resolving a setting: "native" or "http". */
export type ResolvedBackend = typeof NATIVE | typeof HTTP;

/** The engine's suggestion limit when none is given (the gem's default). */
const DEFAULT_SUGGEST_LIMIT = 5;

// Deliberately not a literal inside the import() call: tsc would try (and
// fail) to resolve the not-yet-published package at build time. A
// non-literal specifier keeps the build dependency-free; the runtime
// import either resolves or is handled by the availability logic below.
const WASM_MODULE_ID: string = "@kotoshu/wasm";

const UNAVAILABLE_MESSAGE = [
  `the WASM backend was requested (KOTOSHU_BACKEND=${NATIVE}) but the`,
  `'${WASM_MODULE_ID}' module could not be imported.`,
  `'${WASM_MODULE_ID}' is not published to npm yet (pending npm org`,
  "credentials); until then build it locally from the kotoshu-rs",
  "repository:",
  "  git clone https://github.com/kotoshu/kotoshu-rs && cd kotoshu-rs",
  "  scripts/wasm_build.sh   # wasm-pack build -> kotoshu-wasm/pkg/",
  "  npm install ./kotoshu-wasm/pkg",
  `Or keep using the HTTP backend: ${ENV_VAR}=${HTTP}`,
].join("\n");

export class NativeUnavailableError extends KotoshuError {
  constructor(message: string) {
    super(message, "native_unavailable");
    this.name = "NativeUnavailableError";
  }
}

/**
 * One loaded WASM dictionary -- the offline twin of `Client`. Created by
 * `createWasmDictionary`; `correct`/`suggest` return exactly the shapes
 * the HTTP client returns, so result handling is identical across
 * backends. Word-level only: the offline engine has no document parsing
 * and no language detection.
 */
export interface WasmDictionary {
  /** The engine (kotoshu crate) version string. */
  version(): string;
  /** True when `word` is in the dictionary (no errors). */
  correct(word: string): boolean;
  /** Suggestions for `word`, same `Suggestion` shape as `Client.suggest`. */
  suggest(word: string, limit?: number): Suggestion[];
}

/** One `KotoshuWasm` instance, as this wrapper consumes it. */
export interface KotoshuWasmInstance {
  correct(word: string): boolean;
  suggest(
    word: string,
    limit?: number | null,
  ): Array<{
    word: string;
    distance: number;
    confidence: number;
    source: string;
  }>;
}

/** `new KotoshuWasm(affSource, dicSource)` plus the static `VERSION`. */
export interface KotoshuWasmConstructor {
  readonly VERSION: string;
  new (affSource: string, dicSource: string): KotoshuWasmInstance;
}

/**
 * The `@kotoshu/wasm` module surface this wrapper depends on. Declared
 * here (not imported) because the package is not published yet; when it
 * is, its `kotoshu_wasm.d.ts` matches this shape.
 */
export interface WasmModule {
  /** wasm-pack web/nodejs glues export `init`; bundler glues self-initialize. */
  default?: () => Promise<unknown>;
  KotoshuWasm: KotoshuWasmConstructor;
}

/** Loads the `@kotoshu/wasm` module (injected in tests). */
export type WasmModuleLoader = () => Promise<WasmModule>;

/** Options for `createWasmDictionary`. */
export interface WasmDictionaryOptions {
  /**
   * Backend selection, mirroring the Python package's `KOTOSHU_BACKEND`
   * semantics: "native" (force WASM; errors when the module is missing),
   * "http" (never use WASM; the factory resolves null) or "auto" (default:
   * WASM when the module imports, else null so the caller falls back to
   * the HTTP `Client`). Defaults to the `KOTOSHU_BACKEND` environment
   * variable when set, itself defaulting to "auto".
   */
  backend?: BackendSetting;
  /** Replaces the dynamic `@kotoshu/wasm` import (test seam). */
  loadModule?: WasmModuleLoader;
}

/**
 * Resolve a backend setting to "native" or "http".
 *
 * Pure decision function (no environment, no imports): `setting` is the
 * raw option or env value (undefined or empty means "auto"),
 * `nativeAvailable` is whether the `@kotoshu/wasm` import resolves.
 * Throws `NativeUnavailableError` when "native" is forced but
 * unavailable, `KotoshuError` for anything else.
 */
export function resolveBackend(
  setting: string | undefined,
  nativeAvailable: boolean,
): ResolvedBackend {
  const choice = (setting || AUTO).trim().toLowerCase();
  if (choice === AUTO) return nativeAvailable ? NATIVE : HTTP;
  if (choice === HTTP) return HTTP;
  if (choice === NATIVE) {
    if (!nativeAvailable) throw new NativeUnavailableError(UNAVAILABLE_MESSAGE);
    return NATIVE;
  }
  throw new KotoshuError(
    `invalid ${ENV_VAR}=${JSON.stringify(setting)}: expected 'native', 'http' or 'auto'`,
    "invalid_backend",
  );
}

/** True when the dynamic `@kotoshu/wasm` import resolves. */
export async function isWasmAvailable(
  loadModule: WasmModuleLoader = importWasmModule,
): Promise<boolean> {
  try {
    await loadModule();
    return true;
  } catch {
    return false;
  }
}

/**
 * The backend in effect: "native" or "http".
 *
 * Honors `KOTOSHU_BACKEND` (native|http|auto; default auto: WASM when
 * the module imports, else http). Throws `NativeUnavailableError` when
 * "native" is forced but the module is missing.
 */
export async function backend(
  loadModule: WasmModuleLoader = importWasmModule,
): Promise<ResolvedBackend> {
  return resolveBackend(envBackend(), await isWasmAvailable(loadModule));
}

/**
 * Load a WASM dictionary from the string CONTENTS of its `.aff` and
 * `.dic` sources (wasm has no filesystem) -- the offline spell-check
 * entry point. `correct`/`suggest` results match the HTTP client's
 * shapes field-for-field.
 *
 * Resolves null when the backend resolves to "http" (the `http` setting,
 * or `auto` with the module missing): the twin of the Python package's
 * quiet auto fallback -- use the HTTP `Client` there. Throws
 * `NativeUnavailableError` when "native" is forced and the module is
 * missing (see the message for the pending npm publish and the local
 * wasm-pack build path).
 */
export async function createWasmDictionary(
  affSource: string,
  dicSource: string,
  options: WasmDictionaryOptions = {},
): Promise<WasmDictionary | null> {
  const setting = options.backend ?? envBackend();
  const loadModule = options.loadModule ?? importWasmModule;
  const resolved = resolveBackend(setting, await isWasmAvailable(loadModule));
  if (resolved === HTTP) return null;

  let mod: WasmModule;
  try {
    mod = await loadModule();
  } catch (err) {
    // The availability probe passed but the load now failed (e.g. the
    // wasm-pack glue's init threw); surface it as a KotoshuError.
    throw new KotoshuError(`loading the wasm module failed: ${messageOf(err)}`);
  }
  let impl: KotoshuWasmInstance;
  try {
    impl = new mod.KotoshuWasm(affSource, dicSource);
  } catch (err) {
    // The engine rejects bad .aff/.dic sources with its own message.
    throw new KotoshuError(`loading wasm dictionary failed: ${messageOf(err)}`);
  }
  return new WasmDictionaryWrapper(mod, impl);
}

// ---- Internals ----

async function importWasmModule(): Promise<WasmModule> {
  const mod = (await import(WASM_MODULE_ID)) as WasmModule;
  // wasm-pack --target bundler glues self-initialize (no default export);
  // web/nodejs glues export a default init() that must run first.
  if (typeof mod.default === "function") await mod.default();
  return mod;
}

/** The `KOTOSHU_BACKEND` env value; undefined in browsers (means "auto"). */
function envBackend(): string | undefined {
  if (typeof process === "undefined" || !process.env) return undefined;
  const value = process.env[ENV_VAR];
  return value === "" ? undefined : value;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

class WasmDictionaryWrapper implements WasmDictionary {
  constructor(
    private readonly module: WasmModule,
    private readonly impl: KotoshuWasmInstance,
  ) {}

  version(): string {
    return this.module.KotoshuWasm.VERSION;
  }

  correct(word: string): boolean {
    try {
      return this.impl.correct(word);
    } catch (err) {
      throw new KotoshuError(`wasm check failed: ${messageOf(err)}`);
    }
  }

  suggest(word: string, limit?: number): Suggestion[] {
    let rows;
    try {
      rows = this.impl.suggest(word, limit ?? DEFAULT_SUGGEST_LIMIT);
    } catch (err) {
      throw new KotoshuError(`wasm suggest failed: ${messageOf(err)}`);
    }
    // Map field-for-field so rows match the HTTP client's Suggestion
    // shape exactly (word/distance/confidence/source; no metadata).
    return rows.map((row) => ({
      word: row.word,
      distance: row.distance,
      confidence: row.confidence,
      source: row.source,
    }));
  }
}
