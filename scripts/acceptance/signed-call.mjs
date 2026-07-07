// SigV4-signed call against the deployed Data API — the same signing shape the
// consumer Lambda will use (service "execute-api").
//   node scripts/acceptance/signed-call.mjs <dataApiUrl> <path> ['<json-body>']
// Credentials come from the default AWS chain (env/profile/SSO).
import { Sha256 } from "@aws-crypto/sha256-js";
import { defaultProvider } from "@aws-sdk/credential-provider-node";
import { HttpRequest } from "@smithy/protocol-http";
import { SignatureV4 } from "@smithy/signature-v4";

export async function signedCall(baseUrl, path, body, region = process.env.AWS_REGION ?? "eu-west-1") {
  const url = new URL(baseUrl);
  const payload = body === undefined ? "" : JSON.stringify(body);
  const request = new HttpRequest({
    method: body === undefined ? "GET" : "POST",
    protocol: url.protocol,
    hostname: url.hostname,
    path,
    headers: {
      host: url.hostname,
      "content-type": "application/json",
    },
    body: payload || undefined,
  });
  const signer = new SignatureV4({
    service: "execute-api",
    region,
    credentials: defaultProvider(),
    sha256: Sha256,
  });
  const signed = await signer.sign(request);
  const res = await fetch(`${url.origin}${path}`, {
    method: signed.method,
    headers: signed.headers,
    body: signed.body,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

// CLI mode
const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop() ?? "");
if (isMain) {
  const [, , baseUrl, path, rawBody] = process.argv;
  if (!baseUrl || !path) {
    console.error("usage: signed-call.mjs <dataApiUrl> <path> ['<json-body>']");
    process.exit(2);
  }
  const body = rawBody === undefined ? undefined : JSON.parse(rawBody);
  const result = await signedCall(baseUrl, path, body);
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.status < 400 ? 0 : 1);
}
