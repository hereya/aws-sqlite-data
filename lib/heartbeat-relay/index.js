// SNS → Telegram relay for this stack's alarms. Plain committed JS (same
// convention as other registry packages' inline Lambdas). The bot token stays
// in an SSM SecureString; only its NAME is configuration.
//
// "This stack's alarms", not "the heartbeat": the topic carries the heartbeat
// AND the capacity alarm, which is why the wording lives in format.js, the
// birth-OK guard in announce.js and the token parsing in token.js.
const { SSMClient, GetParameterCommand } = require("@aws-sdk/client-ssm");
const { tokenFrom } = require("./token.js");
const { shouldAnnounce } = require("./announce.js");
const { formatMessage } = require("./format.js");

const ssm = new SSMClient({});
let cachedToken = null;

async function botToken() {
  if (cachedToken) return cachedToken;
  const res = await ssm.send(
    new GetParameterCommand({ Name: process.env.TELEGRAM_TOKEN_PARAM, WithDecryption: true }),
  );
  cachedToken = tokenFrom(res.Parameter.Value);
  return cachedToken;
}

exports.handler = async (event) => {
  const chatId = process.env.TELEGRAM_CHAT_ID;
  const token = await botToken();
  for (const record of event.Records || []) {
    let alarm;
    try {
      alarm = JSON.parse(record.Sns.Message);
    } catch {
      alarm = { AlarmName: record.Sns.Subject, NewStateValue: "UNKNOWN", NewStateReason: record.Sns.Message };
    }
    if (!shouldAnnounce(alarm)) {
      // Logged, never silent: a suppressed message must still be auditable, or
      // this becomes the next thing that fails without anyone noticing.
      console.log(`suppressed birth-OK for ${alarm.AlarmName} (${alarm.OldStateValue} -> ${alarm.NewStateValue})`);
      continue;
    }
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: formatMessage(alarm) }),
    });
    if (!res.ok) {
      const body = await res.text();
      console.error(`telegram sendMessage failed: ${res.status} ${body}`);
      throw new Error(`telegram sendMessage failed: ${res.status}`);
    }
  }
  return { ok: true };
};
