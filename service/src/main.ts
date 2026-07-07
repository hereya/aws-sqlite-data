import { loadConfig, resolveCapabilitySecret } from "./config.ts";
import { bootService } from "./boot.ts";

process.on("unhandledRejection", (reason) => {
  console.error(JSON.stringify({ type: "error", message: `unhandled rejection: ${String(reason)}` }));
});

try {
  const cfg = loadConfig();
  // Async secret fetch (Secrets Manager) folded into the boot path, before the
  // HTTP port binds — an unreadable secret under enforcement aborts the boot.
  cfg.capabilitySecret = await resolveCapabilitySecret(cfg);
  await bootService(cfg);
} catch (err) {
  // Fail-closed boot: a partial restore must never serve. systemd restarts us;
  // sustained failure silences the heartbeat and trips the Telegram alarm.
  console.error(JSON.stringify({ type: "boot-failed", message: (err as Error).message }));
  process.exit(1);
}
