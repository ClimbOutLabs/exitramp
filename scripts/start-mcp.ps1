param(
    [string]$VaultPath,
    [ValidateRange(1, 65535)]
    [int]$Port = 8788,
    [string]$EvidenceDirectory
)

$ErrorActionPreference = "Stop"
$encryptedBytes = $null
$plainBytes = $null
$entropyBytes = $null
$payload = $null
$openAiKey = $null
$togetherKey = $null
$locationPushed = $false
$originalOpenAi = [Environment]::GetEnvironmentVariable("OPENAI_API_KEY", "Process")
$originalTogether = [Environment]::GetEnvironmentVariable("TOGETHER_API_KEY", "Process")
$originalPort = [Environment]::GetEnvironmentVariable("PORT", "Process")
$originalEvidenceDirectory = [Environment]::GetEnvironmentVariable("EXITRAMP_EVIDENCE_DIR", "Process")

function Restore-ProcessEnvironment([string]$Name, [AllowNull()][string]$Value) {
    [Environment]::SetEnvironmentVariable($Name, $Value, "Process")
}

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
    if (-not (Test-Path -LiteralPath $VaultPath -PathType Leaf)) {
        throw "Credential vault is missing"
    }

    if ($PSVersionTable.PSVersion.Major -lt 6) {
        Add-Type -AssemblyName System.Security
    }
    else {
        Add-Type -AssemblyName System.Security.Cryptography.ProtectedData
    }
    $encryptedBytes = [IO.File]::ReadAllBytes($VaultPath)
    $entropyBytes = [Text.Encoding]::UTF8.GetBytes("ExitRamp provider credentials v1")
    $plainBytes = [Security.Cryptography.ProtectedData]::Unprotect(
        $encryptedBytes,
        $entropyBytes,
        [Security.Cryptography.DataProtectionScope]::CurrentUser
    )
    $payload = [Text.Encoding]::UTF8.GetString($plainBytes) | ConvertFrom-Json
    $openAiKey = [string]$payload.OPENAI_API_KEY
    $togetherKey = [string]$payload.TOGETHER_API_KEY
    if (
        $payload.schema_version -ne 1 -or
        [string]::IsNullOrWhiteSpace($openAiKey) -or
        [string]::IsNullOrWhiteSpace($togetherKey) -or
        $openAiKey.Trim() -ne $openAiKey -or
        $togetherKey.Trim() -ne $togetherKey -or
        $openAiKey.Length -gt 4096 -or
        $togetherKey.Length -gt 4096
    ) {
        throw "Credential vault is invalid"
    }

    [Environment]::SetEnvironmentVariable("OPENAI_API_KEY", $openAiKey, "Process")
    [Environment]::SetEnvironmentVariable("TOGETHER_API_KEY", $togetherKey, "Process")
    [Environment]::SetEnvironmentVariable("PORT", [string]$Port, "Process")
    if (-not [string]::IsNullOrWhiteSpace($EvidenceDirectory)) {
        [Environment]::SetEnvironmentVariable("EXITRAMP_EVIDENCE_DIR", $EvidenceDirectory, "Process")
    }

    $repoRoot = Split-Path -Parent $PSScriptRoot
    $serverPath = Join-Path $repoRoot "dist\src\mcp\server.js"
    if (-not (Test-Path -LiteralPath $serverPath -PathType Leaf)) {
        throw "Build output is missing"
    }
    Push-Location $repoRoot
    $locationPushed = $true
    & node $serverPath
    if ($LASTEXITCODE -ne 0) {
        throw "ExitRamp MCP server stopped with an error"
    }
}
catch {
    Write-Error "ExitRamp MCP server could not start. Run pnpm build and confirm the encrypted provider-key vault exists."
}
finally {
    if ($locationPushed) {
        Pop-Location
    }
    Restore-ProcessEnvironment "OPENAI_API_KEY" $originalOpenAi
    Restore-ProcessEnvironment "TOGETHER_API_KEY" $originalTogether
    Restore-ProcessEnvironment "PORT" $originalPort
    Restore-ProcessEnvironment "EXITRAMP_EVIDENCE_DIR" $originalEvidenceDirectory
    foreach ($bytes in @($plainBytes, $encryptedBytes, $entropyBytes)) {
        if ($null -ne $bytes) {
            [Array]::Clear($bytes, 0, $bytes.Length)
        }
    }
    $payload = $null
    $openAiKey = $null
    $togetherKey = $null
}
