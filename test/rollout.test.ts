// What may replace the database VM, and how (CLAUDE.md invariants 5, 8, 9).
// Backported from upstream dilaya/aws-sqlite-data 0.1.8–0.1.11 and 0.1.30.
//
// Terminate-before-launch is the only update order compatible with ONE
// litestream writer per replica path; the service hash in user-data makes a
// new service actually roll; the AMI pin keeps AWS's publication calendar from
// rolling it on an unrelated deploy.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { before, test } from "node:test";
import { Template } from "aws-cdk-lib/assertions";
import { PINNED_AMI_ID } from "../lib/ami-pin.ts";
import { synthStack as stackIn } from "./synth-helpers.ts";

let template: Template;

const launchTemplateData = (t: Template) =>
  Object.values(t.findResources("AWS::EC2::LaunchTemplate"))[0]!.Properties.LaunchTemplateData;

before(() => {
  template = Template.fromStack(stackIn("TestStackRollout"));
});

test("ASG update policy: rolling update, terminate-before-launch (single litestream writer)", () => {
  const asg = Object.values(template.findResources("AWS::AutoScaling::AutoScalingGroup"))[0]!;
  const rolling = asg.UpdatePolicy?.AutoScalingRollingUpdate;
  assert.ok(rolling, "must use AutoScalingRollingUpdate (replacingUpdate runs old+new side by side)");
  assert.equal(rolling.MinInstancesInService, 0, "old instance must terminate BEFORE the new one launches");
  assert.equal(rolling.MaxBatchSize, 1);
  assert.equal(asg.UpdatePolicy?.AutoScalingReplacingUpdate, undefined);
});

const hashLine = (t: Template): string | undefined =>
  /service-artifact-hash: ([0-9a-f]{64})/.exec(JSON.stringify(launchTemplateData(t).UserData))?.[1];

test("user-data embeds the service hash, and a rebuild of the same sources keeps it", () => {
  const first = hashLine(template);
  assert.ok(first, "the artifact hash line must be in user-data (a new service must roll the instance)");
  // A second, independent synth (new App, fresh bundling) of identical
  // sources: with the old AssetHashType.OUTPUT the non-reproducible tarball
  // gave a new hash here — i.e. a VM replacement on every deploy of anything.
  // The input-hash properties themselves are pinned in service-hash.test.ts.
  assert.equal(hashLine(Template.fromStack(stackIn("TestStackRebuild"))), first);
});

test("launch template pins a literal AMI id — no latest-AL2023 lookup", () => {
  const imageId = launchTemplateData(template).ImageId;
  assert.equal(typeof imageId, "string", "ImageId must be a literal ami-… (an SSM Ref re-resolves every deploy)");
  assert.equal(imageId, PINNED_AMI_ID);
  const params = template.toJSON().Parameters ?? {};
  for (const [name, def] of Object.entries(params as Record<string, { Type?: string }>)) {
    assert.ok(!String(def.Type ?? "").includes("AWS::EC2::Image::Id"), `parameter ${name} resolves an AMI at deploy time`);
  }
});

test("amiId=latest is the explicit opt-out (back to deploy-time resolution)", () => {
  process.env.amiId = "latest";
  try {
    const imageId = launchTemplateData(Template.fromStack(stackIn("TestStackAmiLatest"))).ImageId;
    assert.equal(typeof imageId, "object", "'latest' must render a Ref to an SSM AMI parameter");
  } finally {
    delete process.env.amiId;
  }
});

test("an explicit amiId wins over the pin", () => {
  process.env.amiId = "ami-0123456789abcdef0";
  try {
    assert.equal(launchTemplateData(Template.fromStack(stackIn("TestStackAmiExplicit"))).ImageId, "ami-0123456789abcdef0");
  } finally {
    delete process.env.amiId;
  }
});

test("a bogus amiId fails at synth, not at instance launch", () => {
  process.env.amiId = "ami_not_an_id";
  try {
    assert.throws(() => stackIn("TestStackAmiBogus"), /amiId must be an AMI id/);
  } finally {
    delete process.env.amiId;
  }
});

test("the pinned default is refused outside its region (AMI ids are region-scoped)", () => {
  assert.throws(() => stackIn("TestStackAmiRegion", "eu-central-1"), /does not exist in eu-central-1/);
});

test("the hereyarc amiId default IS the pin — they cannot drift apart", () => {
  // Hereya passes a parameter's default as the env var, which overrides the
  // constant. A pin bumped in lib/ami-pin.ts but not here would silently keep
  // deploying the old image (and the reverse would roll an unreviewed one).
  const rc = readFileSync(new URL("../hereyarc.yaml", import.meta.url), "utf8");
  const block = rc.slice(rc.indexOf("\n  amiId:"));
  const m = /\n    default: "([^"]+)"/.exec(block);
  assert.ok(m, "hereyarc.yaml must declare amiId with a default");
  assert.equal(m[1], PINNED_AMI_ID);
});

test("the Data API stage writes an access log that says WHICH call failed and WHY", () => {
  const stages = Object.values(template.findResources("AWS::ApiGatewayV2::Stage"));
  assert.equal(stages.length, 1, "exactly one (default) stage");
  const settings = stages[0]!.Properties.AccessLogSettings;
  assert.ok(settings?.DestinationArn, "the stage MUST have access log settings with a destination");
  const format = JSON.parse(settings.Format as string);
  for (const field of ["requestId", "routeKey", "status", "integrationStatus", "integrationErrorMessage", "sourceIp"]) {
    assert.ok(format[field], `access log format must carry ${field}`);
  }
  const logicalId = (settings.DestinationArn["Fn::GetAtt"] as [string, string])[0];
  const group = template.findResources("AWS::Logs::LogGroup")[logicalId];
  assert.ok(group, `access log destination ${logicalId} must be a log group in this stack`);
  assert.equal(group.Properties.RetentionInDays, 7);
  assert.equal(group.DeletionPolicy, "Delete");
});

test("the root volume is stated: /dev/xvda, encrypted with aws/ebs, gp3 — never a second volume", () => {
  const bdm = launchTemplateData(template).BlockDeviceMappings;
  assert.equal(bdm.length, 1, "exactly one mapping — a second one would ADD a volume, not replace the root");
  assert.equal(bdm[0].DeviceName, "/dev/xvda");
  assert.equal(bdm[0].Ebs.Encrypted, true);
  assert.equal(bdm[0].Ebs.VolumeType, "gp3");
  assert.equal(bdm[0].Ebs.KmsKeyId, undefined, "aws/ebs (AWS-managed) on purpose — a CMK needs an ASG grant");
});
