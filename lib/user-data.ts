// User-data is deliberately thin: fetch the artifact, install runtime pieces,
// write env + systemd unit, start. The strict restore-then-serve boot order
// lives in the SERVICE (tested TypeScript), not in shell.
export interface UserDataParams {
  awsRegion: string;
  artifactParamName: string; // SSM parameter holding the artifact's S3 URI
  artifactHash: string; // content hash of the service INPUTS — see the comment in the script
  serviceEnv: Record<string, string>; // written to /etc/hereya/data-api.env
}

export function buildUserData(params: UserDataParams): string {
  const envFile = Object.entries(params.serviceEnv)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");

  return `#!/bin/bash
# service-artifact-hash: ${params.artifactHash}
# (inert, but load-bearing: a new service changes this line, which versions the
# launch template and makes the ASG's rolling update replace the instance - so a
# deploy actually rolls the service. Without it the SSM pointer updates and the
# running instance keeps serving the old artifact.)
set -euo pipefail
exec > >(tee /var/log/hereya-bootstrap.log) 2>&1
echo "hereya-data-api bootstrap starting"

# --- users & dirs -----------------------------------------------------------
id -u dataapi &>/dev/null || useradd --system --home-dir /opt/hereya --shell /sbin/nologin dataapi
mkdir -p /opt/hereya /var/lib/hereya/dbs /etc/hereya

# --- fetch artifact (pointer lives in SSM so service-only updates skip CDK) --
ARTIFACT_URI=""
for i in $(seq 1 30); do
  ARTIFACT_URI=$(aws ssm get-parameter --region ${params.awsRegion} --name "${params.artifactParamName}" --query Parameter.Value --output text) && break
  echo "ssm get-parameter attempt $i failed; retrying"; sleep 5
done
[ -n "$ARTIFACT_URI" ] || { echo "FATAL: could not resolve artifact URI"; exit 1; }

for i in $(seq 1 30); do
  aws s3 cp --region ${params.awsRegion} "$ARTIFACT_URI" /opt/hereya/service.tar.gz && break
  echo "s3 cp attempt $i failed; retrying"; sleep 5
done
[ -s /opt/hereya/service.tar.gz ] || { echo "FATAL: artifact download failed"; exit 1; }

rm -rf /opt/hereya/service && mkdir -p /opt/hereya/service
tar -xzf /opt/hereya/service.tar.gz -C /opt/hereya/service

# --- runtime pieces (bundled in the artifact — no external network at boot) --
rm -rf /opt/hereya/node && mkdir -p /opt/hereya/node
tar -xJf /opt/hereya/service/node.tar.xz -C /opt/hereya/node --strip-components=1
install -m 0755 /opt/hereya/service/bin/litestream /usr/local/bin/litestream

# --- service configuration ---------------------------------------------------
cat > /etc/hereya/data-api.env <<'ENVEOF'
${envFile}
ENVEOF

chown -R dataapi:dataapi /opt/hereya /var/lib/hereya /etc/hereya

# --- systemd unit: fast local restart net (before the ASG's slower one) ------
cat > /etc/systemd/system/hereya-data-api.service <<'UNITEOF'
[Unit]
Description=Hereya SQLite Data API
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=dataapi
EnvironmentFile=/etc/hereya/data-api.env
ExecStart=/opt/hereya/node/bin/node /opt/hereya/service/main.js
Restart=always
RestartSec=1
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
UNITEOF

systemctl daemon-reload
systemctl enable --now hereya-data-api.service
echo "hereya-data-api bootstrap complete"
`;
}
