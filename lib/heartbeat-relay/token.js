// Extracting the bot token from whatever the SSM parameter holds. Kept in its
// own module so it can be unit-tested without loading the AWS SDK (which the
// Lambda runtime provides but this repo does not depend on). Backported from
// upstream dilaya/aws-sqlite-data (cbaeb7c).
//
// Two shapes reach it:
//   - a JSON credentials record, `{"bot_token":…,"secret_token":…}` — the shape
//     a Telegram-integrated app typically stores; pointing the relay at that
//     existing record lets an alarm reuse an app's bot with no second copy of
//     the secret to keep in sync;
//   - a bare token, for a parameter dedicated to alerting.
function tokenFrom(value) {
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed.bot_token === "string") return parsed.bot_token;
  } catch {
    // not JSON — a bare token
  }
  // Anything unexpected passes through: an alarm-time crash would lose the very
  // alert we are here to deliver. A wrong token still reaches Telegram, which
  // rejects it loudly and visibly in the relay's logs.
  return value;
}

module.exports = { tokenFrom };
