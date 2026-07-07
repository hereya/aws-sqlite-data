import * as cdk from "aws-cdk-lib";
import { HereyaAwsSqliteDataStack } from "../lib/hereya-aws-sqlite-data-stack.ts";

const app = new cdk.App();
new HereyaAwsSqliteDataStack(app, process.env.STACK_NAME ?? "hereya-aws-sqlite-data-dev", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
