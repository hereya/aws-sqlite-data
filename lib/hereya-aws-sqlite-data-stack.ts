import * as cdk from "aws-cdk-lib";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import { HttpIamAuthorizer } from "aws-cdk-lib/aws-apigatewayv2-authorizers";
import { HttpServiceDiscoveryIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as autoscaling from "aws-cdk-lib/aws-autoscaling";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as cwActions from "aws-cdk-lib/aws-cloudwatch-actions";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3assets from "aws-cdk-lib/aws-s3-assets";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as servicediscovery from "aws-cdk-lib/aws-servicediscovery";
import * as sns from "aws-cdk-lib/aws-sns";
import * as snsSubs from "aws-cdk-lib/aws-sns-subscriptions";
import * as ssm from "aws-cdk-lib/aws-ssm";
import type { Construct } from "constructs";
import { execSync } from "node:child_process";
import { cpSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { addAccessLog } from "./access-log.ts";
import { PINNED_AMI_ID } from "./ami-pin.ts";
import { resolveMachineImage } from "./machine-image.ts";
import { serviceContentHash } from "./service-hash.ts";
import { buildUserData } from "./user-data.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

// Hereya package inputs arrive as plain env vars (camelCase).
function input(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
}

export class HereyaAwsSqliteDataStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const autoDelete = input("autoDelete", "false") === "true";
    const instanceType = input("instanceType", "t4g.micro");
    const servicePort = Number(input("servicePort", "8080"));
    const removalPolicy = autoDelete ? cdk.RemovalPolicy.DESTROY : cdk.RemovalPolicy.RETAIN;

    // --- S3: durable source of truth ----------------------------------------
    // NO lifecycle rules and NO versioning — Litestream owns retention (spec §3);
    // an independent S3 rule can break its generation chain.
    const bucket = new s3.Bucket(this, "ReplicaBucket", {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      versioned: false,
      removalPolicy,
      autoDeleteObjects: autoDelete,
    });

    // --- DynamoDB: app registry (runtime app lifecycle, spec §7) ------------
    // One row per app: PK app_id, attributes {status, name, createdAt}
    const table = new dynamodb.Table(this, "RegistryTable", {
      partitionKey: { name: "app_id", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy,
    });

    // --- Network: minimal VPC, public subnets, zero public ingress ----------
    // No NAT ($32/mo) and no interface endpoints (~$7/mo each): the instance
    // gets a public IP for outbound (SSM/CloudWatch are agent-initiated), and
    // the heavy S3/DDB traffic rides free gateway endpoints.
    const vpc = new ec2.Vpc(this, "Vpc", {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [{ name: "public", subnetType: ec2.SubnetType.PUBLIC }],
    });
    vpc.addGatewayEndpoint("S3Endpoint", { service: ec2.GatewayVpcEndpointAwsService.S3 });
    vpc.addGatewayEndpoint("DdbEndpoint", { service: ec2.GatewayVpcEndpointAwsService.DYNAMODB });

    const instanceSg = new ec2.SecurityGroup(this, "InstanceSg", {
      vpc,
      description: "Hereya SQLite Data API instance - no public ingress; API GW VPC Link only",
      allowAllOutbound: true,
    });

    // --- Discovery + API Gateway (IAM/SigV4) ---------------------------------
    // Cloud Map + VPC Link v2 is the no-load-balancer private integration:
    // the singleton registers its own IP; API GW discovers it. The instance SG
    // only ever admits the VPC Link's SG on the service port.
    const vpcLinkSg = new ec2.SecurityGroup(this, "VpcLinkSg", {
      vpc,
      description: "API Gateway VPC Link to Data API instance",
      allowAllOutbound: true,
    });
    instanceSg.addIngressRule(vpcLinkSg, ec2.Port.tcp(servicePort), "API GW VPC Link only");

    const namespace = new servicediscovery.PrivateDnsNamespace(this, "Namespace", {
      name: `${this.stackName}.hereya.internal`.toLowerCase(),
      vpc,
    });
    // No Cloud Map health check: the deregister-all-then-register-self protocol
    // plus the ASG singleton guarantee at most one (live) registration.
    const discoveryService = namespace.createService("DataApiService", {
      dnsRecordType: servicediscovery.DnsRecordType.SRV,
      dnsTtl: cdk.Duration.seconds(10),
    });

    const vpcLink = new apigwv2.VpcLink(this, "VpcLink", {
      vpc,
      subnets: { subnetType: ec2.SubnetType.PUBLIC },
      securityGroups: [vpcLinkSg],
    });

    const httpApi = new apigwv2.HttpApi(this, "HttpApi", {
      apiName: `${this.stackName}-sqlite-data`,
      defaultAuthorizer: new HttpIamAuthorizer(),
    });
    const integration = new HttpServiceDiscoveryIntegration("DataApi", discoveryService, { vpcLink });
    for (const [method, path] of [
      [apigwv2.HttpMethod.POST, "/query"],
      [apigwv2.HttpMethod.POST, "/batch-execute"],
      [apigwv2.HttpMethod.POST, "/tx/begin"],
      [apigwv2.HttpMethod.POST, "/tx/commit"],
      [apigwv2.HttpMethod.POST, "/tx/rollback"],
      [apigwv2.HttpMethod.POST, "/admin/sync"],
      [apigwv2.HttpMethod.POST, "/admin/delete-app"],
      [apigwv2.HttpMethod.GET, "/stats"],
      [apigwv2.HttpMethod.GET, "/health"],
    ] as const) {
      httpApi.addRoutes({ path, methods: [method], integration });
    }
    addAccessLog(this, httpApi);

    // --- Service artifact ----------------------------------------------------
    const artifact = new s3assets.Asset(this, "ServiceArtifact", {
      path: join(repoRoot, "service"),
      // Hash the service INPUTS, never the built tarball (CLAUDE.md inv. 8). The
      // hash rides in the launch template, so it decides when CloudFormation
      // replaces the database VM — and a hash of the non-reproducible
      // service.tar.gz (builtAt + tar/gzip mtimes) would roll it on every
      // deploy of anything. See lib/service-hash.ts.
      assetHash: serviceContentHash(repoRoot),
      assetHashType: cdk.AssetHashType.CUSTOM,
      bundling: {
        image: cdk.DockerImage.fromRegistry("public.ecr.aws/docker/library/node:24"),
        local: {
          tryBundle(outputDir: string): boolean {
            execSync(`node ${join(repoRoot, "scripts", "build-service.mjs")}`, { stdio: "inherit" });
            const built = join(repoRoot, "dist", "service.tar.gz");
            if (!existsSync(built)) throw new Error("build-service.mjs produced no artifact");
            cpSync(built, join(outputDir, "service.tar.gz"));
            return true;
          },
        },
      },
    });

    // The pointer parameter is what makes service-only updates possible without
    // CDK churn: upload a new tar.gz, update the parameter, restart the service.
    const artifactParam = new ssm.StringParameter(this, "ServiceArtifactParam", {
      parameterName: `/${this.stackName}/service-artifact`,
      stringValue: artifact.s3ObjectUrl,
    });

    // --- Instance role: least privilege --------------------------------------
    const role = new iam.Role(this, "InstanceRole", {
      assumedBy: new iam.ServicePrincipal("ec2.amazonaws.com"),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName("AmazonSSMManagedInstanceCore")],
    });
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "LitestreamReplicaAccess",
        actions: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
        resources: [bucket.arnForObjects("*")],
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "LitestreamReplicaList",
        // GetBucketLocation: litestream resolves the bucket region before restore
        actions: ["s3:ListBucket", "s3:GetBucketLocation"],
        resources: [bucket.bucketArn],
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "RegistryRead",
        actions: ["dynamodb:GetItem", "dynamodb:Query", "dynamodb:Scan"],
        resources: [table.tableArn],
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "Heartbeat",
        actions: ["cloudwatch:PutMetricData"],
        resources: ["*"],
        conditions: { StringEquals: { "cloudwatch:namespace": "Hereya/SqliteData" } },
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "ArtifactPointer",
        actions: ["ssm:GetParameter"],
        resources: [artifactParam.parameterArn],
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "CloudMapSelfRegistration",
        actions: [
          "servicediscovery:RegisterInstance",
          "servicediscovery:DeregisterInstance",
          "servicediscovery:ListInstances",
        ],
        resources: [discoveryService.serviceArn],
      }),
    );
    // Cloud Map manages the Route53 records of the private DNS namespace on the
    // caller's behalf during (de)registration (cf. AWSCloudMapRegisterInstanceAccess).
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "CloudMapRoute53",
        actions: ["route53:ChangeResourceRecordSets", "route53:GetHostedZone"],
        resources: ["arn:aws:route53:::hostedzone/*"],
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "CloudMapRoute53List",
        actions: ["route53:ListHostedZonesByName"],
        resources: ["*"],
      }),
    );
    artifact.grantRead(role);

    // --- Capability token secret (spec §6 caller-binding) --------------------
    // The platform caller mints per-request HMAC capability tokens with this secret;
    // the VM re-derives the HMAC and checks the token's (org, app) matches the
    // request. RAW random string — no SecretStringTemplate/GenerateStringKey —
    // so GetSecretValue returns the secret verbatim (both the service and the
    // callers read SecretString as-is, not a JSON key).
    const capabilitySecret = new secretsmanager.Secret(this, "CapabilitySecret", {
      description: "Hereya SQLite Data API capability-token HMAC secret (shared with provisioning packages)",
      generateSecretString: {
        passwordLength: 48,
        excludePunctuation: true,
      },
      removalPolicy,
    });
    // The instance role reads the secret at boot to verify incoming tokens.
    capabilitySecret.grantRead(role);

    // --- Launch template + self-healing Spot singleton ----------------------
    const userData = ec2.UserData.custom(
      buildUserData({
        awsRegion: this.region,
        artifactParamName: artifactParam.parameterName,
        artifactHash: artifact.assetHash,
        serviceEnv: {
          NODE_ENV: "production",
          PORT: String(servicePort),
          DB_DIR: "/var/lib/hereya/dbs",
          AWS_REGION: this.region,
          REGISTRY_MODE: "ddb",
          REGISTRY_TABLE: table.tableName,
          REPLICA_BASE_URL: `s3://${bucket.bucketName}`,
          LITESTREAM_BIN: "/usr/local/bin/litestream",
          LITESTREAM_CONFIG_PATH: "/etc/hereya/litestream.yml",
          SQL_TIMEOUT_MS: input("sqlTimeoutMs", "20000"),
          MAX_INFLIGHT_PER_APP: input("maxInflightPerApp", "16"),
          MAX_LIVE_WORKERS: input("maxLiveWorkers", "8"),
          REGISTRY_POLL_SECONDS: input("registryPollSeconds", "30"),
          LITESTREAM_SYNC_INTERVAL_MS: input("litestreamSyncIntervalMs", "1000"),
          LITESTREAM_RETENTION: input("litestreamRetention", "72h"),
          HEARTBEAT_ENABLED: "1",
          HEARTBEAT_DIMENSION: this.stackName,
          IMDS_ENABLED: "1",
          CLOUDMAP_SERVICE_ID: discoveryService.serviceId,
          // Capability-token validation: the service fetches the secret by ARN
          // at boot. Enforcement defaults OFF (rollout-compat window) — flip via
          // the capabilityEnforce input once every caller holds tokens.
          CAPABILITY_SECRET_ARN: capabilitySecret.secretArn,
          CAPABILITY_ENFORCE: input("capabilityEnforce", "false"),
        },
      }),
    );

    const launchTemplate = new ec2.LaunchTemplate(this, "LaunchTemplate", {
      // PINNED, not a latest-AL2023 lookup (CLAUDE.md inv. 9): a lookup
      // re-resolves at every deploy and rolls the VM when AWS publishes.
      machineImage: resolveMachineImage(this, input("amiId", PINNED_AMI_ID).trim()),
      instanceType: new ec2.InstanceType(instanceType),
      role,
      securityGroup: instanceSg,
      userData,
      requireImdsv2: true,
      associatePublicIpAddress: true,
      // The root volume, STATED instead of inherited from the AMI (upstream
      // 0.1.30/0.1.31). The device name MUST be the AMI's own root device
      // (`/dev/xvda` on AL2023 arm64): any other name ADDS a second volume
      // and the databases stay on the old, unencrypted root.
      //
      // Encrypted at rest with the account's AWS-managed `aws/ebs` key
      // (kmsKey left unset on purpose): its key policy already lets the Auto
      // Scaling service-linked role launch from it, where a customer-managed
      // key would need an explicit grant and fail every launch without one.
      // The S3 replica was always encrypted; now the original is too.
      // 8 GB = the size the AMI already gave it (the data is small).
      blockDevices: [
        {
          deviceName: "/dev/xvda",
          volume: ec2.BlockDeviceVolume.ebs(8, {
            volumeType: ec2.EbsDeviceVolumeType.GP3,
            deleteOnTermination: true,
            encrypted: true,
          }),
        },
      ],
      // Spot-ness lives in the ASG's MixedInstancesPolicy below (a launch
      // template with InstanceMarketOptions conflicts with mixed instances).
      // no keyPair: SSM Session Manager only (spec §3)
    });

    // Still a singleton (one instance at a time — no litestream dual-writer),
    // but replacements may land in EITHER public subnet and on either size.
    // Purchasing default is ON-DEMAND: observed reality (eu-west-1, t4g) is
    // that Spot can be unfulfillable across AZs and sizes for extended periods,
    // which turns the spec's ~2-min recovery into an open-ended outage. Spot
    // remains an explicit opt-in via spotPercentage (0-100).
    const spotPercentage = Math.min(100, Math.max(0, Number(input("spotPercentage", "0")) || 0));
    const asg = new autoscaling.AutoScalingGroup(this, "Asg", {
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      mixedInstancesPolicy: {
        launchTemplate,
        launchTemplateOverrides: [
          { instanceType: new ec2.InstanceType(instanceType) },
          { instanceType: new ec2.InstanceType(input("fallbackInstanceType", "t4g.small")) },
        ],
        instancesDistribution: {
          onDemandPercentageAboveBaseCapacity: 100 - spotPercentage,
          spotAllocationStrategy: autoscaling.SpotAllocationStrategy.CAPACITY_OPTIMIZED,
        },
      },
      minCapacity: 1,
      maxCapacity: 1,
      // Rolling update with minInstancesInService=0 = TERMINATE-BEFORE-LAUNCH:
      // CloudFormation kills the old instance, then brings up the new one — the
      // same sequence as the tested kill-instance recovery (~1 min gap), and the
      // only order compatible with the litestream single-writer invariant. Do
      // NOT switch back to replacingUpdate(): it runs old and new side by side
      // on one replica path. What rolls the instance is therefore, by design,
      // exactly two deliberate changes: a new SERVICE (the source hash in
      // user-data) and a bumped AMI pin.
      updatePolicy: autoscaling.UpdatePolicy.rollingUpdate({
        maxBatchSize: 1,
        minInstancesInService: 0,
        pauseTime: cdk.Duration.seconds(0),
        waitOnResourceSignals: false,
      }),
      groupMetrics: [autoscaling.GroupMetrics.all()],
    });
    // Capacity rebalance must stay OFF: it launches the replacement while the
    // old instance is alive → two litestream writers on one generation path.
    (asg.node.defaultChild as autoscaling.CfnAutoScalingGroup).capacityRebalance = false;

    // --- Heartbeat dead-man switch + Telegram relay (spec §3, « le silence est
    // interdit ») ------------------------------------------------------------
    const alertTopic = new sns.Topic(this, "AlertTopic");

    const heartbeatAlarm = new cloudwatch.Alarm(this, "HeartbeatAlarm", {
      alarmName: `${this.stackName}-heartbeat`,
      alarmDescription:
        "Hereya SQLite Data API heartbeat is silent (instance dead, service wedged, replication down, or network cut)",
      metric: new cloudwatch.Metric({
        namespace: "Hereya/SqliteData",
        metricName: "Heartbeat",
        dimensionsMap: { stack: this.stackName },
        statistic: "Sum",
        period: cdk.Duration.minutes(1),
      }),
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      threshold: 1,
      evaluationPeriods: 5,
      datapointsToAlarm: 3,
      treatMissingData: cloudwatch.TreatMissingData.BREACHING,
    });
    heartbeatAlarm.addAlarmAction(new cwActions.SnsAction(alertTopic));
    heartbeatAlarm.addOkAction(new cwActions.SnsAction(alertTopic));

    const capacityAlarm = new cloudwatch.Alarm(this, "CapacityAlarm", {
      alarmName: `${this.stackName}-no-instance`,
      alarmDescription: "The Data API ASG has zero in-service instances",
      metric: new cloudwatch.Metric({
        namespace: "AWS/AutoScaling",
        metricName: "GroupInServiceInstances",
        dimensionsMap: { AutoScalingGroupName: asg.autoScalingGroupName },
        statistic: "Minimum",
        period: cdk.Duration.minutes(1),
      }),
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      threshold: 1,
      evaluationPeriods: 3,
      treatMissingData: cloudwatch.TreatMissingData.BREACHING,
    });
    capacityAlarm.addAlarmAction(new cwActions.SnsAction(alertTopic));
    capacityAlarm.addOkAction(new cwActions.SnsAction(alertTopic));

    // Telegram relay is wired only when the package inputs are provided; the
    // alarms exist regardless (visible in CloudWatch, other subscribers possible).
    const telegramTokenParam = input("telegramBotTokenParam", "");
    const telegramChatId = input("telegramChatId", "");
    if (telegramTokenParam !== "" && telegramChatId !== "") {
      const relay = new lambda.Function(this, "HeartbeatRelay", {
        runtime: lambda.Runtime.NODEJS_22_X,
        architecture: lambda.Architecture.ARM_64,
        handler: "index.handler",
        code: lambda.Code.fromAsset(join(repoRoot, "lib", "heartbeat-relay")),
        timeout: cdk.Duration.seconds(30),
        memorySize: 128,
        environment: {
          TELEGRAM_TOKEN_PARAM: telegramTokenParam,
          TELEGRAM_CHAT_ID: telegramChatId,
        },
      });
      relay.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ["ssm:GetParameter"],
          resources: [
            cdk.Arn.format(
              { service: "ssm", resource: "parameter", resourceName: telegramTokenParam.replace(/^\//, "") },
              this,
            ),
          ],
        }),
      );
      alertTopic.addSubscription(new snsSubs.LambdaSubscription(relay));
    }

    // --- Package outputs (consumer env contract) -----------------------------
    new cdk.CfnOutput(this, "awsRegion", { value: this.region });
    new cdk.CfnOutput(this, "sqliteReplicaBucketName", { value: bucket.bucketName });
    new cdk.CfnOutput(this, "registryTableName", { value: table.tableName });
    new cdk.CfnOutput(this, "iamPolicySqliteRegistry", {
      value: JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Action: [
              "dynamodb:GetItem",
              "dynamodb:PutItem",
              "dynamodb:UpdateItem",
              "dynamodb:DeleteItem",
              "dynamodb:Query",
            ],
            Resource: [table.tableArn],
          },
        ],
      }),
    });
    new cdk.CfnOutput(this, "dataApiUrl", { value: httpApi.apiEndpoint });
    new cdk.CfnOutput(this, "iamPolicySqliteDataApi", {
      value: JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Action: ["execute-api:Invoke"],
            Resource: [
              `arn:aws:execute-api:${this.region}:${this.account}:${httpApi.apiId}/*/*/*`,
            ],
          },
        ],
      }),
    });
    // The platform caller reads this secret to mint capability tokens; the iamPolicy*
    // output auto-attaches secretsmanager:GetSecretValue to the platform caller's role
    // (mirrors iamPolicySqliteRegistry / iamPolicySqliteDataApi wiring).
    new cdk.CfnOutput(this, "capabilitySecretArn", { value: capabilitySecret.secretArn });
    new cdk.CfnOutput(this, "iamPolicySqliteCapability", {
      value: JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Action: ["secretsmanager:GetSecretValue"],
            Resource: [capabilitySecret.secretArn],
          },
        ],
      }),
    });
  }
}
