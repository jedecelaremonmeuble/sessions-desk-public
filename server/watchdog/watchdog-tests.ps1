<#
.SYNOPSIS
  Tests du watchdog du serveur Node (sessions-desk-node-watchdog.ps1), sur un PROFIL FACTICE et un port de test.
.DESCRIPTION
  USERPROFILE, LOCALAPPDATA et TEMP pointent vers un dossier temporaire : rien du vrai ~/.claude n'est lu ni écrit,
  aucune tâche planifiée n'est posée, ni le .ps1 de production ni son watchdog ne sont touchés. Le pilote doit être
  compilé (npm run build:driver). Couvre : démarrage, rien à faire quand il répond, relance après plantage (kill),
  serveur FIGÉ (port tenu, pas de réponse) arrêté puis relancé, port tenu par un AUTRE process laissé tranquille,
  refus de 8765, lecture seule par défaut (whoami.write = false) et écriture seulement sous -AllowWrite.
#>
param([int]$TestPort = 8841)
$ErrorActionPreference = 'Stop'

$root = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$wd = Join-Path $PSScriptRoot 'sessions-desk-node-watchdog.ps1'
$node = (Get-Command node).Source
$fake = Join-Path ([IO.Path]::GetTempPath()) "sd-node-watchdog-$PID"
$fake = (New-Item -ItemType Directory -Force $fake).FullName
foreach ($d in '.claude\sessions', '.claude\state', 'AppData\Local', 'tmp') { New-Item -ItemType Directory -Force (Join-Path $fake $d) | Out-Null }
$realLocalAppData = $env:LOCALAPPDATA
$env:USERPROFILE = $fake;$env:LOCALAPPDATA = Join-Path $fake 'AppData\Local'; $env:TEMP = Join-Path $fake 'tmp'; $env:TMP = $env:TEMP
$state = $env:TEMP
$log = Join-Path $state 'sessions-desk-node-watchdog.log'
$pidFile = Join-Path $state "sessions-desk-node-$TestPort.pid"

$script:fail = 0; $script:started = [Collections.Generic.List[int]]::new()
function Check([string]$name, [bool]$ok, [string]$detail = '') {
    if ($ok) { Write-Host "ok   $name" } else { $script:fail++; Write-Host "FAIL $name $detail" }
}
function Ping { try { $null = Invoke-RestMethod "http://localhost:$TestPort/api/ping" -TimeoutSec 3; $true } catch { $false } }
function WaitUp([int]$s = 30) { for ($i = 0; $i -lt $s * 2; $i++) { if (Ping) { return $true }; Start-Sleep -Milliseconds 500 }; $false }
function Holder { @(Get-NetTCPConnection -State Listen -LocalPort $TestPort -ErrorAction SilentlyContinue | ForEach-Object OwningProcess) | Select-Object -First 1 }
function RunWd([switch]$AllowWrite) { & $wd -Port $TestPort -Node $node -StateDir $state -AllowWrite:$AllowWrite; if (Test-Path $pidFile) { $script:started.Add([int](Get-Content $pidFile -Raw).Trim()) } }
function LogLines { if (Test-Path $log) { @(Get-Content $log).Count } else { 0 } }

try {
    # 0. Chemin de pwsh écrit dans la tâche : jamais le dossier versionné du Store (il disparaît à la mise à jour).
    . (Join-Path $PSScriptRoot 'Resolve-StablePwsh.ps1')
    $la = Join-Path $fake 'la'; $apps = Join-Path $la 'Microsoft\WindowsApps'
    $ver = 'C:\Program Files\WindowsApps\Microsoft.PowerShell_7.7.0.0_x64__8wekyb3d8bbwe\pwsh.exe'
    $r = $null; try { $r = Resolve-StablePwsh $ver -LocalAppData $la } catch {}
    Check 'pwsh : versionné sans alias => refus' ($null -eq $r) "$r"
    New-Item -ItemType Directory -Force $apps | Out-Null; Set-Content (Join-Path $apps 'pwsh.exe') ''
    Check 'pwsh : versionné => alias générique à défaut' ((Resolve-StablePwsh $ver -LocalAppData $la) -eq (Join-Path $apps 'pwsh.exe'))
    New-Item -ItemType Directory -Force "$apps\Microsoft.PowerShell_8wekyb3d8bbwe" | Out-Null; Set-Content "$apps\Microsoft.PowerShell_8wekyb3d8bbwe\pwsh.exe" ''
    Check 'pwsh : versionné => alias de la famille (comme la tâche du .ps1)' ((Resolve-StablePwsh $ver -LocalAppData $la) -eq "$apps\Microsoft.PowerShell_8wekyb3d8bbwe\pwsh.exe")
    $prev = 'C:\Program Files\WindowsApps\Microsoft.PowerShellPreview_7.8.0.0_arm64__8wekyb3d8bbwe\pwsh.exe'
    Check 'pwsh : Preview => sa propre famille, sinon générique' ((Resolve-StablePwsh $prev -LocalAppData $la) -eq (Join-Path $apps 'pwsh.exe'))
    Check 'pwsh : hors Store => inchangé' ((Resolve-StablePwsh 'C:\Program Files\PowerShell\7\pwsh.exe' -LocalAppData $la) -eq 'C:\Program Files\PowerShell\7\pwsh.exe')
    # Le pwsh qui exécute ce test, avec le VRAI %LOCALAPPDATA% : jamais un chemin versionné, et un fichier qui existe.
    $real = Resolve-StablePwsh (Get-Process -Id $PID).Path -LocalAppData $realLocalAppData
    Check "pwsh : celui de ce test => $real" ($real -notmatch '\\Program Files\\WindowsApps\\' -and (Test-Path -LiteralPath $real))
}
finally {}
try {
    # 1. Démarrage
    RunWd
    Check 'démarrage : le serveur répond' (WaitUp)
    $pid1 = [int](Get-Content $pidFile -Raw).Trim()
    Check 'démarrage : pid noté = process qui écoute' ((Holder) -eq $pid1) "pid $pid1, écoute $(Holder)"
    $w = Invoke-RestMethod "http://localhost:$TestPort/api/whoami"
    Check 'lecture seule (whoami.write = false)' (-not $w.write)
    $cl = (Get-CimInstance Win32_Process -Filter "ProcessId=$pid1").CommandLine
    Check 'sans -AllowWrite : jamais --allow-write' ($cl -notmatch 'allow-write') $cl

    # 2. Il répond : rien à faire
    $n = LogLines; RunWd
    Check 'serveur vivant : pas de relance' ((Holder) -eq $pid1 -and (LogLines) -eq $n)

    # 3. Plantage
    Stop-Process -Id $pid1 -Force; Start-Sleep 1
    $t0 = Get-Date; RunWd; $tookCrash = ((Get-Date) - $t0).TotalSeconds
    Check 'après kill : relancé' (WaitUp)
    $pid2 = [int](Get-Content $pidFile -Raw).Trim()
    Check 'après kill : nouveau process' ($pid2 -ne $pid1 -and (Holder) -eq $pid2)
    Check 'après kill : relance tracée' ((Get-Content $log -Raw) -match 'relance')

    # 3 bis. Démarrage commandé par un déploiement (marqueur d'Install-NodeWatchdog.ps1) : sans délai de grâce, et
    #        tracé comme un déploiement, pas comme une panne.
    Stop-Process -Id $pid2 -Force; Start-Sleep 1
    $marker = Join-Path $state "sessions-desk-node-$TestPort.deploying"
    Set-Content $marker 'abc1234567'
    $n = LogLines; $t0 = Get-Date; RunWd; $took = ((Get-Date) - $t0).TotalSeconds
    Check 'déploiement : relancé' (WaitUp)
    $pid2 = [int](Get-Content $pidFile -Raw).Trim()
    $added = @(Get-Content $log | Select-Object -Skip $n) -join "`n"
    Check 'déploiement : tracé comme tel' ($added -match 'démarrage après déploiement de abc1234567' -and $added -notmatch 'serveur muet') $added
    Check 'déploiement : pas de délai de grâce (5 s de moins que la relance après plantage)' ($took -lt $tookCrash - 3) "$took s contre $tookCrash s"
    Check 'déploiement : marqueur gardé (retiré par le déploiement, pas par le watchdog)' (Test-Path $marker)
    Remove-Item $marker -Force

    # 4. Serveur FIGÉ : un process dont la ligne de commande est celle du serveur, qui tient le port sans répondre.
    Stop-Process -Id $pid2 -Force; Start-Sleep 1
    $hang = "require('http').createServer(()=>{}).listen($TestPort,'127.0.0.1');require('http').createServer(()=>{}).listen($TestPort,'::1')"
    $h = Start-Process $node -WindowStyle Hidden -PassThru -ArgumentList '-e', "`"$hang`"", 'server/src/main.ts', '--port', $TestPort
    $script:started.Add($h.Id)
    for ($i = 0; $i -lt 20 -and -not (Holder); $i++) { Start-Sleep -Milliseconds 250 }
    Check 'figé : le faux serveur tient le port' ((Holder) -eq $h.Id)
    # 4 a. Le même, lancé pour un déploiement qui l'attend encore (marqueur récent, pid noté après lui) : il démarre,
    #      on n'y touche pas. Marqueur périmé (déploiement interrompu) : plus de protection, et il est retiré.
    Set-Content $marker 'abc1234567'; Set-Content $pidFile $h.Id
    $n = LogLines; RunWd
    Check 'déploiement en attente : serveur encore muet laissé en vie, rien de tracé' ([bool](Get-Process -Id $h.Id -ErrorAction SilentlyContinue) -and (LogLines) -eq $n)
    (Get-Item $marker).LastWriteTime = (Get-Date).AddMinutes(-3)
    RunWd
    Check 'marqueur périmé : retiré' (-not (Test-Path $marker))
    Check 'figé : arrêté' (-not (Get-Process -Id $h.Id -ErrorAction SilentlyContinue))
    Check 'figé : vrai serveur relancé' (WaitUp)
    Check 'figé : arrêt tracé' ((Get-Content $log -Raw) -match "serveur figé ou muet \(pid $($h.Id)\)")
    Check 'figé : issue de l''arrêt tracée (process parti, port rendu)' ((Get-Content $log -Raw) -match "pid $($h.Id) arrêté, port rendu en [\d.,]+ s")
    Stop-Process -Id ([int](Get-Content $pidFile -Raw).Trim()) -Force; Start-Sleep 1

    # 5. Port tenu par un AUTRE process (pas un serveur Node de ce port) : ni arrêté, ni relance.
    $o = Start-Process $node -WindowStyle Hidden -PassThru -ArgumentList '-e', "`"$hang`""
    $script:started.Add($o.Id)
    for ($i = 0; $i -lt 20 -and -not (Holder); $i++) { Start-Sleep -Milliseconds 250 }
    RunWd
    Check 'autre process : laissé en vie' ([bool](Get-Process -Id $o.Id -ErrorAction SilentlyContinue))
    Check 'autre process : refus tracé' ((Get-Content $log -Raw) -match 'tenu par un autre process')
    Stop-Process -Id $o.Id -Force

    # 6. -AllowWrite : le serveur relancé écrit (whoami.write = true, --allow-write sur la ligne de commande).
    RunWd -AllowWrite
    Check '-AllowWrite : relancé' (WaitUp)
    $pidW = [int](Get-Content $pidFile -Raw).Trim()
    Check '-AllowWrite : whoami.write = true' ([bool](Invoke-RestMethod "http://localhost:$TestPort/api/whoami").write)
    $clW = (Get-CimInstance Win32_Process -Filter "ProcessId=$pidW").CommandLine
    Check '-AllowWrite : --allow-write passé' ($clW -match '--allow-write') $clW
    Check '-AllowWrite : relance tracée' ((Get-Content $log -Raw) -match 'écriture permise')
    Stop-Process -Id $pidW -Force; Start-Sleep 1

    # 7. 8765 refusé sans -Primary (la bascule passe par Switch-SessionsDesk.ps1), au watchdog comme à l'installeur ;
    #    -Primary refusé hors 8765. Tous ces refus tombent AVANT toute action (rien n'est arrêté ni posé).
    $refused = $false; try { & $wd -Port 8765 -Node $node -StateDir $state } catch { $refused = $_.Exception.Message -match '-Primary requis' }
    Check '8765 refusé sans -Primary (watchdog)' $refused
    $inst = Join-Path $PSScriptRoot 'Install-NodeWatchdog.ps1'
    $refused = $false; try { & $inst -Port 8765 } catch { $refused = $_.Exception.Message -match '-Primary requis' }
    Check '8765 refusé sans -Primary (installeur)' $refused
    $refused = $false; try { & $inst -Port $TestPort -Primary } catch { $refused = $_.Exception.Message -match '8765 seulement' }
    Check '-Primary refusé hors 8765 (installeur)' $refused
}
finally {
    foreach ($id in $script:started) { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue }
    Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match "--port\s+$TestPort\b" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Start-Sleep 1
    Remove-Item $fake -Recurse -Force -ErrorAction SilentlyContinue
}
if ($script:fail) { Write-Host "$script:fail échec(s)"; exit 1 }
Write-Host 'watchdog Node : tout est vert'
