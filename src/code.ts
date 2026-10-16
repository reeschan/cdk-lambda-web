import { Fn, RemovalPolicy, Stack } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import { Construct } from 'constructs';

/** Where a web function revision's code lives once bound. */
export interface WebFunctionCodeConfig {
  readonly bucketName: string;
  readonly key: string;
  readonly versionId?: string;
  /** Construct the revision must wait for (e.g. the upload). */
  readonly dependable?: Construct;
}

export interface AssetCodeOptions {
  /**
   * Versioned bucket to upload into.
   * @default - one shared bucket per stack, created on first use (see `WebFunctionCodeBucket.of`)
   */
  readonly bucket?: s3.IBucket;
}

/**
 * Code for a web function. Web functions only read code from a *versioned* S3 object
 * that `lambda.amazonaws.com` is allowed to read; zip uploads are not supported.
 */
export abstract class WebFunctionCode {
  /** Zip a local directory, upload it to a versioned bucket and use that object version. */
  static fromAsset(path: string, options: AssetCodeOptions = {}): WebFunctionCode {
    return new AssetCode(path, options);
  }

  /**
   * An existing object. The bucket must have versioning enabled and grant `lambda.amazonaws.com`
   * read access (`WebFunctionCodeBucket.grantLambdaRead`).
   */
  static fromBucket(bucket: s3.IBucket, key: string, versionId?: string): WebFunctionCode {
    return new BucketCode(bucket, key, versionId);
  }

  /** Called once per web function. */
  abstract bind(scope: Construct, functionName: string): WebFunctionCodeConfig;
}

class AssetCode extends WebFunctionCode {
  constructor(private readonly path: string, private readonly options: AssetCodeOptions) {
    super();
  }

  bind(scope: Construct, functionName: string): WebFunctionCodeConfig {
    const bucket = this.options.bucket ?? WebFunctionCodeBucket.of(scope);
    const prefix = `${functionName}/`;
    const upload = new s3deploy.BucketDeployment(scope, 'CodeUpload', {
      sources: [s3deploy.Source.asset(this.path)],
      destinationBucket: bucket,
      destinationKeyPrefix: prefix,
      extract: false,
      prune: false,
    });
    return {
      bucketName: bucket.bucketName,
      // objectKeys does not include destinationKeyPrefix, so add it back.
      key: Fn.join('', [prefix, Fn.select(0, upload.objectKeys)]),
      versionId: Fn.select(0, upload.objectVersionIds),
      dependable: upload,
    };
  }
}

class BucketCode extends WebFunctionCode {
  constructor(private readonly bucket: s3.IBucket, private readonly key: string, private readonly versionId?: string) {
    super();
  }

  bind(): WebFunctionCodeConfig {
    return { bucketName: this.bucket.bucketName, key: this.key, versionId: this.versionId };
  }
}

/** Helpers for the versioned bucket web functions read code from. */
export class WebFunctionCodeBucket {
  private static readonly ID = 'WebFunctionCodeBucket';

  /** The stack-wide code bucket, created on first use. */
  static of(scope: Construct): s3.IBucket {
    const stack = Stack.of(scope);
    const existing = stack.node.tryFindChild(WebFunctionCodeBucket.ID) as s3.Bucket | undefined;
    if (existing) return existing;
    const bucket = new s3.Bucket(stack, WebFunctionCodeBucket.ID, {
      versioned: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });
    WebFunctionCodeBucket.grantLambdaRead(bucket);
    return bucket;
  }

  /** Lets the Lambda service read object versions in the bucket (same account only). */
  static grantLambdaRead(bucket: s3.IBucket): void {
    bucket.addToResourcePolicy(
      new iam.PolicyStatement({
        principals: [new iam.ServicePrincipal('lambda.amazonaws.com')],
        actions: ['s3:GetObject', 's3:GetObjectVersion'],
        resources: [bucket.arnForObjects('*')],
        conditions: { StringEquals: { 'aws:SourceAccount': Stack.of(bucket).account } },
      }),
    );
  }
}
