// What the alarm relay says, when it stays quiet, and how it reads its token.
// Backported from upstream dilaya/aws-sqlite-data (548ba20, cbaeb7c). Each
// half is load-bearing: a wrong first sentence misleads at the one moment
// somebody reads fast, an unfiltered birth-OK trains everyone to ignore the
// channel, and a mis-parsed token fails only when an alarm actually fires.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

const require_ = createRequire(import.meta.url);
const { tokenFrom } = require_("../lib/heartbeat-relay/token.js");
const { shouldAnnounce } = require_("../lib/heartbeat-relay/announce.js");
const { formatMessage } = require_("../lib/heartbeat-relay/format.js");

const STACK = "p-00000000-0000-4000-8000-000000000000";

test("token: reads bot_token out of a JSON credentials record, never the webhook secret", () => {
  const stored = JSON.stringify({ bot_token: "123456:AAE-secret", secret_token: "NOT-THE-TOKEN" });
  assert.equal(tokenFrom(stored), "123456:AAE-secret");
});

test("token: a bare token keeps working", () => {
  assert.equal(tokenFrom("123456:AAE-secret"), "123456:AAE-secret");
});

test("token: any unexpected shape falls back to the raw value (never throw at alarm time)", () => {
  assert.equal(tokenFrom("{not json"), "{not json");
  assert.equal(tokenFrom(JSON.stringify({ secret_token: "only" })), '{"secret_token":"only"}');
  assert.equal(tokenFrom(JSON.stringify({ bot_token: 42 })), '{"bot_token":42}');
  assert.equal(tokenFrom("null"), "null");
});

test("a brand-new alarm's INSUFFICIENT_DATA → OK is NOT announced", () => {
  assert.equal(shouldAnnounce({ NewStateValue: "OK", OldStateValue: "INSUFFICIENT_DATA" }), false);
});

test("a real recovery IS announced; ALARM and anything unrecognised always are", () => {
  assert.equal(shouldAnnounce({ NewStateValue: "OK", OldStateValue: "ALARM" }), true);
  assert.equal(shouldAnnounce({ NewStateValue: "ALARM", OldStateValue: "OK" }), true);
  assert.equal(shouldAnnounce({ NewStateValue: "INSUFFICIENT_DATA" }), true);
  assert.equal(shouldAnnounce({}), true);
  assert.equal(shouldAnnounce(null), true);
});

test("the capacity alarm is not described as a silent heartbeat", () => {
  const msg = formatMessage({ AlarmName: `${STACK}-no-instance`, NewStateValue: "ALARM", NewStateReason: "Threshold Crossed" });
  assert.ok(msg.includes("no instance in service"));
  assert.ok(!msg.includes("heartbeat"), "must not claim the heartbeat is silent");
  assert.ok(msg.includes("Threshold Crossed"), "must keep CloudWatch's own reason");
  assert.ok(msg.startsWith("🔴"));
});

test("the heartbeat keeps its own wording and its recovery hint", () => {
  const msg = formatMessage({ AlarmName: `${STACK}-heartbeat`, NewStateValue: "ALARM", NewStateReason: "Insufficient Data" });
  assert.ok(msg.includes("heartbeat went silent"));
  assert.ok(msg.includes("~2 min"));
});

test("an alarm nobody wrote a sentence for is still announced, with its reason", () => {
  const msg = formatMessage({ AlarmName: `${STACK}-something-new`, NewStateValue: "ALARM", NewStateReason: "Threshold Crossed" });
  assert.ok(msg.includes("something-new"));
  assert.ok(msg.includes("Threshold Crossed"));
});

test("recovery, unknown states and empty input stay short, named, and never crash", () => {
  const ok = formatMessage({ AlarmName: `${STACK}-no-instance`, NewStateValue: "OK" });
  assert.ok(ok.startsWith("🟢") && ok.includes("no-instance"));
  const unknown = formatMessage({ AlarmName: "x", NewStateValue: "UNKNOWN", NewStateReason: "raw" });
  assert.ok(unknown.startsWith("⚪️") && unknown.includes("raw"));
  assert.ok(formatMessage({}).includes("unknown alarm"));
  assert.ok(formatMessage(null).includes("unknown alarm"));
});
