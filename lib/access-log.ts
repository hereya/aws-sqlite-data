import * as cdk from "aws-cdk-lib";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as logs from "aws-cdk-lib/aws-logs";
import type { Construct } from "constructs";

/**
 * Access log on the Data API's default stage: whose data call failed, and why.
 * Backported from upstream dilaya/aws-sqlite-data 0.1.30 (1a347a7).
 *
 * The `AWS/ApiGateway 5xx` metric counts failures; it never names them.
 * Upstream's gateway ran 20 087 requests in 24 h with 2 in 5xx, and nothing
 * could say which app, which route, which caller, or whether the integration
 * had even been reached — on the layer where a failure means "a data call
 * failed".
 *
 * Retention is deliberately ONE WEEK: these lines are only ever read to explain
 * a 5xx that a metric window already surfaced; anything longer is paid for and
 * never read. Destroyed with the stack. Adding it does NOT roll the instance.
 */
export function addAccessLog(scope: Construct, httpApi: apigwv2.HttpApi): void {
  const accessLogGroup = new logs.LogGroup(scope, "HttpApiAccessLogs", {
    retention: logs.RetentionDays.ONE_WEEK,
    removalPolicy: cdk.RemovalPolicy.DESTROY,
  });
  // Access-log settings live only on the L1 stage — `HttpApi` exposes no prop
  // for them, and `defaultStage` is created for us by `createDefaultStage`.
  const cfnDefaultStage = httpApi.defaultStage!.node.defaultChild as apigwv2.CfnStage;
  cfnDefaultStage.accessLogSettings = {
    destinationArn: accessLogGroup.logGroupArn,
    // One JSON object per request, ordered by what a sweep reads: WHAT
    // (route/status), then WHY (a 5xx with no `integrationStatus` never reached
    // the VM at all — a different fault from one the VM answered), then WHO.
    format: JSON.stringify({
      requestId: "$context.requestId",
      requestTime: "$context.requestTime",
      httpMethod: "$context.httpMethod",
      routeKey: "$context.routeKey",
      path: "$context.path",
      status: "$context.status",
      integrationStatus: "$context.integrationStatus",
      integrationErrorMessage: "$context.integrationErrorMessage",
      integrationLatency: "$context.integrationLatency",
      responseLatency: "$context.responseLatency",
      errorMessage: "$context.error.message",
      sourceIp: "$context.identity.sourceIp",
      userAgent: "$context.identity.userAgent",
    }),
  };
}
