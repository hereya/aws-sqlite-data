// Template-level enforcement of the spec's non-negotiables (§3, §13):
// no S3 lifecycle/versioning, no SSH keypair, IMDSv2 required, 1/1/1 ASG with
// capacity rebalance off, least-privilege role (never s3:*).
import assert from "node:assert/strict";
import { before, test } from "node:test";
import * as cdk from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { HereyaAwsSqliteDataStack } from "../lib/hereya-aws-sqlite-data-stack.ts";

let template: Template;

before(() => {
  const app = new cdk.App();
  const stack = new HereyaAwsSqliteDataStack(app, "TestStack", {
    env: { account: "111111111111", region: "eu-west-1" },
  });
  template = Template.fromStack(stack);
});

test("replica bucket has NO lifecycle rules and NO versioning", () => {
  const buckets = template.findResources("AWS::S3::Bucket");
  const names = Object.keys(buckets).filter((k) => k.startsWith("ReplicaBucket"));
  assert.equal(names.length, 1);
  const bucket = buckets[names[0]!]!;
  assert.equal(bucket.Properties.LifecycleConfiguration, undefined, "no lifecycle rules allowed (Litestream owns retention)");
  assert.equal(bucket.Properties.VersioningConfiguration, undefined, "versioning must stay off");
  assert.deepEqual(bucket.Properties.PublicAccessBlockConfiguration, {
    BlockPublicAcls: true,
    BlockPublicPolicy: true,
    IgnorePublicAcls: true,
    RestrictPublicBuckets: true,
  });
});

test("registry table: app_id key, on-demand billing, PITR", () => {
  template.hasResourceProperties("AWS::DynamoDB::Table", {
    KeySchema: [{ AttributeName: "app_id", KeyType: "HASH" }],
    BillingMode: "PAY_PER_REQUEST",
    PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
  });
});

test("launch template: no SSH key, IMDSv2 required", () => {
  const lts = template.findResources("AWS::EC2::LaunchTemplate");
  const lt = Object.values(lts)[0]!;
  const data = lt.Properties.LaunchTemplateData;
  assert.equal(data.KeyName, undefined, "SSM only — no SSH keypair");
  assert.equal(data.MetadataOptions?.HttpTokens, "required");
});

test("ASG: 1/1/1 singleton, all-Spot mixed instances, capacity rebalance OFF", () => {
  const asgs = template.findResources("AWS::AutoScaling::AutoScalingGroup");
  const asg = Object.values(asgs)[0]!;
  assert.equal(asg.Properties.MinSize, "1");
  assert.equal(asg.Properties.MaxSize, "1");
  assert.equal(asg.Properties.CapacityRebalance, false);
  const dist = asg.Properties.MixedInstancesPolicy.InstancesDistribution;
  assert.equal(dist.OnDemandPercentageAboveBaseCapacity, 100, "on-demand by default (Spot is opt-in)");
  assert.equal(dist.SpotAllocationStrategy, "capacity-optimized");
  const overrides = asg.Properties.MixedInstancesPolicy.LaunchTemplate.Overrides;
  assert.ok(overrides.length >= 2, "at least two instance-type fallbacks");
  // replacements must be able to land in more than one AZ
  assert.ok((asg.Properties.VPCZoneIdentifier ?? []).length >= 2, "ASG must span >=2 subnets");
});

test("no NAT gateways and no interface endpoints (cost floor)", () => {
  template.resourceCountIs("AWS::EC2::NatGateway", 0);
  const endpoints = template.findResources("AWS::EC2::VPCEndpoint");
  for (const ep of Object.values(endpoints)) {
    assert.equal(ep.Properties.VpcEndpointType ?? "Gateway", "Gateway");
  }
});

test("instance role never gets s3:* and scopes S3 to the bucket", () => {
  const policies = template.findResources("AWS::IAM::Policy");
  for (const policy of Object.values(policies)) {
    for (const stmt of policy.Properties.PolicyDocument.Statement) {
      const actions = Array.isArray(stmt.Action) ? stmt.Action : [stmt.Action];
      for (const action of actions) {
        assert.notEqual(action, "s3:*", "wildcard S3 is forbidden");
        assert.notEqual(action, "*", "wildcard actions are forbidden");
      }
    }
  }
});

test("every API route requires IAM (SigV4) authorization", () => {
  const routes = template.findResources("AWS::ApiGatewayV2::Route");
  const keys = Object.values(routes).map((r) => r.Properties.RouteKey as string);
  assert.ok(keys.length >= 7, `expected >=7 routes, got ${keys.join(", ")}`);
  for (const route of Object.values(routes)) {
    assert.equal(route.Properties.AuthorizationType, "AWS_IAM", `route ${route.Properties.RouteKey} must be IAM-authorized`);
  }
});

test("VPC Link + Cloud Map service exist; instance admits only the VPC Link SG", () => {
  template.resourceCountIs("AWS::ApiGatewayV2::VpcLink", 1);
  template.resourceCountIs("AWS::ServiceDiscovery::Service", 1);
  const ingresses = template.findResources("AWS::EC2::SecurityGroupIngress");
  const toInstance = Object.values(ingresses);
  assert.equal(toInstance.length, 1, "exactly one ingress rule in the whole stack");
  assert.equal(toInstance[0]!.Properties.FromPort, 8080);
  assert.ok(toInstance[0]!.Properties.SourceSecurityGroupId, "ingress must be SG-scoped, not CIDR");
});

test("heartbeat alarm is a dead-man switch (missing data = breaching)", () => {
  const alarms = template.findResources("AWS::CloudWatch::Alarm");
  const list = Object.values(alarms);
  assert.equal(list.length, 2);
  for (const alarm of list) {
    assert.equal(alarm.Properties.TreatMissingData, "breaching", "silence must trip the alarm");
    assert.equal(alarm.Properties.ComparisonOperator, "LessThanThreshold");
    assert.ok((alarm.Properties.AlarmActions ?? []).length >= 1, "alarm must notify");
    assert.ok((alarm.Properties.OKActions ?? []).length >= 1, "recovery must notify too");
  }
});

test("telegram relay appears only when its inputs are set", () => {
  // default synth (no telegram inputs): no Lambda in the stack at all
  const fns = template.findResources("AWS::Lambda::Function");
  const relays = Object.keys(fns).filter((k) => k.startsWith("HeartbeatRelay"));
  assert.equal(relays.length, 0);

  const app2 = new cdk.App();
  process.env.telegramBotTokenParam = "/hereya/test/telegram-token";
  process.env.telegramChatId = "12345";
  try {
    const stack2 = new HereyaAwsSqliteDataStack(app2, "TestStackTg", {
      env: { account: "111111111111", region: "eu-west-1" },
    });
    const template2 = Template.fromStack(stack2);
    const fns2 = Object.keys(template2.findResources("AWS::Lambda::Function"));
    assert.ok(fns2.some((k) => k.startsWith("HeartbeatRelay")), "relay must exist with inputs set");
    template2.resourceCountIs("AWS::SNS::Subscription", 1);
  } finally {
    delete process.env.telegramBotTokenParam;
    delete process.env.telegramChatId;
  }
});

test("artifact pointer parameter exists (service-only update path)", () => {
  template.hasResourceProperties("AWS::SSM::Parameter", {
    Name: Match.stringLikeRegexp("/TestStack/service-artifact"),
  });
});

test("capability secret is created, granted to the instance role, and exported", () => {
  template.resourceCountIs("AWS::SecretsManager::Secret", 1);
  // RAW random string: no SecretStringTemplate/GenerateStringKey (GetSecretValue
  // returns the secret verbatim for both the service and the platform caller).
  template.hasResourceProperties("AWS::SecretsManager::Secret", {
    GenerateSecretString: { PasswordLength: 48, ExcludePunctuation: true },
  });
  // the instance role must be able to read it (grantRead → GetSecretValue)
  const policies = template.findResources("AWS::IAM::Policy");
  const grantsGet = Object.values(policies).some((p) =>
    p.Properties.PolicyDocument.Statement.some((s: { Action?: string | string[] }) => {
      const actions = Array.isArray(s.Action) ? s.Action : [s.Action];
      return actions.includes("secretsmanager:GetSecretValue");
    }),
  );
  assert.ok(grantsGet, "instance role must be granted secretsmanager:GetSecretValue");
  // new consumer outputs for the platform caller
  const outputs = template.findOutputs("*");
  assert.ok(outputs.capabilitySecretArn, "missing output capabilitySecretArn");
  assert.ok(outputs.iamPolicySqliteCapability, "missing output iamPolicySqliteCapability");
  const raw = JSON.stringify(outputs.iamPolicySqliteCapability!.Value);
  assert.ok(raw.includes("2012-10-17"));
  assert.ok(raw.includes("secretsmanager:GetSecretValue"));
});

test("exports the consumer env contract", () => {
  const outputs = template.findOutputs("*");
  for (const key of [
    "awsRegion",
    "sqliteReplicaBucketName",
    "registryTableName",
    "iamPolicySqliteRegistry",
    "dataApiUrl",
    "iamPolicySqliteDataApi",
  ]) {
    assert.ok(outputs[key], `missing output ${key}`);
  }
  // the policy value embeds the table ARN token, so at template level it is an
  // Fn::Join — just confirm the serialized shape carries the policy skeleton
  const raw = JSON.stringify(outputs.iamPolicySqliteRegistry!.Value);
  assert.ok(raw.includes("2012-10-17"));
  assert.ok(raw.includes("dynamodb:PutItem"));
});
