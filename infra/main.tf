terraform {
  required_version = ">= 1.6"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = var.region
}

# CloudFront managed cache/origin policies live in us-east-1 and are global.
# Keep a second provider alias for resources that must be us-east-1 if you
# later add ACM certs for a custom domain.
provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"
}

data "aws_caller_identity" "current" {}

locals {
  account_id        = data.aws_caller_identity.current.account_id
  uploads_bucket_arn = "arn:aws:s3:::${var.uploads_bucket_name}"
  ddb_table_arn      = "arn:aws:dynamodb:${var.region}:${local.account_id}:table/${var.ddb_table_name}"
}
