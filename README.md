# cdk-lambda-web

Unofficial L2 constructs for [AWS Lambda Web Functions](https://aws.amazon.com/about-aws/whats-new/2026/10/aws-lambda-web-functions/), built on the L1 `Cfn*` resources in aws-cdk-lib.
Not affiliated with AWS. Not yet tested against a real deployment.

AWS Lambda Web Functions 用の自作 L2 コンストラクトです。aws-cdk-lib 2.273.0 にある L1（`CfnWebFunction` / `CfnWebFunctionRevision` / `CfnWebFunctionEndpoint`）を包んでいます。
`cdk synth` とユニットテストまで確認済みで、実際のデプロイはまだしていません。

```ts
import { WebFunction, WebFunctionCode, WebFunctionEndpointType, WebFunctionAuthType } from 'cdk-lambda-web';

const fn = new WebFunction(this, 'App', {
  code: WebFunctionCode.fromAsset('dist/app'), // zip → バージョニング付き S3 → そのバージョンを使う
  entrypoint: 'server.mjs',                    // AWS_LAMBDA_NODEJS_ENTRYPOINT（既定は index.js）
  environment: { DATA_API_URL: 'https://...' },
  maxConcurrencyPerEnvironment: 64,            // 1〜128
});
fn.addEnvironment('FOO', 'bar');
bucket.grantRead(fn);                          // 実行ロールに付与
new CfnOutput(this, 'Url', { value: fn.url }); // 既定エンドポイント（公開・HomeRegion）

// 追加のエンドポイント
fn.addEndpoint('Global', {
  endpointType: WebFunctionEndpointType.MULTI_REGION,
  regions: ['ap-northeast-1', 'us-east-1'],
  authType: WebFunctionAuthType.IAM,
  maxEnvironments: 10,
  rateLimit: 500,
});
```

## 提供するもの

| クラス | 内容 |
|---|---|
| `WebFunction` | function・revision・既定エンドポイントをまとめて作成。`role` / `grantPrincipal`（`IGrantable`）、`url`、`addEnvironment`、`addEndpoint`、`addToRolePolicy`。L1 には `cfnFunction` / `cfnRevision` で触れます |
| `WebFunctionEndpoint` | エンドポイント単体。`endpointType`、`authType`、`regions`、`maxEnvironments`、`rateLimit` |
| `WebFunctionCode` | `fromAsset(dir)`（スタックで1つの共有コードバケットに自動アップロード）、`fromBucket(bucket, key, versionId)` |
| `WebFunctionCodeBucket` | 共有コードバケットの取得と、`lambda.amazonaws.com` への読み取り許可 |
| `WebFunctionRuntime` | `NODEJS_24`（`nodejs24.x`）と `of(name)` |

synth 時に検証するもの: `maxConcurrencyPerEnvironment` は 1〜128、`rateLimit` は 0 / 100〜1000（100刻み）/ 2000〜10000（1000刻み）、`regions` は MultiRegion / PerRegion のときだけ必須、revision の重みの合計は 100。

## 未確認の前提
- 実行ロールの信頼先を `lambda.amazonaws.com` にしています（イベント関数と同じと仮定）。
- function 名に使える文字は確認していません（既定はコンストラクトのパスから作る 64 文字以内の一意な名前）。
- CDK CLI のローカル検証が `AWS::Lambda::WebFunction` を未知のリソース型として警告しますが、synth は通ります。

## 使い方

npm には公開していません。GitHub から直接入れられます（`prepare` でビルドされます）。

```bash
npm i github:reeschan/cdk-lambda-web
```

ローカルのクローンを使う場合は、シンボリックリンクではなくコピーで入れてください（aws-cdk-lib が二重になるため）。

```bash
npm i --install-links ../path/to/cdk-lambda-web
```

## 開発

```bash
npm ci && npm run typecheck && npm test && npm run build
```

## License

MIT
