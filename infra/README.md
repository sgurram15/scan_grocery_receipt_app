# Terraform: all-serverless deployment

Provisions the AWS resources that host this app:

| Resource | Purpose |
|---|---|
| `aws_lambda_function.api` | Runs the Express app (wrapped with `serverless-http`) |
| `aws_apigatewayv2_api.api` | Public HTTPS endpoint that invokes the Lambda |
| `aws_iam_role.api` | Grants the Lambda S3 PutObject + DynamoDB Get/Scan |
| `aws_s3_bucket.web` | Holds the built frontend (`frontend/dist/`) |
| `aws_cloudfront_distribution.web` | Serves the site; routes `/api/*` to API Gateway |

The Python `healthCheckReceipt` Lambda, the `receipts-…-test` S3 bucket, and the `ReceiptHealthAnalysis` DynamoDB table are **not** managed here — they already existed before this Terraform was written.

## Prerequisites

- Terraform >= 1.6
- AWS CLI v2, authenticated (env vars or `aws configure`) with rights to create the resources above
- Node.js 20.x + npm

## One-time setup

```powershell
cd infra
cp terraform.tfvars.example terraform.tfvars
# Edit terraform.tfvars and pick a globally-unique web_bucket_name.
terraform init
```

## First deploy

```powershell
# 1. Build the backend zip that the Lambda resource references.
..\scripts\build-backend.ps1

# 2. Provision everything.
terraform apply

# 3. Build & push the frontend, invalidate CloudFront.
..\scripts\deploy-frontend.ps1
```

`terraform apply` prints the public site URL (`site_url`). CloudFront usually takes 3–5 minutes after first creation before it serves traffic; subsequent deploys are near-instant after the invalidation.

## Updating

| You changed… | Run |
|---|---|
| Backend code (Express routes, services) | `..\scripts\build-backend.ps1` then `terraform apply` |
| Frontend code | `..\scripts\deploy-frontend.ps1` |
| Infra (`.tf` files) | `terraform apply` |
| Python Lambda (`backend/services/lambda_function.py`) | Not managed here — redeploy via `aws lambda update-function-code` against `healthCheckReceipt` (see project root) |

## Tear-down

```powershell
# Empty the web bucket first — terraform destroy won't delete a non-empty bucket.
aws s3 rm "s3://$(terraform output -raw web_bucket)/" --recursive
terraform destroy
```

This will NOT delete the pre-existing `receipts-…-test` bucket, the `ReceiptHealthAnalysis` table, or the `healthCheckReceipt` Lambda.

## Notes & limits

- **Lambda payload limit is 6 MB.** Receipts above that will fail upload. If you hit it, switch the upload route to issuing a presigned S3 PUT URL and have the browser upload directly.
- **Cold starts** on the Node Lambda are ~600 ms. Provisioned concurrency is available if needed.
- **CORS** is configured both on the API Gateway and via the Express `cors()` middleware. Because CloudFront proxies `/api/*` from the same origin as the site, browsers won't actually do CORS preflights in production — only during local `npm run dev`.
- The CloudFront distribution uses the default `*.cloudfront.net` cert. For a custom domain, add `aws_acm_certificate` (in `us-east-1`) + `aws_route53_record` and reference them in `viewer_certificate` + `aliases`.
