import { Resource, Token } from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';

export enum WebFunctionEndpointType {
  /** Serves traffic from the Region the web function was created in. */
  HOME_REGION = 'HomeRegion',
  /** Replicated across `regions`; each request goes to the nearest one. */
  MULTI_REGION = 'MultiRegion',
  /** A separate endpoint in each of `regions`. */
  PER_REGION = 'PerRegion',
}

export enum WebFunctionAuthType {
  /** Public; the application handles authorization. */
  APPLICATION_MANAGED = 'ApplicationManaged',
  /** Requests must be SigV4-signed and authorized by IAM. */
  IAM = 'IamAuth',
}

export interface WebFunctionEndpointOptions {
  /** @default 'main' */
  readonly endpointName?: string;
  /** @default HOME_REGION */
  readonly endpointType?: WebFunctionEndpointType;
  /** @default APPLICATION_MANAGED */
  readonly authType?: WebFunctionAuthType;
  /** Required for MULTI_REGION and PER_REGION; not allowed for HOME_REGION. Fixed at creation. */
  readonly regions?: string[];
  /** Cap on concurrent execution environments. @default - account vCPU quota only */
  readonly maxEnvironments?: number;
  /**
   * Cap on requests per second. 0, 100-1000 in steps of 100, or 2000-10000 in steps of 1000.
   * @default - account rate quota only
   */
  readonly rateLimit?: number;
  readonly description?: string;
}

export interface WebFunctionEndpointProps extends WebFunctionEndpointOptions {
  readonly functionName: string;
  /** Revision IDs and their traffic weights. */
  readonly revisionWeights: { revisionId: string; weight: number }[];
}

/** A public (or IAM-protected) HTTPS endpoint routing to one or more revisions. */
export class WebFunctionEndpoint extends Resource {
  readonly endpointArn: string;
  /** e.g. `xxxx.lambda-web.ap-northeast-1.on.aws` (exact format is service-defined). */
  readonly domainName: string;
  readonly url: string;
  /** The underlying L1 resource, for anything this class doesn't expose. */
  readonly cfn: lambda.CfnWebFunctionEndpoint;

  constructor(scope: Construct, id: string, props: WebFunctionEndpointProps) {
    super(scope, id);
    validateEndpoint(props);

    this.cfn = new lambda.CfnWebFunctionEndpoint(this, 'Resource', {
      functionName: props.functionName,
      endpointName: props.endpointName ?? 'main',
      endpointType: props.endpointType ?? WebFunctionEndpointType.HOME_REGION,
      authType: props.authType ?? WebFunctionAuthType.APPLICATION_MANAGED,
      regions: props.regions,
      description: props.description,
      revisionWeights: props.revisionWeights,
      scalingConfig: props.maxEnvironments !== undefined ? { maxEnvironments: props.maxEnvironments } : undefined,
      throttleConfig: props.rateLimit !== undefined ? { rateLimit: props.rateLimit } : undefined,
    });
    this.endpointArn = this.cfn.attrEndpointArn;
    this.domainName = this.cfn.attrDomainName;
    this.url = `https://${this.domainName}`;
  }
}

function validateEndpoint(props: WebFunctionEndpointProps): void {
  const type = props.endpointType ?? WebFunctionEndpointType.HOME_REGION;
  const hasRegions = (props.regions?.length ?? 0) > 0;
  if (type === WebFunctionEndpointType.HOME_REGION && hasRegions) {
    throw new Error('regions can only be set for MULTI_REGION or PER_REGION endpoints');
  }
  if (type !== WebFunctionEndpointType.HOME_REGION && !hasRegions) {
    throw new Error(`${type} endpoints need at least one region`);
  }
  const rate = props.rateLimit;
  if (rate !== undefined && !Token.isUnresolved(rate)) {
    const ok = rate === 0 || (rate >= 100 && rate <= 1000 && rate % 100 === 0) || (rate >= 2000 && rate <= 10000 && rate % 1000 === 0);
    if (!ok) throw new Error(`rateLimit must be 0, 100-1000 in steps of 100, or 2000-10000 in steps of 1000 (got ${rate})`);
  }
  const max = props.maxEnvironments;
  if (max !== undefined && !Token.isUnresolved(max) && (!Number.isInteger(max) || max < 1)) {
    throw new Error(`maxEnvironments must be a positive integer (got ${max})`);
  }
  const total = props.revisionWeights.reduce((a, w) => a + w.weight, 0);
  if (props.revisionWeights.every((w) => !Token.isUnresolved(w.weight)) && total !== 100) {
    throw new Error(`revision weights must add up to 100 (got ${total})`);
  }
}
