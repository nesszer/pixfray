param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('Protect', 'Unprotect')]
  [string]$Mode
)

$ErrorActionPreference = 'Stop'
$plainText = [Console]::In.ReadToEnd()

if ($Mode -eq 'Protect') {
  $secure = ConvertTo-SecureString -String $plainText -AsPlainText -Force
  $protected = ConvertFrom-SecureString -SecureString $secure
  [Console]::Out.WriteLine($protected)
  exit 0
}

$secureValue = ConvertTo-SecureString -String $plainText
$pointer = [IntPtr]::Zero
try {
  $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureValue)
  [Console]::Out.Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer))
}
finally {
  if ($pointer -ne [IntPtr]::Zero) {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
  }
}
