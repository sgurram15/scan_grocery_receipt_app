variable "region" {
  description = "AWS region for all new resources."
  type        = string
  default     = "us-east-1"
}

variable "project_name" {
  description = "Prefix used when naming resources."
  type        = string
  default     = "receipt-ai"
}

variable "uploads_bucket_name" {
  description = "Existing S3 bucket the upload route PUTs receipts into. Set in terraform.tfvars."
  type        = string
}

variable "ddb_table_name" {
  description = "Existing DynamoDB table the healthCheckReceipt Lambda writes to."
  type        = string
  default     = "ReceiptHealthAnalysis"
}

variable "web_bucket_name" {
  description = "Globally-unique S3 bucket name for the built frontend."
  type        = string
}

variable "backend_zip_path" {
  description = "Path to the zipped backend Lambda bundle. Built by scripts/build-backend.ps1."
  type        = string
  default     = "build/backend.zip"
}
