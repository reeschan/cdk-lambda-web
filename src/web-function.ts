import { Duration, Lazy, Names, Resource, Token } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import { WebFunctionCode } from './code';
import { WebFunctionEndpoint, type WebFunctionEndpointOptions } from './endpoint';

/** Runtime identifier for a web function revision. */
export class WebFunctionRuntime {
  /** Node.js 24 on arm64 (the only runtime at launch). */
  static readonly NODEJS_24 = new WebFunctionRuntime('nodejs24.x');
  /** Escape hatch for runtimes added after this library was written. */
  static of(name: string): WebFunctionRuntime {
    return new WebFunctionRuntime(name);
  }
  private constructor(readonly name: string) {}
}

export interface WebFunctionProps {
  /** Your server listens on `AWS_LAMBDA_HTTP_ENDPOINT` (host:port). */
  readonly code: WebFunctionCode;
  /** @default - a unique name derived from the construct path */
  readonly functionName?: string;
  /** @default WebFunctionRuntime.NODEJS_24 */
  readonly runtime?: WebFunctionRuntime;
  /**
   * File the runtime loads, relative to the code root. Sets `AWS_LAMBDA_NODEJS_ENTRYPOINT`.
   * @default - the runtime default, `index.js`
   */
  readonly entrypoint?: string;
  readonly environment?: Record<string, string>;
  /** @default - a new role with AWSLambdaBasicExecutionRole */
  readonly role?: iam.IRole;
  /** @default - service default */
  readonly timeout?: Duration;
  /** Requests one execution environment handles at once, 1-128. @default - service default (64) */
  readonly maxConcurrencyPerEnvironment?: number;
  readonly applicationLogLevel?: lambda.ApplicationLogLevel;
  readonly systemLogLevel?: lambda.SystemLogLevel;
  /** @default - service default (`/aws/lambda/web/<function>`) */
  readonly logGroup?: logs.ILogGroup;
  /** Key used to encrypt the revision. @default - AWS owned key */
  readonly encryptionKey?: kms.IKey;
  /** Description of the revision. */
  readonly description?: string;
  /**
   * The endpoint created with the function. `false` creates none (add one later with `addEndpoint`).
   * @default - a public HomeRegion endpoint named 'main'
   */
  readonly endpoint?: WebFunctionEndpointOptions | false;
}

/**
 * An AWS Lambda web function: a plain HTTP server run by Lambda.
 * Creates the function, one revision with the given code and settings, and (by default) an endpoint.
 */
export class WebFunction extends Resource implements iam.IGrantable {
  readonly functionName: string;
  readonly functionArn: string;
  readonly role: iam.IRole;
  readonly grantPrincipal: iam.IPrincipal;
  /** ID of the revision this construct creates; changes whenever code or settings change. */
  readonly revisionId: string;
  readonly revisionArn: string;
  /** The default endpoint, unless `endpoint: false`. */
  readonly endpoint?: WebFunctionEndpoint;
  /** Underlying L1 resources, for anything this class doesn't expose. */
  readonly cfnFunction: lambda.CfnWebFunction;
  readonly cfnRevision: lambda.CfnWebFunctionRevision;

  private readonly environment: Record<string, string> = {};

  constructor(scope: Construct, id: string, props: WebFunctionProps) {
    super(scope, id);
    const max = props.maxConcurrencyPerEnvironment;
    if (max !== undefined && !Token.isUnresolved(max) && (!Number.isInteger(max) || max < 1 || max > 128)) {
      throw new Error(`maxConcurrencyPerEnvironment must be an integer from 1 to 128 (got ${max})`);
    }

    this.functionName = props.functionName ?? Names.uniqueResourceName(this, { maxLength: 64, separator: '-' });
    this.role =
      props.role ??
      new iam.Role(this, 'ServiceRole', {
        // Assumption: web functions use the same service principal as event functions.
        assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
        managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')],
      });
    this.grantPrincipal = this.role;

    Object.assign(this.environment, props.environment);
    if (props.entrypoint) this.environment.AWS_LAMBDA_NODEJS_ENTRYPOINT = props.entrypoint;

    this.cfnFunction = new lambda.CfnWebFunction(this, 'Resource', { functionName: this.functionName });
    this.functionArn = this.cfnFunction.attrFunctionArn;

    const code = props.code.bind(this, this.functionName);
    const logging =
      props.applicationLogLevel || props.systemLogLevel || props.logGroup
        ? {
            applicationLogLevel: props.applicationLogLevel,
            systemLogLevel: props.systemLogLevel,
            logGroup: props.logGroup?.logGroupName,
          }
        : undefined;

    this.cfnRevision = new lambda.CfnWebFunctionRevision(this, 'Revision', {
      functionName: this.functionName,
      description: props.description,
      kmsKeyArn: props.encryptionKey?.keyArn,
      buildConfig: {
        codeConfig: { s3Object: { bucket: code.bucketName, key: code.key, versionId: code.versionId } },
        runtimeConfig: { runtime: (props.runtime ?? WebFunctionRuntime.NODEJS_24).name },
      },
      serviceConfig: {
        executionRoleArn: this.role.roleArn,
        timeoutSeconds: props.timeout?.toSeconds(),
        maxConcurrencyPerEnvironment: max,
        environmentVariables: Lazy.any({
          produce: () => (Object.keys(this.environment).length ? { ...this.environment } : undefined),
        }),
        telemetryConfig: logging ? { loggingConfig: logging } : undefined,
      },
    });
    this.cfnRevision.addResourceDependency(this.cfnFunction);
    if (code.dependable) this.cfnRevision.node.addDependency(code.dependable);
    // The role (and its policies) must exist before the revision is created.
    this.cfnRevision.node.addDependency(this.role);
    this.revisionId = this.cfnRevision.attrRevisionId;
    this.revisionArn = this.cfnRevision.attrRevisionArn;

    if (props.endpoint !== false) this.endpoint = this.addEndpoint('Endpoint', props.endpoint ?? {});
  }

  /** URL of the default endpoint. */
  get url(): string {
    if (!this.endpoint) throw new Error(`${this.node.path} was created with endpoint: false; use addEndpoint()`);
    return this.endpoint.url;
  }

  /** Adds another endpoint (e.g. an IAM-protected one) sending all traffic to this revision. */
  addEndpoint(id: string, options: WebFunctionEndpointOptions = {}): WebFunctionEndpoint {
    const endpoint = new WebFunctionEndpoint(this, id, {
      ...options,
      functionName: this.functionName,
      revisionWeights: [{ revisionId: this.revisionId, weight: 100 }],
    });
    endpoint.node.addDependency(this.cfnFunction);
    return endpoint;
  }

  addEnvironment(key: string, value: string): this {
    this.environment[key] = value;
    return this;
  }

  addToRolePolicy(statement: iam.PolicyStatement): void {
    this.role.addToPrincipalPolicy(statement);
  }
}
