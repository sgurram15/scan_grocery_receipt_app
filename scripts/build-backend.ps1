# Bundles backend/ into infra/build/backend.zip for the Lambda.
# Installs production deps in a clean staging dir so dev deps (nodemon) don't ship.
$ErrorActionPreference = "Stop"

$repo  = Split-Path -Parent $PSScriptRoot
$stage = Join-Path $repo "infra\build\backend-stage"
$out   = Join-Path $repo "infra\build\backend.zip"

if (Test-Path $stage) { Remove-Item -Recurse -Force $stage }
New-Item -ItemType Directory -Path $stage | Out-Null

# Copy source (everything but node_modules + .env)
$src = Join-Path $repo "backend"
Copy-Item "$src\app.js"        $stage
Copy-Item "$src\server.js"     $stage
Copy-Item "$src\lambda.js"     $stage
Copy-Item "$src\package.json"  $stage
Copy-Item "$src\package-lock.json" $stage -ErrorAction SilentlyContinue
Copy-Item "$src\routes"   $stage -Recurse
Copy-Item "$src\services" $stage -Recurse

# Install production deps inside the staging dir.
Push-Location $stage
try {
  npm.cmd install --omit=dev --ignore-scripts | Out-Host
} finally {
  Pop-Location
}

# Drop dotfiles and anything obviously unwanted.
Get-ChildItem -Path $stage -Recurse -Force -Include ".env", "*.log" -ErrorAction SilentlyContinue |
  Remove-Item -Force -ErrorAction SilentlyContinue

if (Test-Path $out) { Remove-Item -Force $out }
Compress-Archive -Path "$stage\*" -DestinationPath $out -Force

Write-Output "Built $out ($([math]::Round((Get-Item $out).Length / 1KB)) KB)"
