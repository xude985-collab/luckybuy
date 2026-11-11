$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$backupLog = Join-Path $projectRoot '本地恢复资料\数据库备份\daily-backup.log'
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $backupLog) | Out-Null
Push-Location $projectRoot
try {
  & node (Join-Path $PSScriptRoot 'backup-database.mjs') 2>&1 | Out-File -LiteralPath $backupLog -Append -Encoding utf8
  if ($LASTEXITCODE -ne 0) { throw 'Database backup failed; inspect the private log.' }
} finally { Pop-Location }

