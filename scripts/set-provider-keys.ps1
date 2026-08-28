param(
    [string]$VaultPath
)

$ErrorActionPreference = "Stop"
$openAiSecure = $null
$togetherSecure = $null
$openAiPlain = $null
$togetherPlain = $null
$openAiBstr = [IntPtr]::Zero
$togetherBstr = [IntPtr]::Zero
$plainBytes = $null
$encryptedBytes = $null
$entropyBytes = $null
$temporaryPath = $null

try {
    if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
        throw "Windows is required"
    }
    if ([string]::IsNullOrWhiteSpace($VaultPath)) {
        if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
            throw "LOCALAPPDATA is unavailable"
        }
        $VaultPath = Join-Path $env:LOCALAPPDATA "ExitRamp\provider-credentials.dpapi"
    }

    if ($PSVersionTable.PSVersion.Major -lt 6) {
        Add-Type -AssemblyName System.Security
    }
    else {
        Add-Type -AssemblyName System.Security.Cryptography.ProtectedData
    }
    $openAiSecure = Read-Host "OpenAI API key" -AsSecureString
    $togetherSecure = Read-Host "Together API key" -AsSecureString
    $openAiBstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($openAiSecure)
    $openAiPlain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($openAiBstr)
    $togetherBstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($togetherSecure)
    $togetherPlain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($togetherBstr)
    if (
        [string]::IsNullOrWhiteSpace($openAiPlain) -or
        [string]::IsNullOrWhiteSpace($togetherPlain) -or
        $openAiPlain.Trim() -ne $openAiPlain -or
        $togetherPlain.Trim() -ne $togetherPlain -or
        $openAiPlain.Length -gt 4096 -or
        $togetherPlain.Length -gt 4096
    ) {
        throw "Both provider keys must be valid"
    }

    $payload = @{
        schema_version = 1
        OPENAI_API_KEY = $openAiPlain
        TOGETHER_API_KEY = $togetherPlain
    } | ConvertTo-Json -Compress
    $plainBytes = [Text.Encoding]::UTF8.GetBytes($payload)
    $entropyBytes = [Text.Encoding]::UTF8.GetBytes("ExitRamp provider credentials v1")
    $encryptedBytes = [Security.Cryptography.ProtectedData]::Protect(
        $plainBytes,
        $entropyBytes,
        [Security.Cryptography.DataProtectionScope]::CurrentUser
    )

    $vaultDirectory = Split-Path -Parent $VaultPath
    if ([string]::IsNullOrWhiteSpace($vaultDirectory)) {
        throw "Vault path must include a directory"
    }
    New-Item -ItemType Directory -Path $vaultDirectory -Force | Out-Null
    $temporaryPath = Join-Path $vaultDirectory ".$([IO.Path]::GetFileName($VaultPath)).$PID.$([guid]::NewGuid().ToString('N')).tmp"
    [IO.File]::WriteAllBytes($temporaryPath, $encryptedBytes)
    Move-Item -LiteralPath $temporaryPath -Destination $VaultPath -Force
    $temporaryPath = $null
    Write-Output "ExitRamp provider keys saved for the current Windows user."
}
catch {
    Write-Error "ExitRamp provider key setup failed."
}
finally {
    if ($null -ne $temporaryPath -and (Test-Path -LiteralPath $temporaryPath)) {
        Remove-Item -LiteralPath $temporaryPath -Force
    }
    if ($openAiBstr -ne [IntPtr]::Zero) {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($openAiBstr)
    }
    if ($togetherBstr -ne [IntPtr]::Zero) {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($togetherBstr)
    }
    foreach ($bytes in @($plainBytes, $encryptedBytes, $entropyBytes)) {
        if ($null -ne $bytes) {
            [Array]::Clear($bytes, 0, $bytes.Length)
        }
    }
    $payload = $null
    $openAiPlain = $null
    $togetherPlain = $null
    $openAiSecure = $null
    $togetherSecure = $null
}
