# Vantage deploy — run from the Windows machine that holds D:\vantage and D:\stock-videos.
# Usage: .\deploy.ps1 -HostName "1.2.3.4" -Key "C:\path\to\key.pem"
# Requires: ssh/scp available (OpenSSH). Node >= 22.5 on the VM.

param(
  [Parameter(Mandatory = $true)][string]$HostName,
  [Parameter(Mandatory = $true)][string]$Key,
  [string]$User = "azureuser",
  [int]$Port = 8080
)

$ErrorActionPreference = "Stop"
$remote = "$User@$HostName"
$ssh = "ssh -i `"$Key`" -o StrictHostKeyChecking=no -o ConnectTimeout=15 $remote"
$scp = "scp -i `"$Key`" -o StrictHostKeyChecking=no"

function Invoke-Remote([string]$cmd) {
  & ssh -i $Key -o StrictHostKeyChecking=no -o ConnectTimeout=15 "$User@$HostName" $cmd
}
function Invoke-Scp($src, $dst) {
  & scp -i $Key -o StrictHostKeyChecking=no "$src" "$User@$HostName`:$dst"
}

Write-Host "==> Node version check"
Invoke-Remote "node --version; node -e `"try{require('node:sqlite');console.log('sqlite-ok')}catch(e){console.log('NO-SQLITE:'+e.message);process.exit(1)}`"" | Out-Host

Write-Host "==> Preparing remote dir"
Invoke-Remote "mkdir -p /home/$User/vantage/public /home/$User/stock-videos"

Write-Host "==> Uploading app"
foreach ($f in @("server.js", "db.js", "auth.js", "media.js", "seed.js", "package.json")) {
  Invoke-Scp "D:\vantage\$f" "/home/$User/vantage/"
}
foreach ($f in @("index.html", "styles.css", "app.js")) {
  Invoke-Scp "D:\vantage\public\$f" "/home/$User/vantage/public/"
}

Write-Host "==> Uploading stock clips (if any missing)"
$local = Get-ChildItem "D:\stock-videos\*.mp4"
foreach ($v in $local) {
  Invoke-Remote "test -f /home/$User/stock-videos/$($v.Name) || echo MISSING" | Out-Null
  $missing = Invoke-Remote "test -f /home/$User/stock-videos/$($v.Name) && echo ok || echo no"
  if ($missing -match "no") {
    Write-Host "    uploading $($v.Name)"
    Invoke-Scp $v.FullName "/home/$User/stock-videos/"
  }
}

Write-Host "==> Seeding (idempotent)"
Invoke-Remote "cd /home/$User/vantage && STOCK_DIR=/home/$User/stock-videos VANTAGE_DATA=/home/$User/vantage/data node seed.js" | Out-Host

Write-Host "==> Installing service"
Invoke-Scp "D:\vantage\deploy\vantage.service" "/tmp/vantage.service"
Invoke-Remote "sudo cp /tmp/vantage.service /etc/systemd/system/vantage.service && sudo systemctl daemon-reload && sudo systemctl enable vantage"
Invoke-Remote "sudo systemctl restart vantage"
Start-Sleep 2

Write-Host "==> Verifying"
Invoke-Remote "sudo systemctl is-active vantage; curl -s http://127.0.0.1:$Port/api/health" | Out-Host

Write-Host "==> Port check (public IP)"
$pub = Invoke-Remote "curl -s -H 'Host: health' http://127.0.0.1:$Port/api/health"
if ($pub -match 'vantage') { Write-Host "    local OK" }

Write-Host "Done. Suite: cd D:\streamforge; VB=http://$HostName`:$Port node vantage-agg.cjs"
