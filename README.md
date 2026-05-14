# Receipt Health Analyzer

Upload a grocery receipt → get a 0–100 health score, an item-by-item breakdown (Healthy / Unhealthy / Non-food / Uncategorized), and personalized swap suggestions.

The app is a small async pipeline that spans three AWS-hosted runtimes:

1. **Express upload API** (Node Lambda behind API Gateway) — accepts the receipt and stores it in S3.
2. **Python `healthCheckReceipt` Lambda** (triggered by S3 `ObjectCreated`) — runs Textract OCR, classifies items against keyword sets, computes the health score, and writes the result to DynamoDB.
3. **React frontend** (S3 + CloudFront) — uploads the file, polls the API until the analysis is ready, and renders the breakdown.

## Architecture

```
            ┌────────────┐    POST /api/process-receipt    ┌────────────────┐
            │  Frontend  │ ──────────────────────────────► │  Express API   │
            │ (CloudFront│                                 │  (Node Lambda) │
            │  + S3)     │ ◄── GET /api/receipts/:id ───── │                │
            └────────────┘         (polled every 2s)       └──────┬─────────┘
                  ▲                                               │
                  │                                          PUT  │
                  │                                               ▼
                  │                                        ┌──────────────┐
                  │                                        │  S3 uploads  │
                  │                                        │   bucket     │
                  │                                        └──────┬───────┘
                  │                                               │ ObjectCreated
                  │                                               ▼
                  │                                        ┌──────────────┐
                  │                                        │  Python      │
                  │                                        │  Lambda      │
                  │                                        │  (Textract + │
                  │                                        │  classifier) │
                  │                                        └──────┬───────┘
                  │           polls until ready                   │
                  └──────────── DynamoDB ◄────── put_item ────────┘
                            (ReceiptHealthAnalysis)
```

## Repo layout

```
receipt-ai-app/
├── backend/                # Express API (Node 20 ESM)
│   ├── app.js              # Express app — shared by local dev and Lambda
│   ├── server.js           # Local dev entrypoint (app.listen)
│   ├── lambda.js           # Production entrypoint (serverless-http wrapper)
│   ├── routes/receipts.js
│   ├── services/
│   │   └── lambda_function.py   # Python Lambda code (deployed separately, see below)
│   └── .env.example
├── frontend/               # Vite + React
│   ├── src/App.jsx
│   └── src/styles.css
├── infra/                  # Terraform for Node Lambda + API Gateway + S3/CloudFront
└── scripts/
    ├── build-backend.ps1   # Zips backend/ → infra/build/backend.zip
    └── deploy-frontend.ps1 # Builds frontend, syncs to S3, invalidates CloudFront
```

---

## Local development

Two terminals.

**Backend** (`http://localhost:5000`):

```powershell
cd backend
copy .env.example .env       # then edit .env with your values
npm install
npm run dev                   # nodemon
```

`.env` needs:

```
PORT=5000
AWS_REGION=us-east-1
BUCKET_NAME=<your-receipts-bucket>
```

Local dev still talks to real AWS — your AWS CLI credentials (`aws configure`) need permission to PUT into the uploads bucket and GET from the DynamoDB table.

**Frontend** (`http://localhost:5173`):

```powershell
cd frontend
npm install
npm run dev
```

Vite proxies `/api/*` to `http://localhost:5000`, so the React app calls relative paths.

---

## Deployment

There are **three** independent deploy targets. They don't all redeploy together — pick the one that matches what you changed.

### Prerequisites (one-time)

| Tool | Why | Install |
|---|---|---|
| Node 20.x + npm | Build backend zip + frontend assets | https://nodejs.org |
| AWS CLI v2 | S3 sync, CloudFront invalidation, Lambda update | https://aws.amazon.com/cli/ |
| Terraform ≥ 1.6 | Provision API Gateway / Lambda / CloudFront | https://developer.hashicorp.com/terraform/install |
| PowerShell scripts allowed | Deploy scripts are `.ps1` | `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` |
| AWS credentials configured | `aws sts get-caller-identity` must succeed | `aws configure` |

These AWS resources must already exist (they predate this Terraform):

- An S3 bucket for receipt uploads, with an event notification triggering the `healthCheckReceipt` Lambda
- A DynamoDB table named `ReceiptHealthAnalysis` with `receipt_id` as the partition key
- A Python Lambda named `healthCheckReceipt` with Textract + DynamoDB + S3 read permissions

### 1. First-time infra deploy (Terraform)

Provisions the Node Lambda, API Gateway, S3 web bucket, and CloudFront distribution.

```powershell
cd infra
copy terraform.tfvars.example terraform.tfvars
# Edit terraform.tfvars — set uploads_bucket_name and a globally-unique web_bucket_name.

terraform init
..\scripts\build-backend.ps1     # produces infra/build/backend.zip
terraform apply                   # type 'yes' to confirm
```

`terraform apply` prints `site_url` — that's your public CloudFront URL. First-time CloudFront propagation takes ~3–5 minutes.

### 2. Deploy backend changes (Express routes, services)

After editing anything in `backend/` except `services/lambda_function.py`:

```powershell
.\scripts\build-backend.ps1      # rebuilds infra/build/backend.zip
cd infra
terraform apply                   # detects new zip hash, updates the Lambda
cd ..
```

### 3. Deploy frontend changes (React / CSS)

After editing anything in `frontend/`:

```powershell
.\scripts\deploy-frontend.ps1
```

The script runs `npm install`, `npm run build`, syncs `frontend/dist/` to the web S3 bucket, and invalidates CloudFront. Hard-refresh the browser (`Ctrl + Shift + R`) after it finishes.

### 4. Deploy Python Lambda changes (`lambda_function.py`)

**Not managed by Terraform.** When you edit `backend/services/lambda_function.py`, push it manually:

```powershell
cd backend\services
Compress-Archive -Path lambda_function.py -DestinationPath ..\..\lambda_function.zip -Force
cd ..\..
aws lambda update-function-code `
  --function-name healthCheckReceipt `
  --zip-file fileb://lambda_function.zip
```

The Lambda's handler must remain `lambda_function.lambda_handler` and the file must sit at the root of the zip (not nested in a folder).

### Deployment cheat sheet

| You changed… | Run |
|---|---|
| `frontend/**` | `.\scripts\deploy-frontend.ps1` |
| `backend/**` (except the Python file) | `.\scripts\build-backend.ps1` then `terraform apply` in `infra/` |
| `backend/services/lambda_function.py` | Manual zip + `aws lambda update-function-code` (see above) |
| `infra/*.tf` | `terraform apply` in `infra/` |
| Keyword lists in `lambda_function.py` | Same as #3 — just the Python Lambda |

---

## Configuration reference

`backend/.env` (local dev only — Lambda gets these from Terraform env vars):

| Var | Default | Used by |
|---|---|---|
| `PORT` | `5000` | `server.js` |
| `AWS_REGION` | — | S3 + DynamoDB clients |
| `BUCKET_NAME` | — | Upload route, S3 PUT target |

`infra/terraform.tfvars`:

| Var | Description |
|---|---|
| `region` | AWS region for all new resources |
| `project_name` | Prefix for Terraform-created resource names |
| `uploads_bucket_name` | The pre-existing S3 bucket for receipts |
| `ddb_table_name` | `ReceiptHealthAnalysis` (rarely changes) |
| `web_bucket_name` | Globally-unique bucket for the built frontend |

Hard-coded in two places (change together): the DynamoDB table name `ReceiptHealthAnalysis` is referenced in both `backend/routes/receipts.js` and `backend/services/lambda_function.py`.

---

## How classification works

`lambda_function.py` runs three keyword sets against each Textract line:

1. **`NON_FOOD_KEYWORDS`** first — so `baking soda` doesn't get confused with the soft-drink `soda`.
2. **`UNHEALTHY_ITEMS`** second — so `Milk Choc Rabbit` matches `choc` before it matches `milk`.
3. **`HEALTHY_ITEMS`** third — residual matches.

Anything that matches none lands in `unknown_items` and shows up in the **Uncategorized** column on the UI. Add new terms to the keyword sets in `lambda_function.py` to improve coverage over time.

Receipt chrome (totals, promo banners, prices) is filtered by `RECEIPT_NOISE_KEYWORDS` + `is_item_line()` before classification, so it never pollutes the uncategorized list.

Health score = `healthy_count / (healthy_count + unhealthy_count) * 100`.

---

## Costs

The app fits comfortably in AWS free-tier for hobby use. The only meaningful paid component is **Amazon Textract** after its 3-month free window ($0.0015 per page of `DetectDocumentText`). At 1,000 receipts/month, monthly cost is ~$1.50.

## Tear-down

```powershell
cd infra
aws s3 rm "s3://$(terraform output -raw web_bucket)/" --recursive
terraform destroy
```

This destroys only the resources Terraform created. The pre-existing receipts S3 bucket, `ReceiptHealthAnalysis` DynamoDB table, and `healthCheckReceipt` Python Lambda are left alone.
