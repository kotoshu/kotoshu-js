# kotoshu-js

TypeScript client for the [Kotoshu](https://github.com/kotoshu/kotoshu)
HTTP spell-check API. Works in Node 18+, Deno, Bun, and browsers.

## Install

```bash
npm install @kotoshu/client
```

## Quick start

```ts
import { Client } from "@kotoshu/client";

const client = new Client("http://localhost:9292");

// Check a document
const result = await client.check("helo wrold", "en");
for (const err of result.errors) {
  console.log(err.word, "->", err.suggestions.slice(0, 3).map((s) => s.word));
}

// Suggestions for one word
const suggestions = await client.suggest("helo", { max: 3 });

// Language detection
const det = await client.detect("bonjour le monde");
console.log(det.language, det.confidence);

// Quick predicate
const isOk = await client.correct("hello", "en");
```

## Reference

### `new Client(baseUrl = "http://localhost:9292", options?)`

Options: `{ language?, timeoutMs?, fetch?, headers? }`. Pass `fetch` to
override (useful for older Node or custom interceptors).

### Methods

| Method | Returns |
|---|---|
| `health()` | `Promise<Health>` |
| `languages()` | `Promise<string[]>` |
| `check(text, language?, fmt?)` | `Promise<DocumentResult>` |
| `suggest(word, options?)` | `Promise<Suggestion[]>` |
| `detect(text)` | `Promise<Detection>` |
| `correct(word, language?)` | `Promise<boolean>` |

### Types

See [`src/index.ts`](./src/index.ts) — `DocumentResult`, `WordError`,
`Suggestion`, `Detection`, `Health`. Bundled as ESM + TypeScript types.

### Errors

- `KotoshuError`: base class; has `.code`.
- `ResourceNotSetupError`: 422 from server.

## WASM backend (optional, offline)

`@kotoshu/client` can also run the Kotoshu engine in-process — no
server, no network — through the optional `@kotoshu/wasm` package: a
291 KiB wasm-pack build of the engine from
[kotoshu-rs](https://github.com/kotoshu/kotoshu-rs). Word-level only:
`correct` and `suggest`, no document checking and no language detection.

```ts
import { createWasmDictionary } from "@kotoshu/client/dist/wasm.js";

const aff = await (await fetch("/dictionaries/en.aff")).text();
const dic = await (await fetch("/dictionaries/en.dic")).text();

const dict = await createWasmDictionary(aff, dic);
if (dict) {
  dict.correct("hello"); // => true
  dict.suggest("helo", 3);
  // => [{ word: "hello", distance: 1, confidence: 1,
  //        source: "edit_distance" }, ...]
} else {
  // backend resolved to "http": use the HTTP Client instead
}
```

The dictionary is loaded from the string CONTENTS of the `.aff`/`.dic`
files (wasm has no filesystem). `suggest` returns the client's
`Suggestion` shape field-for-field (`word`/`distance`/`confidence`/
`source`), so result handling is identical across backends.

### `KOTOSHU_BACKEND`

Same semantics as the Python package. Set the environment variable or
pass `{ backend }` to `createWasmDictionary` (the option wins):

| Value | Behavior |
|---|---|
| `auto` (default) | WASM when `@kotoshu/wasm` imports, else HTTP |
| `native` | force WASM; `NativeUnavailableError` when the module is missing |
| `http` | never use WASM; the factory resolves `null` |

"Available" means the dynamic `import("@kotoshu/wasm")` resolves.
`auto` with the module missing resolves `null` (the quiet fallback to
the HTTP `Client`); forced `native` with the module missing throws with
the install instructions below. `resolveBackend(setting, available)`,
`isWasmAvailable()` and `backend()` are exported for the decision logic.

### Installing the engine

`@kotoshu/wasm` is **not published to npm yet** (pending npm org
credentials), and it is deliberately not a dependency — an unresolvable
`optionalDependencies` entry still fails `npm ci`. Opt in explicitly
once it is published:

```bash
npm install @kotoshu/wasm
```

Until then, build it locally from kotoshu-rs (wasm-pack) and install
the built package:

```bash
git clone https://github.com/kotoshu/kotoshu-rs && cd kotoshu-rs
scripts/wasm_build.sh   # wasm-pack build -> kotoshu-wasm/pkg/
npm install ./kotoshu-wasm/pkg   # from your project
```

See also [`src/wasm.ts`](./src/wasm.ts).

## License

BSD-2-Clause, same as Kotoshu.
