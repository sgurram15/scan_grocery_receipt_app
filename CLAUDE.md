# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

Backend (Node.js/Express, ESM):

```
cd backend
npm install
npm run dev      # nodemon server.js  (local dev only)
npm start        # node server.js
```

`backend/app.js` exports the Express app. `server.js` is the local-dev entrypoint (calls `app.listen`). `lambda.js` wraps the same app with `serverless-http` for the deployed Lambda — both share `routes/` and `services/` unchanged.

Frontend (Vite + React):

```
cd frontend
npm install
npm run dev      # http://localhost:5173, proxies /api to backend
npm run build
npm run preview
```

There are no tests, linter, or typecheck scripts configured.

## Required backend environment

`backend/app.js` calls `dotenv.config()` and reads:

- `PORT` — server port. Current `.env` uses `5000`, and `vite.config.js` proxies `/api` to `http://localhost:5000`. Keep these in sync with `backend/.env.example` if you change it.
- `AWS_REGION` — used by the S3 and DynamoDB clients
- `BUCKET_NAME` — S3 bucket the upload route writes to

A `.env` file in `backend/` is expected but not checked in.

## Architecture

The app is an async pipeline split across three runtimes. Reading just `backend/` is misleading because the actual receipt analysis runs in AWS, not Express.

1. **Upload (Express)** — `POST /api/process-receipt` in `backend/routes/receipts.js` accepts a multipart file, uploads it to S3 under `receipts/<timestamp>-<name>`, and returns `{ receipt_id, s3_key }`. The `receipt_id` is the S3 key with `/` replaced by `_`. Express does **not** do any OCR or classification itself.
2. **Process (AWS Lambda)** — `backend/services/lambda_function.py` is the deployed Lambda triggered by S3 `ObjectCreated` events on the receipts bucket. It calls Textract `detect_document_text`, classifies each line against the hard-coded `HEALTHY_ITEMS` / `UNHEALTHY_ITEMS` / `NON_FOOD_KEYWORDS` sets, computes a 0–100 `health_score = healthy / (healthy + unhealthy) * 100`, generates a fixed analysis blurb and a small `swap_map`-driven list of swap suggestions, then writes everything to DynamoDB table `ReceiptHealthAnalysis` keyed by `receipt_id`. The Python file lives in this repo but is deployed separately; editing it here does not redeploy it.
3. **Poll (Express)** — `GET /api/receipts/:receipt_id` reads the DynamoDB item. Returns `404 { status: "pending" }` if the Lambda hasn't written it yet, or `200 { status: "ready", ...item }` once it has. The frontend is expected to poll this until ready.

The DynamoDB table name `ReceiptHealthAnalysis` is hard-coded in both `backend/routes/receipts.js` and `lambda_function.py` — change both together.

### Deployment

`infra/` is a Terraform module that provisions the all-serverless hosting target: a Node Lambda fronted by API Gateway HTTP API for the Express app, plus an S3 + CloudFront site for the built frontend (`/api/*` is routed from CloudFront to API Gateway, so the frontend can keep calling `/api/...` relative URLs). See `infra/README.md` for the workflow. The Python `healthCheckReceipt` Lambda, the receipts S3 bucket, and the DynamoDB table are **not** in this Terraform — they predate it.

Backend rebuilds: `scripts/build-backend.ps1` packages `backend/` into `infra/build/backend.zip`, which the `aws_lambda_function.api` resource references via `source_code_hash`. `terraform apply` re-uploads when the zip changes.

Frontend deploys: `scripts/deploy-frontend.ps1` runs `npm run build`, syncs `frontend/dist/` to the S3 bucket Terraform created, and invalidates CloudFront.

### Classifier behavior (`lambda_function.py`)

Three keyword sets — `NON_FOOD_KEYWORDS`, `UNHEALTHY_ITEMS`, `HEALTHY_ITEMS` — are checked **in that order** so the more-specific match wins (e.g., `baking soda` is matched as non-food before `soda` would match it as unhealthy; `choc` is matched as unhealthy before `milk` would match `Milk Choc Rabbit` as healthy).

Matching uses `matches_keyword()`, which is a word-boundary regex (`\bkeyword\b`) — substring matches like `rice` inside `price` no longer trigger.

`is_item_line()` filters out receipt chrome (totals, promo banners, prices, store IDs) using `RECEIPT_NOISE_KEYWORDS` plus a length/letter-density heuristic, so noise never reaches the classifier or pollutes `unknown_items`.

Lines that match none of the three sets are stored as `unknown_items` and surface in the frontend's **Uncategorized** column — that's where to look for keywords to add.

### S3 event key decoding

S3 event payloads URL-encode the object key (spaces → `+`, etc.). `lambda_function.py` calls `urllib.parse.unquote_plus` before passing the key to Textract, otherwise filenames with spaces fail with `InvalidS3ObjectException`. The Express upload route also sanitizes `file.originalname` to `[A-Za-z0-9._-]` before building the S3 key, so the worst case is defended on both sides.

### Frontend display

`frontend/src/App.jsx` posts to `/api/process-receipt` via the Vite proxy, then polls `/api/receipts/:receipt_id` every 2s (90s timeout) until the Lambda has written the analysis. Results render in `Results` / `ScoreRing` / `ItemGroup` components defined in the same file; styling lives in `frontend/src/styles.css` (CSS variables on `:root`, no CSS framework).

The item breakdown has four columns: Healthy (green), Unhealthy (red), Non-food (gray), Uncategorized (amber, dashed). A hint message below the grid points users at `lambda_function.py` to extend the keyword sets.
