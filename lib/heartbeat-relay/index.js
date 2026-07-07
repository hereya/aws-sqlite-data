// SNS → Telegram relay for the heartbeat dead-man alarm. Plain committed JS
// (same convention as other registry packages' inline Lambdas). The bot token
// stays in an SSM SecureString; only its NAME is configuration.
const { SSMClient, GetParameterCommand } = require("@aws-sdk/client-ssm");

const ssm = new SSMClient({});
let cachedToken = null;

async function botToken() {
  if (cachedToken) return cachedToken;
  const res = await ssm.send(
    new GetParameterCommand({ Name: process.env.TELEGRAM_TOKEN_PARAM, WithDecryption: true }),
  );
  cachedToken = res.Parameter.Value;
  return cachedToken;
}

function formatMessage(alarm) {
  const name = alarm.AlarmName || "unknown alarm";
  const state = alarm.NewStateValue;
  const reason = alarm.NewStateReason || "";
  if (state === "ALARM") {
    return (
      `🔴 Hereya SQLite Data API — "${name}" is in ALARM.\n` +
      `The heartbeat went silent (dead instance, stuck service, replication down or network cut). ` +
      `The ASG replaces the instance if needed — recovery expected in ~2 min.\n\n${reason}`
    );
  }
  if (state === "OK") {
    return `🟢 Hereya SQLite Data API — "${name}" recovered. The heartbeat is back.`;
  }
  return `⚪️ Hereya SQLite Data API — "${name}": ${state}.\n${reason}`;
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
