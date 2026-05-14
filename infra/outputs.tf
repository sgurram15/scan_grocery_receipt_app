output "site_url" {
  description = "Public URL — open this in a browser."
  value       = "https://${aws_cloudfront_distribution.web.domain_name}"
}

output "api_endpoint" {
  description = "Direct API Gateway URL (useful for curl). The site calls /api via CloudFront."
  value       = aws_apigatewayv2_api.api.api_endpoint
}

output "web_bucket" {
  description = "S3 bucket holding the built frontend. Sync dist/ to here."
  value       = aws_s3_bucket.web.id
}

output "cloudfront_distribution_id" {
  description = "Pass this to `aws cloudfront create-invalidation` after uploading new frontend files."
  value       = aws_cloudfront_distribution.web.id
}

output "lambda_function_name" {
  value = aws_lambda_function.api.function_name
}
