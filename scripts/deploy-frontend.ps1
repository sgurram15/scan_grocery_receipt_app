# Builds the frontend and pushes it to the S3 bucket Terraform created,
# then invalidates the CloudFront distribution.
$ErrorActionPreference = "Stop"

$repo = Split-Path -Parent $PSScriptRoot
$infra = Join-Path $repo "infra"

Push-Location (Join-Path $repo "frontend")
try {
  npm.cmd install | Out-Host
  npm.cmd run build | Out-Host
} finally {
  Pop-Location
}

Push-Location $infra
try {
  $bucket = (terraform output -raw web_bucket)
  $distId = (terraform output -raw cloudfront_distribution_id)
} finally {
  Pop-Location
}

$dist = Join-Path $repo "frontend\dist"
Write-Output "Syncing $dist to s3://$bucket/"
aws s3 sync $dist "s3://$bucket/" --delete | Out-Host

Write-Output "Invalidating CloudFront $distId"
aws cloudfront create-invalidation --distribution-id $distId --paths "/*" | Out-Host

Push-Location $infra
try {
  $siteUrl = (terraform output -raw site_url)
} finally {
  Pop-Location
}

Write-Output ""
Write-Output "Deployed: $siteUrl"
