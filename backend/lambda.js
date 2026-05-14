import serverless from "serverless-http";
import app from "./app.js";

export const handler = serverless(app, {
  binary: [
    "application/pdf",
    "image/*",
    "multipart/form-data",
    "application/octet-stream",
  ],
});
