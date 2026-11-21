<#
.SYNOPSIS
  Chien de garde du serveur Node À CÔTÉ du .ps1 (http://localhost:8767/, LECTURE SEULE) — lot 2b, étape 4.
.DESCRIPTION
  Lancé par la tâche planifiée « sessions-desk - Node 8767 (watchdog) » à l'ouverture de session et toutes les
  2 minutes (posée par Install-NodeWatchdog.ps1). Si /api/ping ne répond pas, ou répond 503 (boucle du serveur
  figée), il arrête le serveur figé s'il vit encore — seulement si c'est bien un serveur Node de ce port —, puis le
  relance sans fenêtre. Sorties dans <StateDir>\sessions-desk-node-<port>.{out,err}.log, relances tracées dans
  <StateDir>\sessions-desk-node-watchdog.log.

  Indépendant du watchdog du .ps1 (sessions-dashboard-watchdog.ps1, tâche « Claude - suivi sessions (watchdog) ») :
  autre tâche, autre port, autres fichiers. Lecture seule par défaut : il ne passe --allow-write au serveur que
  sous -AllowWrite (posé par Install-NodeWatchdog.ps1 -AllowWrite). Sur 8765 seulement sous -Primary (posé par
  Install-NodeWatchdog.ps1 -Primary, via Switch-SessionsDesk.ps1) : Node y prend le rôle primary de lui-même.

  Le serveur lancé est celui du dossier qui contient ce script (<racine>\server\src\main.ts) : le dossier
  d'exécution posé par Install-NodeWatchdog.ps1, ou un checkout pour les tests.
#>
param(
    [int]$Port = 8767,
    [string]$Node = '',
    [string]$StateDir = $env:TEMP,
    [switch]$AllowWrite,
    [switch]$Primary,
    # Attente maximale, après l'arrêt d'un serveur figé, que le process ait disparu ET rendu le port. Un process
    # figé peut mettre longtemps à mourir et garder ses sockets pendant ce temps. La tâche est limitée à 1 min :
    # cette attente doit y tenir avec le délai de grâce et les pings.
    [int]$StopWaitSeconds = 20
)

if ($Port -eq 8765 -and -not $Primary) { throw 'Port 8765 = production : -Primary requis (posé par Switch-SessionsDesk.ps1 -To node).' }

$root = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$main = Join-Path $root 'server\src\main.ts'
$log = Join-Path $StateDir 'sessions-desk-node-watchdog.log'
$outLog = Join-Path $StateDir "sessions-desk-node-$Port.out.log"
$errLog = Join-Path $StateDir "sessions-desk-node-$Port.err.log"
$pidFile = Join-Path $StateDir "sessions-desk-node-$Port.pid"
$ping = "http://localhost:$Port/api/ping"

function Write-Log([string]$m) { Add-Content $log "$(Get-Date -Format s) [$Port] $m" }
# Port sans écouteur : réponse immédiate. Un ping HTTP vers un port fermé coûte ~4 s sous Windows (::1 puis
# 127.0.0.1, chacun relancé) — autant de coupure en plus à chaque relance.
function Test-Listening { [bool]([Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners() | Where-Object Port -eq $Port) }
function Test-Up { if (-not (Test-Listening)) { return $false }; try { $null = Invoke-RestMethod $ping -TimeoutSec 5; $true } catch { $false } }
# Un serveur Node DE CE PORT lancé depuis n'importe quel dossier (main.ts, et --port <Port> ou port par défaut 8767).
function Test-OurServer($p) {
    if (-not $p -or $p.Name -ne 'node.exe' -or $p.CommandLine -notmatch 'server[\\/]src[\\/]main\.ts') { return $false }
    if ($p.CommandLine -match '--port\s+(\d+)') { return [int]$Matches[1] -eq $Port }
    return $Port -eq 8767
}

if (Test-Up) { return }
# Lancé par un déploiement (marqueur posé par Install-NodeWatchdog.ps1, récent) : le serveur vient d'être arrêté
# exprès, inutile d'attendre — et ce n'est pas une panne.
$marker = Join-Path $StateDir "sessions-desk-node-$Port.deploying"
$deploy = if ((Test-Path $marker) -and ((Get-Date) - (Get-Item $marker).LastWriteTime).TotalMinutes -lt 2) { "$(Get-Content $marker -Raw)".Trim() }
if ($deploy) {
    # Le marqueur reste tant que le déploiement attend son serveur (c'est lui qui le retire). Un serveur déjà lancé
    # pour ce déploiement et encore muet est en train de démarrer : on le laisse faire — l'arrêter ici rallongeait
    # la coupure. S'il reste muet, c'est le déploiement qui l'arrête et revient à la version précédente.
    $started = 0
    if ((Test-Path $pidFile) -and (Get-Item $pidFile).LastWriteTime -ge (Get-Item $marker).LastWriteTime -and
        [int]::TryParse("$(Get-Content $pidFile -Raw)".Trim(), [ref]$started) -and
        (Test-OurServer (Get-CimInstance Win32_Process -Filter "ProcessId=$started" -ErrorAction SilentlyContinue))) { return }
} else {
    Remove-Item $marker -Force -ErrorAction SilentlyContinue   # marqueur périmé d'un déploiement interrompu
    # Un démarrage peut être en cours (quelques secondes) : on recontrôle avant de relancer.
    Start-Sleep -Seconds 5
    if (Test-Up) { return }
}

if (-not (Test-Path $main)) { Write-Log "serveur absent : $main"; return }
$driver = Join-Path $root '.build\driver\sessions-desk-driver.exe'
if (-not (Test-Path $driver)) { Write-Log "pilote non compilé : $driver"; return }
if (-not $Node -or -not (Test-Path $Node)) { $Node = (Get-Command node -ErrorAction SilentlyContinue).Source }
if (-not $Node) { Write-Log 'node introuvable'; return }

# Serveur vivant mais figé : Node tient lui-même le port, une relance échouerait. Candidats : le pid noté au
# dernier lancement, et le process qui écoute sur le port (un serveur lancé à la main). Chacun n'est arrêté que si
# sa ligne de commande est bien celle d'un serveur Node de ce port.
$cands = @()
$old = 0
if ((Test-Path $pidFile) -and [int]::TryParse("$(Get-Content $pidFile -Raw)".Trim(), [ref]$old)) { $cands += $old }
# Get-NetTCPConnection coûte ~1 s : seulement si quelqu'un écoute (jamais après un arrêt de déploiement).
if (Test-Listening) { $cands += @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue | ForEach-Object OwningProcess) }
foreach ($id in ($cands | Sort-Object -Unique)) {
    $p = Get-CimInstance Win32_Process -Filter "ProcessId=$id" -ErrorAction SilentlyContinue
    if (Test-OurServer $p) {
        Write-Log "serveur figé ou muet (pid $id) => arrêt"
        # Le résultat de l'arrêt est tracé : un échec silencieux laissait croire à « un autre process » ensuite.
        $stopErr = $null
        try { Stop-Process -Id $id -Force -ErrorAction Stop } catch { $stopErr = $_.Exception.Message }
        # Attendre que le process soit parti ET qu'il ne tienne plus le port : un process figé peut être déclaré
        # introuvable alors que ses sockets d'écoute restent ouvertes, le temps que Windows le ferme.
        $sw = [Diagnostics.Stopwatch]::StartNew()
        do {
            $alive = [bool](Get-Process -Id $id -ErrorAction SilentlyContinue)
            $holds = (Test-Listening) -and (@(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue | ForEach-Object OwningProcess) -contains $id)
            if (-not $alive -and -not $holds) { break }
            Start-Sleep -Milliseconds 500
        } while ($sw.Elapsed.TotalSeconds -lt $StopWaitSeconds)
        $took = [math]::Round($sw.Elapsed.TotalSeconds, 1)
        $why = if ($stopErr) { " (Stop-Process : $stopErr)" } else { '' }
        if (-not $alive -and -not $holds) { Write-Log "pid $id arrêté, port rendu en $took s$why" }
        elseif ($alive) { Write-Log "pid $id toujours vivant après $took s$why" }
        else { Write-Log "pid $id parti mais tient encore le port $Port après $took s$why" }
    }
}
$holder = if (Test-Listening) { @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue | ForEach-Object OwningProcess) | Select-Object -First 1 }
if ($holder) {
    # Distinguer un vrai autre process d'un serveur qui n'en finit pas de mourir : le diagnostic n'est pas le même.
    if (Get-Process -Id $holder -ErrorAction SilentlyContinue) { Write-Log "port $Port tenu par un autre process (pid $holder) : pas de relance" }
    else { Write-Log "port $Port encore tenu par le pid $holder, qui n'existe plus (fermeture en cours) : pas de relance, nouvel essai au prochain passage" }
    return
}

# Garder la trace de l'erreur du serveur précédent avant qu'elle soit écrasée.
if ((Test-Path $errLog) -and (Get-Item $errLog).Length -gt 0) {
    Add-Content $log "--- stderr du serveur précédent :"
    Get-Content $errLog -Tail 20 | Add-Content $log
}
if ($deploy) { Write-Log "démarrage après déploiement de $deploy ($main$(if ($AllowWrite) { ', écriture permise' }))" }
else { Write-Log "serveur muet sur $ping => relance ($main$(if ($AllowWrite) { ', écriture permise' }))" }

$nodeArgs = @("`"$main`"", '--port', $Port) + @(if ($AllowWrite) { '--allow-write' })
$p = Start-Process $Node -WindowStyle Hidden -WorkingDirectory $root -PassThru `
    -ArgumentList $nodeArgs `
    -RedirectStandardOutput $outLog -RedirectStandardError $errLog
Set-Content $pidFile $p.Id
