import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import receiptRoutes from "./routes/receipts.js";

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json());

app.use("/api", receiptRoutes);

export default app;
