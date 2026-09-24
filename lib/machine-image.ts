import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
// The instance AMI is PINNED (CLAUDE.md invariant 9). Moving it replaces the
// database VM, so it moves only when a human bumps the constant — never because
// AWS published something. The pin and the check that tells us it has fallen
// behind (`npm run check:ami`) live together in ./ami-pin.ts.
import { PINNED_AMI_ID, PINNED_AMI_REGION } from "./ami-pin.ts";

/**
 * The VM's AMI — pinned by default, on purpose. Backported from upstream
 * dilaya/aws-sqlite-data 0.1.11 (bb34f7d).
 *
 * `MachineImage.latestAmazonLinux2023()` re-resolves "the newest AL2023" at
 * EVERY deploy. AWS publishes one roughly monthly, so the next deploy after a
 * publication — of ANYTHING, a parameter tweak included — hands the launch
 * template a different ImageId, and the rolling update
 * (`minInstancesInService: 0`) terminates the database VM to apply it: ~60 s
 * with no Data API, at a moment nobody chose.
 *
 * So the id is a constant. It moves when someone bumps `PINNED_AMI_ID` or
 * passes `amiId`, i.e. on a dated, announced deploy. `amiId=latest` restores
 * the auto-resolving behaviour (surprise roll included). Omitted = the pin.
 */
export function resolveMachineImage(stack: cdk.Stack, amiId: string = PINNED_AMI_ID): ec2.IMachineImage {
  if (amiId === "latest") {
    return ec2.MachineImage.latestAmazonLinux2023({
      cpuType: ec2.AmazonLinuxCpuType.ARM_64,
    });
  }
  if (!/^ami-[0-9a-f]{8,17}$/.test(amiId)) {
    throw new Error(`amiId must be an AMI id ("ami-…") or the literal "latest"; got ${JSON.stringify(amiId)}`);
  }
  // An AMI id is region-scoped: the pinned default only exists in eu-west-1.
  // Fail here rather than with an ASG that cannot launch anything.
  if (amiId === PINNED_AMI_ID && !cdk.Token.isUnresolved(stack.region) && stack.region !== PINNED_AMI_REGION) {
    throw new Error(
      `The default amiId (${PINNED_AMI_ID}) is an AL2023 arm64 image of ${PINNED_AMI_REGION} and does not exist in ${stack.region}. ` +
        `Pass amiId=<an arm64 AL2023 AMI of ${stack.region}>, or amiId=latest to resolve it at deploy time.`,
    );
  }
  // Deliberately not MachineImage.genericLinux(): that needs a region map and
  // a resolved region. The launch template supplies its own user data, so the
  // one here is a placeholder (LaunchTemplate: props.userData ?? image's).
  return {
    getImage: () => ({
      imageId: amiId,
      osType: ec2.OperatingSystemType.LINUX,
      userData: ec2.UserData.forLinux(),
    }),
  };
}
