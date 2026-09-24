// Whether an alarm transition is worth a Telegram message. Kept in its own
// module — like token.js — so it can be unit-tested without the AWS SDK.
// Backported from upstream dilaya/aws-sqlite-data 0.1.17 (548ba20).
//
// A recovery is only worth announcing if something actually broke. A BRAND-NEW
// alarm is born INSUFFICIENT_DATA and flips to OK the moment it has enough data
// to judge; with an OK action wired, that birth reads as "recovered" and every
// deploy that CREATES alarms sends one message per alarm (measured upstream:
// eleven messages in 62 seconds on 2026-08-08).
//
// So: announce ALARM always; announce OK only when it follows a real ALARM.
// Anything unrecognised is announced rather than swallowed — a puzzling message
// beats silence in a component whose whole job is to not be silent.
function shouldAnnounce(alarm) {
  if (!alarm || alarm.NewStateValue !== "OK") return true;
  return alarm.OldStateValue === "ALARM";
}

module.exports = { shouldAnnounce };
