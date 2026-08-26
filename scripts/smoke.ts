// Offline smoke test: crypto, db, router, chunking. Run with:
//   DISCORD_TOKEN=x DISCORD_CLIENT_ID=x DBOT_DATA_DIR=/tmp/dbot-test npx tsx scripts/smoke.ts
import assert from "node:assert";
import { encrypt, decrypt } from "../src/crypto.js";
import * as db from "../src/db.js";
import { applySubPreference, candidatesFor, earliestReset } from "../src/router.js";
import { chunkMessage } from "../src/format.js";

assert.equal(decrypt(encrypt("sk-ant-oat01-secret")), "sk-ant-oat01-secret");

db.setToken("alice", "tok-alice");
db.setToken("bob", "tok-bob");
db.addShare("bob", "*");
db.setToken("carol", "tok-carol");
db.addShare("carol", "dave");

let c = candidatesFor("dave").map((x) => x.ownerId);
assert.deepEqual(new Set(c), new Set(["bob", "carol"]));

const own = candidatesFor("alice");
assert.equal(own[0]!.ownerId, "alice");
assert.ok(own[0]!.isOwn);
assert.deepEqual(own.slice(1).map((x) => x.ownerId), ["bob"]);

// public-only share: bob restricts to public channels
db.addShare("bob", "*", true);
assert.deepEqual(candidatesFor("dave", undefined, false).map((x) => x.ownerId), ["carol"]);
assert.deepEqual(new Set(candidatesFor("dave", undefined, true).map((x) => x.ownerId)), new Set(["bob", "carol"]));
// re-sharing without the flag clears it
db.addShare("bob", "*", false);
assert.ok(candidatesFor("dave", undefined, false).some((x) => x.ownerId === "bob"));
assert.ok(db.listSharesByOwner("bob").every((s) => !s.publicOnly));

db.setCooldown("bob", Date.now() + 3600e3, "rate limit");
assert.deepEqual(candidatesFor("alice").map((x) => x.ownerId), ["alice"]);
assert.ok(earliestReset("dave")! > Date.now());

db.setCooldown("carol", Date.now() - 1000, "old");
assert.ok(candidatesFor("dave").some((x) => x.ownerId === "carol"));

db.deleteToken("bob");
assert.ok(!db.hasToken("bob"));
assert.deepEqual(db.donorsFor("dave", true), ["carol"]);

db.setSession("chan1", "xyz", "sess-1");
const sess = db.getSession("chan1", "xyz");
assert.equal(sess?.sessionId, "sess-1");
assert.ok(typeof sess?.updatedAt === "number" && sess.updatedAt > 0);
db.clearSessions("chan1");
assert.equal(db.getSession("chan1", "xyz"), undefined);

// model policy: dave asking for fable skips carol's sonnet-capped sub
db.setMaxTier("carol", "sonnet");
assert.deepEqual(candidatesFor("dave", "fable"), []);
assert.deepEqual(candidatesFor("dave", "sonnet").map((x) => x.ownerId), ["carol"]);
assert.deepEqual(candidatesFor("dave", "haiku").map((x) => x.ownerId), ["carol"]);
// carol's own asks are never capped
assert.ok(candidatesFor("carol", "fable").some((x) => x.ownerId === "carol" && x.isOwn));
db.setMaxTier("carol", "any");
assert.deepEqual(candidatesFor("dave", "fable").map((x) => x.ownerId), ["carol"]);

// sub preference: mine keeps only own token, donated only others'
const alicesCands = candidatesFor("alice", "sonnet");
assert.deepEqual(applySubPreference(alicesCands, "mine").map((x) => x.ownerId), ["alice"]);
assert.ok(applySubPreference(alicesCands, "donated").every((x) => !x.isOwn && x.ownerId !== "alice"));
assert.deepEqual(applySubPreference(alicesCands, "auto"), alicesCands);
assert.deepEqual(applySubPreference(candidatesFor("dave", "sonnet"), "mine"), []);

// usage ledger
db.logUsage({ ownerId: "carol", requesterId: "dave", model: "sonnet", inputTokens: 1000, outputTokens: 200, costUsd: 0.05 });
db.logUsage({ ownerId: "carol", requesterId: "dave", model: "fable", inputTokens: 5000, outputTokens: 800, costUsd: 0.9 });
db.logUsage({ ownerId: "carol", requesterId: "carol", model: "sonnet", inputTokens: 300, outputTokens: 50, costUsd: 0.01 });
const sum = db.usageSummary("carol", Date.now() - 60_000);
assert.equal(sum.runs, 3);
assert.equal(sum.inputTokens, 6300);
assert.ok(Math.abs(sum.costUsd - 0.96) < 1e-9);
assert.equal(sum.byRequester[0]!.requesterId, "dave");
assert.equal(sum.byModel[0]!.model, "fable");

// channel bot modes
assert.equal(db.getChannelMode("chan-x"), undefined);
db.setChannelMode("chan-x", "thread");
assert.equal(db.getChannelMode("chan-x"), "thread");
db.setChannelMode("chan-x", "off");
assert.equal(db.getChannelMode("chan-x"), "off");

// user notes: append, cap at 10, clear
for (let i = 1; i <= 12; i++) db.addUserNote("dave", `note ${i}`);
const daveNotes = db.getUserNotes("dave");
assert.equal(daveNotes.length, 10);
assert.equal(daveNotes[0], "note 3"); // oldest two rolled off
assert.equal(daveNotes[9], "note 12");
db.clearUserNotes("dave");
assert.equal(db.getUserNotes("dave").length, 0);

// utilization snapshot
db.setTokenStatus("carol", 42.5, "five_hour");
assert.equal(db.getTokenStatus("carol")!.utilization, 42.5);

const long = "intro\n```ts\n" + "const x = 1; // padding line\n".repeat(150) + "```\ntail";
const chunks = chunkMessage(long);
assert.ok(chunks.every((ch) => ch.length <= 2000), "chunk over limit");
assert.ok(chunks.length >= 2);
assert.ok(chunks[0]!.endsWith("```"), "first chunk closes fence");
assert.ok(chunks[1]!.startsWith("```"), "second chunk reopens fence");
assert.equal(chunkMessage("short").length, 1);

console.log(`ALL SMOKE TESTS PASSED — ${chunks.length} chunks, max len ${Math.max(...chunks.map((x) => x.length))}`);
