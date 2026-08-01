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

## License

BSD-2-Clause, same as Kotoshu.
