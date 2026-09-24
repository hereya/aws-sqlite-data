// The Telegram wording of an alarm from this stack. Backported from upstream
// dilaya/aws-sqlite-data 0.1.17 (548ba20): the message used to state "the
// heartbeat went silent" for ANY alarm reaching the relay, so the capacity alarm
// (or any alarm added later) would have been announced with the wrong first
// sentence — at the one moment somebody is reading fast.
//
// Keyed by the SUFFIX of the alarm name, because the prefix is the stack name
// and changes per deployment. An unknown alarm is still announced, with its own
// CloudWatch reason as the body — a new alarm must never be silent just because
// nobody wrote a sentence for it here.
const EXPLANATIONS = [
  [
    "-heartbeat",
    "The heartbeat went silent (dead instance, stuck service, replication down or network cut). " +
      "The ASG replaces the instance if needed — recovery expected in ~2 min.",
  ],
  [
    "-no-instance",
    "The auto-scaling group has no instance in service: no app database is reachable.",
  ],
];

function explain(name) {
  const hit = EXPLANATIONS.find(([suffix]) => typeof name === "string" && name.endsWith(suffix));
  return hit ? hit[1] : "";
}

function formatMessage(alarm) {
  const name = (alarm && alarm.AlarmName) || "unknown alarm";
  const state = alarm && alarm.NewStateValue;
  const reason = (alarm && alarm.NewStateReason) || "";
  if (state === "ALARM") {
    const body = [explain(name), reason].filter(Boolean).join("\n\n");
    return `🔴 Hereya SQLite Data API — "${name}" is in ALARM.\n${body}`;
  }
  if (state === "OK") {
    return `🟢 Hereya SQLite Data API — "${name}" recovered.`;
  }
  return `⚪️ Hereya SQLite Data API — "${name}": ${state}.\n${reason}`;
}

module.exports = { formatMessage, explain };
