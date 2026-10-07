param([string]$ClientId)
$ErrorActionPreference = 'Stop'
$project = Split-Path -Parent $PSScriptRoot
if (-not $ClientId) { $ClientId = Read-Host 'Twitch app Client ID' }
if ($ClientId -notmatch '^[a-zA-Z0-9]{10,100}$') { throw 'Invalid Client ID' }
$secret = Read-Host 'Twitch app Client Secret (hidden)' -AsSecureString
$ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secret)
try { $clientSecret = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) }
finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
if (-not $clientSecret) { throw 'Client Secret is required' }
# The deploy secrets live outside the repo folder; .dev.vars (local dev only) gets its own throwaway values.
$secretDir = Join-Path $HOME '.pixfray'
New-Item -ItemType Directory -Force -Path $secretDir | Out-Null
$secretPath = Join-Path $secretDir 'secrets.json'
$values = @{}
if (Test-Path -LiteralPath $secretPath) {
  $values = Get-Content -Raw -LiteralPath $secretPath | ConvertFrom-Json -AsHashtable
}
foreach ($key in @('AUTH_SECRET', 'INTERNAL_SECRET')) {
  if (-not $values[$key]) {
    $bytes = New-Object byte[] 32
    [Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
    $values[$key] = [Convert]::ToHexString($bytes).ToLowerInvariant()
  }
}
$values.TWITCH_CLIENT_ID = $ClientId
$values.TWITCH_CLIENT_SECRET = $clientSecret
$values | ConvertTo-Json | Set-Content -LiteralPath $secretPath -Encoding utf8NoBOM
$devVars = Join-Path $project '.dev.vars'
if (-not (Test-Path -LiteralPath $devVars)) {
  $local = foreach ($key in @('AUTH_SECRET', 'INTERNAL_SECRET')) { $b = New-Object byte[] 32; [Security.Cryptography.RandomNumberGenerator]::Fill($b); $key + '=' + [Convert]::ToHexString($b).ToLowerInvariant() }
  @($local) + @('TWITCH_CLIENT_ID=local-dev-client-id', 'TWITCH_CLIENT_SECRET=local-dev-client-secret') | Set-Content -LiteralPath $devVars -Encoding utf8NoBOM
}
$clientSecret = $null
Write-Host "Saved the secrets to $secretPath. No secrets were printed."
Write-Host "Deploy from the project using: bunx cf deploy --mode test --secrets-file $secretPath"
Write-Host "After testing: bunx cf deploy --secrets-file $secretPath"
