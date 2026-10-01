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
$secretPath = Join-Path $project '.secrets.local.json'
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
$values.GetEnumerator() | ForEach-Object { $_.Key + '=' + $_.Value } | Set-Content -LiteralPath (Join-Path $project '.dev.vars') -Encoding utf8NoBOM
$clientSecret = $null
Write-Host 'Saved private local config. No secrets were printed.'
Write-Host 'Deploy from the project using: cf deploy --mode test --secrets-file .secrets.local.json'
Write-Host 'After testing: cf deploy --secrets-file .secrets.local.json'
