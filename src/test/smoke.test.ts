import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { Client, KotoshuError, WordError, Suggestion } from "../index.js";

const URL = process.env.KOTOSHU_TEST_URL ?? "http://localhost:9292";

describe("kotoshu-js client", async () => {
  let client: Client;

  before(async () => {
    client = new Client(URL);
    try {
      await client.health();
    } catch (err) {
      console.warn(`skipping: no kotoshu server at ${URL}: ${err}`);
    }
  });

  it("checks text and flags misspelled words", async () => {
    const result = await client.check("helo wrold", "en");
    const words = result.errors.map((e: WordError) => e.word).sort();
    assert.deepEqual(words, ["helo", "wrold"]);
  });

  it("returns success for clean text", async () => {
    const result = await client.check("hello world", "en");
    assert.equal(result.errors.length, 0);
  });

  it("returns suggestions for a word", async () => {
    const suggestions = await client.suggest("helo", { language: "en", max: 3 });
    assert.ok(suggestions.length <= 3);
    assert.ok(suggestions.some((s: Suggestion) => s.word === "hello"));
  });

  it("detects language with confidence", async () => {
    const det = await client.detect("hello world");
    assert.equal(typeof det.language, "string");
    assert.ok(det.confidence >= 0 && det.confidence <= 1);
  });

  it("exposes correct() helper", async () => {
    assert.equal(await client.correct("hello", "en"), true);
    assert.equal(await client.correct("helo", "en"), false);
  });

  it("lists cached languages", async () => {
    const langs = await client.languages();
    assert.ok(Array.isArray(langs));
    assert.ok(langs.includes("en"));
  });

  it("raises KotoshuError on missing 'text'", async () => {
    await assert.rejects(
      // Sending invalid body directly via internal request shape
      (async () => {
        const resp = await fetch(`${URL}/v1/check`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ language: "en" }),
        });
        if (!resp.ok) {
          const err = (await resp.json()) as { error: string; message: string };
          throw new KotoshuError(`${err.error}: ${err.message}`, err.error);
        }
      }),
      KotoshuError,
    );
  });
});
