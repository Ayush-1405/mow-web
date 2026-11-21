# Stores a new Claude (Anthropic) API key as the Supabase secret ANTHROPIC_API_KEY, without showing it on screen,
# putting it in chat, or saving it in the repository. Run it yourself: right-click > Run with PowerShell, or
#   powershell -ExecutionPolicy Bypass -File scripts\set-claude-key.ps1
# Then press "Run health check" in the Mood AI Control Center.
$ErrorActionPreference = "Stop"
$project = "bykmyttaesuyjwvtnxks"
Write-Host ""
Write-Host "1) Create a key at https://console.anthropic.com/settings/keys (and check the account has credit/billing)."
Write-Host "2) Paste it below (it stays hidden), then press Enter."
$secure = Read-Host "Claude API key" -AsSecureString
$key = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
$key = $key.Trim()
if ($key -notmatch '^sk-ant-[A-Za-z0-9_\-]{20,}$') { Write-Host "That does not look like a Claude API key (it starts with sk-ant-). Nothing changed."; pause; exit 1 }

# quick check with Anthropic before saving (lists models; costs nothing)
try {
  $r = Invoke-WebRequest -UseBasicParsing -Uri "https://api.anthropic.com/v1/models?limit=1" -Headers @{ "x-api-key" = $key; "anthropic-version" = "2023-06-01" }
  Write-Host "Anthropic accepted the key."
} catch {
  $code = $_.Exception.Response.StatusCode.value__
  Write-Host "Anthropic rejected this key (HTTP $code). Nothing changed. Check the key and the account's billing."; pause; exit 1
}

# store it as a Supabase secret through a temporary file that is deleted straight away
$tmp = Join-Path $env:TEMP ("mai-key-" + [guid]::NewGuid().ToString("N") + ".env")
try {
  Set-Content -Path $tmp -Value "ANTHROPIC_API_KEY=$key" -Encoding ascii -NoNewline
  Push-Location (Join-Path $PSScriptRoot "..\backend")
  npx.cmd supabase secrets set --env-file $tmp --project-ref $project
  Pop-Location
  Write-Host ""
  Write-Host "Saved. The AI functions pick it up on their next request. Now press 'Run health check' in the Mood AI Control Center."
} finally {
  if (Test-Path $tmp) { Remove-Item $tmp -Force }
  $key = $null
}
pause
