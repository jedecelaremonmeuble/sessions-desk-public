<#
.SYNOPSIS
  Mise à jour automatique du poste : quand `main` a avancé et que ses contrôles sont verts, le clone est avancé et
  Deploy.ps1 relancé. Sans option : une passe. -Install pose la tâche planifiée qui la lance, -Uninstall la retire.

.DESCRIPTION
  Le serveur du poste tourne sur une COPIE d'un commit et ne suit pas `main` tout seul. Avec plusieurs postes, les
  mettre à jour à la main un par un ne tient pas : cette passe le fait, prudemment.

  Une passe :
    1. `git fetch origin main`. Si le commit en service est déjà `origin/main` : rien, aucun appel réseau de plus ;
    2. refuse — sans rien toucher — si le clone n'est pas sur `main`, s'il a des modifications ou des commits locaux,
       ou si ce qui est en service n'est PAS un ancêtre de `main` (une version posée à la main depuis une autre
       branche n'est jamais écrasée) ;
    3. lit les contrôles du commit sur GitHub (API publique, sans jeton) : tant qu'ils ne sont pas TOUS terminés et
       verts, la passe attend la suivante. Un `main` rouge n'est jamais déployé ;
    4. avance le clone (`git merge --ff-only`) et lance Deploy.ps1 — qui garde ses propres garde-fous : un seul
       déploiement à la fois, page remplacée à chaud si elle seule a changé, arrêt propre du serveur sinon, retour à
       la copie précédente si la nouvelle ne démarre pas.

  Sur un poste où Deploy.ps1 n'a jamais posé l'étiqueteur ni le surveillant Teams (serveur installé seul), la passe
  ne les pose pas non plus : Deploy.ps1 -ServerOnly.

  À savoir avant de l'allumer : le poste exécutera, sans relecture, ce qui arrive sur `main`. À réserver à un dépôt
  où toi seul peux pousser sur `main`.

  Dernière décision : %LOCALAPPDATA%\sessions-desk\auto-update.txt. Mises à jour et refus (une fois par raison) :
  %TEMP%\sessions-desk-node-watchdog.log, à côté des déploiements.

.EXAMPLE
  pwsh -NoProfile -File server/watchdog/Auto-Update.ps1 -Install            # toutes les heures
  pwsh -NoProfile -File server/watchdog/Auto-Update.ps1 -DryRun             # dit ce qu'une passe ferait
  pwsh -NoProfile -File server/watchdog/Auto-Update.ps1 -Uninstall
#>
param([switch]$Install, [switch]$Uninstall, [int]$EveryMinutes = 60, [switch]$DryRun)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Deploy-Plan.ps1')

$taskName = 'sessions-desk - mise à jour automatique'
$repo = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$runDir = Join-Path $env:LOCALAPPDATA 'sessions-desk\node-8765'
$stateFile = Join-Path $env:LOCALAPPDATA 'sessions-desk\auto-update.txt'

if ($Uninstall) {
    if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) { Unregister-ScheduledTask -TaskName $taskName -Confirm:$false; Write-Host "tâche retirée : $taskName" }
    else { Write-Host "aucune tâche « $taskName »" }
    return
}
if ($Install) {
    if ($EveryMinutes -lt 15) { throw '-EveryMinutes : 15 au moins (API GitHub sans jeton : 60 appels par heure).' }
    . (Join-Path $PSScriptRoot 'Resolve-StablePwsh.ps1')
    $pwsh = Resolve-StablePwsh -Path (Get-Process -Id $PID).Path
    # conhost --headless : aucune fenêtre ne s'ouvre à chaque passe.
    $act = New-ScheduledTaskAction -Execute 'conhost.exe' -Argument "--headless `"$pwsh`" -NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`"" -WorkingDirectory $repo
    $trg = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(5) -RepetitionInterval (New-TimeSpan -Minutes $EveryMinutes)
    $set = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 30) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
    $null = Register-ScheduledTask -TaskName $taskName -Action $act -Trigger $trg -Settings $set -Force `
        -Description "Met à jour le serveur sessions-desk de ce poste quand main a avancé et que ses contrôles sont verts (clone : $repo)"
    Write-Host "Tâche « $taskName » posée : toutes les $EveryMinutes min, depuis $repo." -ForegroundColor Green
    Write-Host "Dernière décision : $stateFile"
    return
}

# ── Une passe ──
function Save-Decision([string]$Action, [string]$Why) {
    $line = "$Action : $Why"
    $last = if (Test-Path $stateFile) { @(Get-Content $stateFile -TotalCount 2)[1] } else { $null }
    try { $null = New-Item -ItemType Directory -Force (Split-Path $stateFile -Parent); Set-Content $stateFile @((Get-Date -Format s), $line) -Encoding utf8 } catch { }
    # Le journal ne répète pas la même raison à chaque passe.
    if ($Action -ne 'none' -and $line -ne $last) { Write-DeployLog 8765 "mise à jour automatique — $line" }
    Write-Host $line
}

$top = git -C $repo rev-parse --show-toplevel 2>$null
if ($LASTEXITCODE -or -not $top) { throw "Auto-Update.ps1 se lance depuis un clone du dépôt, pas depuis $PSScriptRoot." }
git -C $repo fetch -q origin main
if ($LASTEXITCODE) { Save-Decision 'wait' 'git fetch en échec (réseau ?)'; return }
$remote = (git -C $repo rev-parse origin/main).Trim()
$deployed = Get-DeployedCommit $runDir
$branch = (git -C $repo rev-parse --abbrev-ref HEAD).Trim()
$dirty = [bool](git -C $repo status --porcelain)
$ahead = [int](git -C $repo rev-list --count origin/main..HEAD)
$onMain = $true
if ($deployed -and $deployed -ne $remote) { git -C $repo merge-base --is-ancestor $deployed $remote 2>$null; $onMain = -not $LASTEXITCODE }

# Contrôles lus seulement s'il y a quelque chose à déployer.
$checks = 'unknown'
if ($deployed -ne $remote) {
    $url = "$(git -C $repo remote get-url origin)"
    if ($url -match 'github\.com[:/]([^/]+)/([^/]+?)(?:\.git)?/?$') {
        try {
            $r = Invoke-RestMethod "https://api.github.com/repos/$($Matches[1])/$($Matches[2])/commits/$remote/check-runs?per_page=100" -TimeoutSec 20 `
                -Headers @{ 'User-Agent' = 'sessions-desk-auto-update'; Accept = 'application/vnd.github+json' }
            $checks = Get-ChecksVerdict @($r.check_runs)
        } catch { $checks = 'unknown' }
    }
}

$d = Get-UpdateDecision -Branch $branch -Dirty $dirty -Ahead $ahead -Remote $remote -Deployed $deployed -DeployedOnMain $onMain -Checks $checks
if ($d.Action -ne 'update') { Save-Decision $d.Action $d.Why; return }
if ($DryRun) { Write-Host "update : $($d.Why) (à blanc : rien n'est fait)"; return }

$short = $remote.Substring(0, 10)
try {
    git -C $repo merge -q --ff-only origin/main
    if ($LASTEXITCODE) { throw 'git merge --ff-only en échec' }
    # Deploy.ps1 du commit qu'on vient de prendre, dans un process neuf. Sans les compagnons s'ils n'ont jamais été posés ici.
    $companions = Test-Path (Join-Path $env:USERPROFILE '.claude\scripts\DEPLOYED.txt')
    $args2 = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $PSScriptRoot 'Deploy.ps1')); if (-not $companions) { $args2 += '-ServerOnly' }
    $out = & (Get-Process -Id $PID).Path @args2 2>&1
    if ($LASTEXITCODE) { throw "Deploy.ps1 en échec : $(@($out | ForEach-Object { "$_" } | Where-Object { $_.Trim() } | Select-Object -Last 2) -join ' / ')" }
    Save-Decision 'updated' "$short en service ($($d.Why))"
} catch {
    Save-Decision 'failed' "$short : $($_.Exception.Message)"
    exit 1
}
