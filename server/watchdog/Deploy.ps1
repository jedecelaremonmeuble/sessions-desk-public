<#
.SYNOPSIS
  Met à jour l'installation du poste depuis ce clone : le serveur Node de production (8765), l'étiqueteur de tags,
  le surveillant des réponses Teams et les scripts d'accompagnement.

.DESCRIPTION
  1. refuse de partir si le clone a des modifications non commitées ou si le commit n'est sur aucune branche distante :
     ce qui tourne sur le poste doit pouvoir être retrouvé ;
  2. copie vers -Target (~/.claude/scripts) l'étiqueteur (session-tagger/), le surveillant Teams (teams-watcher/) et
     restart-idle-sessions.ps1, et pose leurs tâches planifiées si elles n'existent pas encore ;
  3. réinstalle le serveur Node de production par Install-NodeWatchdog.ps1 -Port 8765 -Primary — SAUF si, depuis le
     commit en service (DEPLOYED.txt de sa copie), seule la page a changé : la page est alors remplacée dans la copie,
     le serveur continue de tourner (aucune coupure) et les pages ouvertes se rechargent seules. Décision :
     Deploy-Plan.ps1.

  Un seul déploiement à la fois : un second attend la fin du premier, puis repart du commit alors en service (souvent
  il n'a plus que la page à remplacer, ou rien). Refuse de déployer un commit plus ANCIEN que celui en service (clone
  en retard), sauf -Rollback. Chaque déploiement est tracé dans %TEMP%\sessions-desk-node-watchdog.log : commit,
  page à chaud ou redémarrage, arrêt propre ou forcé, durée de la coupure.

  -SkipServer : les étapes 1 et 2 seulement (le serveur n'est ni arrêté ni relancé).
  -Restart    : redémarre le serveur même si seule la page a changé.
  -Rollback   : accepte de remettre en service un commit plus ancien que celui qui tourne.
  -Force      : déploie même si la préparation a traîné (sans lui, un poste saturé fait renoncer avant la coupure).

  Un redémarrage dont le nouveau serveur reste muet revient de lui-même à la version précédente et sort en échec
  (Install-NodeWatchdog.ps1).

.EXAMPLE
  pwsh -NoProfile -File server/watchdog/Deploy.ps1
#>
param([string]$Target = (Join-Path $env:USERPROFILE '.claude\scripts'), [switch]$SkipServer, [switch]$Restart, [switch]$Rollback, [switch]$Force)
$ErrorActionPreference = 'Stop'

$repo = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$top = git -C $repo rev-parse --show-toplevel 2>$null
if ($LASTEXITCODE -or -not $top) { throw "Deploy.ps1 se lance depuis un clone du dépôt, pas depuis $PSScriptRoot." }
$dirty = git -C $repo status --porcelain
if ($dirty) { throw "déploiement refusé : modifications non commitées dans le clone :`n$($dirty -join "`n")" }
$head = git -C $repo rev-parse HEAD
if (-not (git -C $repo branch -r --contains $head)) { throw "déploiement refusé : le commit $($head.Substring(0, 10)) n'est sur aucune branche distante (git push d'abord)." }
$branch = git -C $repo rev-parse --abbrev-ref HEAD

. (Join-Path $PSScriptRoot 'Deploy-Plan.ps1')
$short = $head.Substring(0, 10)
$lock = Enter-DeployLock 8765 "Deploy.ps1 $short ($branch)"
try {

$nodeExe = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $nodeExe) { throw 'node introuvable dans le PATH.' }
$src = Join-Path $repo 'server\src'
# Scripts d'accompagnement : legacy/ tant que le serveur historique est dans le dépôt, sinon server/scripts/.
$scripts = if (Test-Path (Join-Path $repo 'legacy')) { Join-Path $repo 'legacy' } else { Join-Path $repo 'server\scripts' }
$null = New-Item -ItemType Directory -Force $Target

function Register-HiddenNodeTask([string]$Name, [string]$Script, [int]$EveryMinutes, [int]$LimitMinutes, [string]$Description) {
    if (Get-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue) { return }
    # conhost --headless : aucune fenêtre ne s'ouvre à chaque passe.
    $act = New-ScheduledTaskAction -Execute 'conhost.exe' -Argument "--headless `"$nodeExe`" `"$Script`"" -WorkingDirectory (Split-Path $Script -Parent)
    $trg = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes $EveryMinutes)
    $set = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes $LimitMinutes) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
    $null = Register-ScheduledTask -TaskName $Name -Action $act -Trigger $trg -Settings $set -Description $Description
    Write-Host "Tâche « $Name » créée (toutes les $EveryMinutes min)." -ForegroundColor Green
}

# Étiqueteur des sessions : fichier autonome ; ses règles sont la section `tagger` du fichier de configuration du poste.
$tTag = Join-Path $Target 'session-tagger'; $null = New-Item -ItemType Directory -Force $tTag
Copy-Item (Join-Path $src 'tagger.ts') (Join-Path $tTag 'tagger.ts') -Force
Remove-Item (Join-Path $tTag 'tagger-config.json') -Force -ErrorAction SilentlyContinue   # ancien fichier de règles, plus lu
Register-HiddenNodeTask 'Claude - étiqueteur des sessions' (Join-Path $tTag 'tagger.ts') 5 30 'Tags des sessions Claude Code (sessions-desk) : ~/.claude/state/session-tags'

# Surveillant des réponses Teams : fichier autonome, hook ajouté une fois à ~/.claude/settings.json. La passe ne lit
# rien tant que « login » n'a pas été fait.
$tTw = Join-Path $Target 'teams-watcher'; $null = New-Item -ItemType Directory -Force $tTw
Copy-Item (Join-Path $src 'teams-watcher.ts') (Join-Path $tTw 'teams-watcher.ts') -Force
& $nodeExe (Join-Path $tTw 'teams-watcher.ts') install-hook
Register-HiddenNodeTask 'Claude - réponses Teams des sessions' (Join-Path $tTw 'teams-watcher.ts') 2 10 'Réponses Teams attendues par les sessions Claude Code (sessions-desk) : ~/.claude/state/teams-waits'

Copy-Item (Join-Path $scripts 'restart-idle-sessions.ps1') (Join-Path $Target 'restart-idle-sessions.ps1') -Force
"commit $head`nbranche $branch`ndéployé $(Get-Date -Format s)`ndepuis $repo" | Set-Content (Join-Path $Target 'DEPLOYED.txt') -Encoding utf8
Write-Host "Étiqueteur, surveillant Teams et scripts copiés vers $Target (commit $($head.Substring(0, 10)), $branch)." -ForegroundColor Green

if ($SkipServer) { return }

# Page seule changée depuis le commit en service : on la remplace dans la copie, sans arrêter le serveur. Lu APRÈS
# la prise du verrou : un déploiement qui a attendu repart de ce que le précédent a mis en service.
$runDir = Join-Path $env:LOCALAPPDATA 'sessions-desk\node-8765'
$plan = 'restart'; $why = '-Restart demandé'; $running = $null
if (-not $Restart) {
    $running = Get-DeployedCommit $runDir
    $alive = try { $null = Invoke-RestMethod 'http://localhost:8765/api/ping' -TimeoutSec 3; $true } catch { $false }
    if (-not $running) { $why = 'commit de la copie en service inconnu' }
    elseif (-not $alive) { $why = 'le serveur ne répond pas' }
    else {
        git -C $repo cat-file -e "$running^{commit}" 2>$null
        if ($LASTEXITCODE) { $why = "commit en service $($running.Substring(0, 10)) absent du clone" }
        else {
            $changed = @(git -C $repo diff --name-only $running $head)
            if ($LASTEXITCODE) { throw 'git diff en échec' }
            $plan = Get-DeployPlan $changed
            $why = 'le serveur a changé'
        }
    }
}
$was = Get-DeployedCommit $runDir
if ((Test-BehindRunning $repo $head $was) -and -not $Rollback) {
    throw "déploiement refusé : $short est plus ancien que le commit en service $($was.Substring(0, 10)) (clone en retard : git pull ; retour arrière voulu : -Rollback)."
}
Write-DeployLog 8765 "$short ($branch) commencé, en service $(if ($was) { $was.Substring(0, 10) } else { 'inconnu' })"
if ($plan -ne 'restart') {
    Update-RunCopy -Repo $repo -Head $head -RunDir $runDir -Plan $plan -Running $running
    $msg = if ($plan -eq 'page') { 'page remplacée à chaud, serveur NON redémarré (les pages ouvertes se rechargent seules)' } else { 'rien qui concerne le serveur ni la page, serveur NON redémarré' }
    Write-Host "Production (8765) sur le commit $short ($branch) : $msg." -ForegroundColor Green
    Write-DeployLog 8765 "$short : $(if ($plan -eq 'page') { 'page remplacée à chaud, aucune coupure' } else { 'rien à remplacer, aucune coupure' })"
    return
}
Write-Host "redémarrage du serveur : $why." -ForegroundColor Yellow
Write-DeployLog 8765 "$short : redémarrage du serveur ($why)"
& (Join-Path $PSScriptRoot 'Install-NodeWatchdog.ps1') -Port 8765 -Primary -Force:$Force
if (-not $?) { throw 'réinstallation du serveur Node en échec — voir ci-dessus.' }
Write-Host "Production (8765) redéployée sur le commit $short ($branch)." -ForegroundColor Green

} catch {
    Write-DeployLog 8765 "$short EN ÉCHEC : $($_.Exception.Message)"
    throw
} finally { Exit-DeployLock $lock }
