import assert from 'node:assert/strict';
import * as path from 'node:path';
import { test } from 'node:test';
import { App, Duration, Stack } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { WebFunction, WebFunctionAuthType, WebFunctionCode, WebFunctionEndpointType } from '../src';

const ASSET = path.join(__dirname, 'fixtures/app');
const newStack = () => new Stack(new App(), 'Test', { env: { account: '123456789012', region: 'ap-northeast-1' } });

test('defaults: function, revision, public HomeRegion endpoint, role and versioned code bucket', () => {
  const stack = newStack();
  const fn = new WebFunction(stack, 'Fn', { code: WebFunctionCode.fromAsset(ASSET) });
  const t = Template.fromStack(stack);

  t.resourceCountIs('AWS::Lambda::WebFunction', 1);
  t.hasResourceProperties('AWS::Lambda::WebFunctionRevision', {
    BuildConfig: {
      CodeConfig: { S3Object: { Bucket: Match.anyValue(), Key: Match.anyValue(), VersionId: Match.anyValue() } },
      RuntimeConfig: { Runtime: 'nodejs24.x' },
    },
    ServiceConfig: { ExecutionRoleArn: Match.anyValue(), EnvironmentVariables: Match.absent() },
  });
  t.hasResourceProperties('AWS::Lambda::WebFunctionEndpoint', {
    EndpointName: 'main',
    EndpointType: 'HomeRegion',
    AuthType: 'ApplicationManaged',
    RevisionWeights: [{ RevisionId: { 'Fn::GetAtt': [Match.anyValue(), 'RevisionId'] }, Weight: 100 }],
  });
  t.hasResourceProperties('AWS::S3::Bucket', { VersioningConfiguration: { Status: 'Enabled' } });
  t.hasResourceProperties('AWS::S3::BucketPolicy', {
    PolicyDocument: {
      Statement: Match.arrayWith([
        Match.objectLike({ Principal: { Service: 'lambda.amazonaws.com' }, Action: ['s3:GetObject', 's3:GetObjectVersion'] }),
      ]),
    },
  });
  t.hasResourceProperties('AWS::IAM::Role', {
    AssumeRolePolicyDocument: { Statement: [Match.objectLike({ Principal: { Service: 'lambda.amazonaws.com' } })] },
  });
  assert.match(stack.resolve(fn.url)['Fn::Join'][1][0], /https:\/\//);
});

test('function names are unique and at most 64 chars', () => {
  const stack = newStack();
  const a = new WebFunction(stack, 'A'.repeat(80), { code: WebFunctionCode.fromAsset(ASSET) });
  const b = new WebFunction(stack, 'B', { code: WebFunctionCode.fromAsset(ASSET) });
  assert.ok(a.functionName.length <= 64);
  assert.notEqual(a.functionName, b.functionName);
});

test('two functions share one code bucket', () => {
  const stack = newStack();
  new WebFunction(stack, 'A', { code: WebFunctionCode.fromAsset(ASSET) });
  new WebFunction(stack, 'B', { code: WebFunctionCode.fromAsset(ASSET) });
  Template.fromStack(stack).resourceCountIs('AWS::S3::Bucket', 1);
});

test('entrypoint, environment, addEnvironment, timeout, concurrency and logging', () => {
  const stack = newStack();
  const fn = new WebFunction(stack, 'Fn', {
    code: WebFunctionCode.fromAsset(ASSET),
    entrypoint: 'server.mjs',
    environment: { A: '1' },
    timeout: Duration.seconds(30),
    maxConcurrencyPerEnvironment: 128,
  });
  fn.addEnvironment('B', '2');
  Template.fromStack(stack).hasResourceProperties('AWS::Lambda::WebFunctionRevision', {
    ServiceConfig: {
      EnvironmentVariables: { A: '1', B: '2', AWS_LAMBDA_NODEJS_ENTRYPOINT: 'server.mjs' },
      TimeoutSeconds: 30,
      MaxConcurrencyPerEnvironment: 128,
    },
  });
});

test('fromBucket uses the given object and creates no bucket', () => {
  const stack = newStack();
  const bucket = s3.Bucket.fromBucketName(stack, 'B', 'my-code');
  new WebFunction(stack, 'Fn', { code: WebFunctionCode.fromBucket(bucket, 'app.zip', 'v1') });
  const t = Template.fromStack(stack);
  t.resourceCountIs('AWS::S3::Bucket', 0);
  t.hasResourceProperties('AWS::Lambda::WebFunctionRevision', {
    BuildConfig: { CodeConfig: { S3Object: { Bucket: 'my-code', Key: 'app.zip', VersionId: 'v1' } } },
  });
});

test('endpoint: false, then addEndpoint for a multi-region IAM endpoint with limits', () => {
  const stack = newStack();
  const fn = new WebFunction(stack, 'Fn', { code: WebFunctionCode.fromAsset(ASSET), endpoint: false });
  assert.throws(() => fn.url, /endpoint: false/);
  fn.addEndpoint('Global', {
    endpointName: 'global',
    endpointType: WebFunctionEndpointType.MULTI_REGION,
    regions: ['ap-northeast-1', 'us-east-1'],
    authType: WebFunctionAuthType.IAM,
    maxEnvironments: 10,
    rateLimit: 500,
  });
  const t = Template.fromStack(stack);
  t.resourceCountIs('AWS::Lambda::WebFunctionEndpoint', 1);
  t.hasResourceProperties('AWS::Lambda::WebFunctionEndpoint', {
    EndpointType: 'MultiRegion',
    Regions: ['ap-northeast-1', 'us-east-1'],
    AuthType: 'IamAuth',
    ScalingConfig: { MaxEnvironments: 10 },
    ThrottleConfig: { RateLimit: 500 },
  });
});

test('grants go to the execution role', () => {
  const stack = newStack();
  const fn = new WebFunction(stack, 'Fn', { code: WebFunctionCode.fromAsset(ASSET) });
  new s3.Bucket(stack, 'Data').grantRead(fn);
  Template.fromStack(stack).hasResourceProperties('AWS::IAM::Policy', {
    Roles: [{ Ref: Match.stringLikeRegexp('FnServiceRole') }],
  });
});

test('a given role is used as is', () => {
  const stack = newStack();
  const role = iam.Role.fromRoleArn(stack, 'R', 'arn:aws:iam::123456789012:role/existing');
  new WebFunction(stack, 'Fn', { code: WebFunctionCode.fromAsset(ASSET), role });
  const t = Template.fromStack(stack);
  t.resourceCountIs('AWS::IAM::Role', 2); // only the BucketDeployment / autoDelete handler roles
  t.hasResourceProperties('AWS::Lambda::WebFunctionRevision', {
    ServiceConfig: { ExecutionRoleArn: 'arn:aws:iam::123456789012:role/existing' },
  });
});

test('validation', () => {
  const code = WebFunctionCode.fromAsset(ASSET);
  assert.throws(() => new WebFunction(newStack(), 'Fn', { code, maxConcurrencyPerEnvironment: 129 }), /1 to 128/);
  assert.throws(() => new WebFunction(newStack(), 'Fn', { code, endpoint: { rateLimit: 150 } }), /rateLimit/);
  assert.throws(() => new WebFunction(newStack(), 'Fn', { code, endpoint: { maxEnvironments: 0 } }), /maxEnvironments/);
  assert.throws(
    () => new WebFunction(newStack(), 'Fn', { code, endpoint: { endpointType: WebFunctionEndpointType.PER_REGION } }),
    /at least one region/,
  );
  assert.throws(() => new WebFunction(newStack(), 'Fn', { code, endpoint: { regions: ['us-east-1'] } }), /only be set/);
});

test('fromAsset: S3 key includes the per-function prefix that BucketDeployment writes to', () => {
  const stack = newStack();
  new WebFunction(stack, 'Fn', { functionName: 'shop', code: WebFunctionCode.fromAsset(ASSET) });
  const rev = Object.values(Template.fromStack(stack).findResources('AWS::Lambda::WebFunctionRevision'))[0] as any;
  const key = rev.Properties.BuildConfig.CodeConfig.S3Object.Key;
  assert.equal(key['Fn::Join'][0], '');
  assert.equal(key['Fn::Join'][1][0], 'shop/');
});
