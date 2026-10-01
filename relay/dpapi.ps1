param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('Protect', 'Unprotect')]
  [string]$Mode
)

# Windows DPAPI (CurrentUser scope) through .NET only, so it works even when PSModulePath points at
# PowerShell 7 modules that Windows PowerShell cannot load. stdin -> stdout, nothing is logged.
# Protect: UTF-8 bytes in, base64 out. Unprotect: base64 in, UTF-8 bytes out.
$ErrorActionPreference = 'Stop'
[void][Reflection.Assembly]::Load('System.Security, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b03f5f7f11d50a3a')
$entropy = [Text.Encoding]::UTF8.GetBytes('mini-chat-relay-v2')
$scope = [Security.Cryptography.DataProtectionScope]::CurrentUser

$buffer = [IO.MemoryStream]::new()
[Console]::OpenStandardInput().CopyTo($buffer)
$inputBytes = $buffer.ToArray()
$stdout = [Console]::OpenStandardOutput()

if ($Mode -eq 'Protect') {
  $sealed = [Security.Cryptography.ProtectedData]::Protect($inputBytes, $entropy, $scope)
  $text = [Text.Encoding]::ASCII.GetBytes([Convert]::ToBase64String($sealed))
  $stdout.Write($text, 0, $text.Length)
} else {
  $encoded = [Text.Encoding]::ASCII.GetString($inputBytes).Trim()
  $plain = [Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($encoded), $entropy, $scope)
  $stdout.Write($plain, 0, $plain.Length)
  [Array]::Clear($plain, 0, $plain.Length)
}
$stdout.Flush()
exit 0
