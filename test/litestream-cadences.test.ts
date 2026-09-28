// The litestream housekeeping cadences must reach the VM (CLAUDE.md inv. 12).
// The service's own defaults are only half of it: Hereya passes a parameter's
// hereyarc default as the env var, which overrides the code default, so the
// hereyarc, the stack input and the service must agree — or the fleet keeps
// LISTing S3 at litestream's 15s while every file looks right.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { before, test } from "node:test";
import { Template } from "aws-cdk-lib/assertions";
import { loadConfig } from "../service/src/config.ts";
import { synthStack } from "./synth-helpers.ts";

let userData: string;

before(() => {
  const template = Template.fromStack(synthStack("TestStackCadences"));
  const lt = Object.values(template.findResources("AWS::EC2::LaunchTemplate"))[0]!;
  userData = JSON.stringify(lt.Properties.LaunchTemplateData.UserData);
});

const SHIPPED: Array<[param: string, env: string, value: string]> = [
  ["litestreamL0Retention", "LITESTREAM_L0_RETENTION", "3h"],
  ["litestreamL0RetentionCheckInterval", "LITESTREAM_L0_RETENTION_CHECK_INTERVAL", "30m"],
  ["litestreamLevelIntervals", "LITESTREAM_LEVEL_INTERVALS", "30m,2h,6h"],
];

test("the stack writes the shipped cadences into the service env", () => {
  for (const [, env, value] of SHIPPED) {
    assert.ok(userData.includes(`${env}=${value}`), `${env}=${value} missing from user-data`);
  }
});

test("hereyarc declares each cadence with the same default", () => {
  const rc = readFileSync(new URL("../hereyarc.yaml", import.meta.url), "utf8");
  for (const [param, , value] of SHIPPED) {
    const at = rc.indexOf(`\n  ${param}:`);
    assert.ok(at >= 0, `hereyarc.yaml must declare ${param}`);
    const m = /\n    default: "([^"]+)"/.exec(rc.slice(at));
    assert.equal(m?.[1], value, `${param} default`);
  }
});

test("the service's own defaults match, so an unset env ships the same config", () => {
  const cfg = loadConfig({} as NodeJS.ProcessEnv);
  assert.equal(cfg.litestreamL0Retention, "3h");
  assert.equal(cfg.litestreamL0RetentionCheckInterval, "30m");
  assert.deepEqual(cfg.litestreamLevelIntervals, ["30m", "2h", "6h"]);
});
