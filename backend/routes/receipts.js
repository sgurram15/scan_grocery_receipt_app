import express from "express";
import multer from "multer";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

const s3 = new S3Client({ region: process.env.AWS_REGION });
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: process.env.AWS_REGION }));

const TABLE_NAME = "ReceiptHealthAnalysis";

// Upload to S3. The healthCheckReceipt Lambda is triggered by the S3 event,
// runs Textract + classification, and writes results to DynamoDB.
router.post("/process-receipt", upload.single("file"), async (req, res) => {
  try {
    const file = req.file;
    if (!file) return res.status(400).send("No file uploaded");

    const safeName = file.originalname.replace(/[^A-Za-z0-9._-]+/g, "_");
    const key = `receipts/${Date.now()}-${safeName}`;

    await s3.send(
      new PutObjectCommand({
        Bucket: process.env.BUCKET_NAME,
        Key: key,
        Body: file.buffer,
        ContentType: file.mimetype,
      })
    );

    // Lambda derives receipt_id by replacing "/" with "_"
    const receipt_id = key.replace(/\//g, "_");

    res.json({ receipt_id, s3_key: key });
  } catch (err) {
    console.error(err);
    res.status(500).send(err.message);
  }
});

// Lightweight list of all analyzed receipts, newest first.
router.get("/receipts", async (req, res) => {
  try {
    const out = await ddb.send(
      new ScanCommand({
        TableName: TABLE_NAME,
        ProjectionExpression: "receipt_id, uploaded_at, health_score",
      })
    );
    const items = (out.Items ?? []).sort((a, b) =>
      String(b.uploaded_at ?? "").localeCompare(String(a.uploaded_at ?? ""))
    );
    res.json({ items });
  } catch (err) {
    console.error(err);
    res.status(500).send(err.message);
  }
});

// Frontend polls this until the Lambda has written the analysis.
router.get("/receipts/:receipt_id", async (req, res) => {
  try {
    const { receipt_id } = req.params;
    const out = await ddb.send(
      new GetCommand({ TableName: TABLE_NAME, Key: { receipt_id } })
    );
    // Always return 200 — CloudFront treats 4xx from the origin as an SPA
    // fallback and rewrites the response body to index.html.
    if (!out.Item) return res.json({ status: "pending", receipt_id });
    res.json({ status: "ready", ...out.Item });
  } catch (err) {
    console.error(err);
    res.status(500).send(err.message);
  }
});

export default router;
