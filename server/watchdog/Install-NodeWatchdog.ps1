<#
.SYNOPSIS
  Pose (ou met à jour) le serveur Node À CÔTÉ du .ps1 sur 8767, en LECTURE SEULE (ou en écriture sous -AllowWrite),
  sous son propre watchdog.
.DESCRIPTION
  Depuis un checkout PROPRE dont le commit est poussé (le plus souvent main à jour) :
    1. compile le pilote et extrait le commit (git archive : server/, legacy/) dans un dossier neuf ;
    2. arrête le serveur Node de ce port (et seulement lui), remplace le dossier d'exécution
       %LOCALAPPDATA%\sessions-desk\node-<port> (l'ancien est gardé en .previous), écrit DEPLOYED.txt ;
    3. pose la tâche planifiée « sessions-desk - Node <port> (watchdog) » : à l'ouverture de session et toutes les
       2 minutes, sessions-desk-node-watchdog.ps1 relance le serveur s'il ne répond plus ;
    4. lance la tâche et attend que /api/ping réponde.

  Le serveur tourne donc sur une COPIE d'un commit : il ne suit pas main tout seul. Pour le mettre à jour, relancer
  ce script depuis un checkout de main à jour (comme -Deploy pour le .ps1).

  Ne touche ni au .ps1 de production (8765, ~/.claude/scripts), ni à son watchdog, ni à sa tâche, ni à
  tailscale serve. Sur 8765 il exige -Primary et que le port soit LIBRE : la bascule (étape 5), retour arrière
  compris, passe par server/watchdog/Switch-SessionsDesk.ps1, qui coupe le .ps1 avant de l'appeler.

  -Primary (8765 seulement) : rôle de production — écriture, notifications, alertes du lanceur et de Teams, index de
  recherche, état des PR, « vu », relais 8766 de tailscale serve.

  -AllowWrite : le serveur est lancé avec --allow-write (favoris, masquage, envois dans les sessions…), et le reste
  à chaque relance du watchdog. Relancer sans -AllowWrite le repasse en lecture seule. Favoris et masquées sont
  PARTAGÉS avec le .ps1, qui les relit quand ils changent et avant chaque écriture (une fois son correctif déployé) :
  un changement fait sur 8767 s'affiche sur 8765 et n'y est pas écrasé.

  -Uninstall : retire la tâche et arrête le serveur Node du port (le dossier d'exécution reste).

  Deux garde-fous autour de la coupure :
  - poste saturé : si la préparation (archive + compilation du pilote, 4 à 6 s d'ordinaire) dépasse
    -PrepareLimitSeconds (20 s) alors qu'un serveur est en service, le script RENONCE avant de couper — le serveur
    en service n'est pas touché, sortie en échec. -Force déploie quand même ;
  - nouveau serveur muet : s'il ne répond pas dans -StartTimeoutSeconds (90 s), il est arrêté, la copie précédente
    (.previous) est remise en place et relancée, et le script sort en échec. La copie en échec reste dans
    node-<port>.failed pour le diagnostic.
.EXAMPLE
  pwsh -NoProfile -File server/watchdog/Install-NodeWatchdog.ps1
#>
param(
    [int]$Port = 8767,
    [switch]$AllowWrite,
    [switch]$Primary,
    [switch]$Uninstall,
    # Préparation plus longue que ça, serveur en service : on renonce avant de couper (0 = jamais). -Force passe outre.
    [int]$PrepareLimitSeconds = 20,
    [switch]$Force,
    # Attente de la première réponse du nouveau serveur avant de revenir à la copie précédente.
    [int]$StartTimeoutSeconds = 90
)
$ErrorActionPreference = 'Stop'
if ($Port -eq 8765 -and -not $Primary) { throw 'Port 8765 = production : -Primary requis (bascule par server/watchdog/Switch-SessionsDesk.ps1).' }
if ($Primary -and $Port -ne 8765) { throw '-Primary : port 8765 seulement.' }
if ($Primary) { $AllowWrite = [switch]$true }   # le rôle primary écrit toujours (config.ts)
$role = if ($Primary) { 'PRIMARY (production 8765)' } elseif ($AllowWrite) { 'ÉCRITURE (--allow-write)' } else { 'lecture seule' }

$taskName = "sessions-desk - Node $Port (watchdog)"
$runDir = Join-Path $env:LOCALAPPDATA "sessions-desk\node-$Port"
$repo = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent

. (Join-Path $PSScriptRoot 'Deploy-Plan.ps1')   # verrou et journal des déploiements

# Port sans écouteur : réponse immédiate (un ping HTTP vers un port fermé coûte ~4 s sous Windows).
function Test-Listening { [bool]([Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners() | Where-Object Port -eq $Port) }

# Attend que le serveur du port réponde à /api/ping ; $false s'il reste muet.
function Wait-Server([int]$Seconds) {
    $sw = [Diagnostics.Stopwatch]::StartNew()
    while ($sw.Elapsed.TotalSeconds -lt $Seconds) {
        Start-Sleep -Milliseconds 500
        if (Test-Listening) { try { $null = Invoke-RestMethod "http://localhost:$Port/api/ping" -TimeoutSec 3; return $true } catch {} }
    }
    return $false
}

function Stop-NodeServer([int]$WaitSeconds = 5) {
    $ids = @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue | ForEach-Object OwningProcess)
    $pidFile = Join-Path $env:TEMP "sessions-desk-node-$Port.pid"
    $old = 0
    if ((Test-Path $pidFile) -and [int]::TryParse("$(Get-Content $pidFile -Raw)".Trim(), [ref]$old)) { $ids += $old }
    $ours = @(foreach ($id in ($ids | Sort-Object -Unique)) {
        $p = Get-CimInstance Win32_Process -Filter "ProcessId=$id" -ErrorAction SilentlyContinue
        if (-not $p -or $p.Name -ne 'node.exe' -or $p.CommandLine -notmatch 'server[\\/]src[\\/]main\.ts') { continue }
        $pp = if ($p.CommandLine -match '--port\s+(\d+)') { [int]$Matches[1] } else { 8767 }
        if ($pp -eq $Port) { $id }
    })
    # ARRÊT PROPRE d'abord (/api/stop) : le serveur refuse les nouvelles requêtes, va au bout de celles reçues (8 s
    # au plus) et sort de lui-même. La force — qu'aucun process ne peut intercepter sous Windows — ne sert plus qu'au
    # serveur figé ou muet.
    if ($ours) {
        $t0 = Get-Date
        try { $null = Invoke-RestMethod "http://localhost:$Port/api/stop" -TimeoutSec 5; $asked = $true } catch { $asked = $false }
        if ($asked) {
            foreach ($id in $ours) { Wait-Process -Id $id -Timeout 12 -ErrorAction SilentlyContinue }
            $left = @($ours | Where-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue })
            if (-not $left) {
                $m = "serveur arrêté proprement (pid $($ours -join ', '), $([int]((Get-Date) - $t0).TotalMilliseconds) ms)"
                Write-Host "$m"; Write-DeployLog $Port $m
            }
        }
    }
    if (-not $ours) { Write-DeployLog $Port 'aucun serveur à arrêter (il ne tournait pas)' }
    foreach ($id in $ours) {
        if (-not (Get-Process -Id $id -ErrorAction SilentlyContinue)) { continue }
        Write-Host "arrêt FORCÉ du serveur Node (pid $id) : il n'a pas répondu à /api/stop ou n'est pas sorti à temps"
        Write-DeployLog $Port "arrêt FORCÉ du serveur (pid $id) : pas de réponse à /api/stop ou pas sorti à temps"
        Stop-Process -Id $id -Force
    }
    for ($i = 0; $i -lt $WaitSeconds * 8 -and (Test-Listening); $i++) { Start-Sleep -Milliseconds 125 }
    if (Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue) { throw "port $Port toujours tenu par un process qui n'est pas un serveur Node de ce port" }
}

# Le nouveau serveur est resté muet : retour à la copie précédente. Il est arrêté (le port peut mettre du temps à être
# rendu par un process figé : on l'attend), les dossiers sont échangés dans l'autre sens, tâche désactivée pendant
# l'échange, puis la copie précédente est relancée et on vérifie qu'elle répond. Rend la phrase du compte rendu.
function Restore-PreviousCopy {
    $prev = "$runDir.previous"
    if (-not (Test-Path (Join-Path $prev 'server\src\main.ts'))) {
        Write-DeployLog $Port 'retour arrière impossible : pas de copie précédente'
        return 'pas de copie précédente à remettre en service'
    }
    $prevSha = Get-DeployedCommit $prev
    $name = if ($prevSha) { $prevSha.Substring(0, 10) } else { 'de commit inconnu' }
    $t0 = Get-Date
    $null = Disable-ScheduledTask -TaskName $taskName
    Stop-NodeServer -WaitSeconds 20
    $failed = "$runDir.failed"
    if (Test-Path $failed) { Remove-Item $failed -Recurse -Force }
    Move-Item $runDir $failed
    Move-Item $prev $runDir
    $null = Enable-ScheduledTask -TaskName $taskName
    Set-Content $marker "$name (retour arrière)"
    Start-ScheduledTask -TaskName $taskName
    $ok = Wait-Server 60
    $took = [math]::Round(((Get-Date) - $t0).TotalSeconds, 1)
    $m = if ($ok) { "version précédente $name remise en service, elle répond ($took s après l'abandon)" }
    else { "version précédente $name remise en place, mais elle ne répond pas non plus après $took s" }
    Write-DeployLog $Port "retour arrière : $m ; copie en échec gardée dans $failed"
    return $m
}

if ($Uninstall) {
    if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) { Unregister-ScheduledTask -TaskName $taskName -Confirm:$false; Write-Host "tâche retirée : $taskName" }
    Stop-NodeServer
    return
}

# 1. Commit propre et poussé : le serveur doit toujours correspondre à un commit du dépôt.
$dirty = git -C $repo status --porcelain
if ($dirty) { throw "checkout modifié ($repo) : committer et pousser d'abord" }
$sha = (git -C $repo rev-parse HEAD).Trim()
git -C $repo fetch -q origin
$remote = git -C $repo branch -r --contains $sha
if (-not $remote) { throw "commit $sha non poussé" }
$onMain = (git -C $repo rev-parse origin/main).Trim() -eq $sha
if (-not $onMain) { Write-Warning "commit $sha ≠ origin/main : le serveur tournera sur une autre version que main" }

$node = (Get-Command node).Source
$v = [version]((& $node --version).TrimStart('v'))
if ($v -lt [version]'22.18.0') { throw "Node $v : 22.18+ requis (TypeScript exécuté directement)" }
. (Join-Path $PSScriptRoot 'Resolve-StablePwsh.ps1')
$pwsh = Resolve-StablePwsh (Get-Process -Id $PID).Path

# Un seul déploiement à la fois sur ce port (dossier de préparation commun, arrêt/relance du même serveur) : un
# second attend la fin du premier. Voir Deploy-Plan.ps1.
$lock = Enter-DeployLock $Port "Install-NodeWatchdog.ps1 $($sha.Substring(0, 10))"
$marker = Join-Path $env:TEMP "sessions-desk-node-$Port.deploying"
$touched = $false   # vrai dès que le serveur en service ou sa tâche ont été touchés
try {
    $prep = [Diagnostics.Stopwatch]::StartNew()
    $stage = "$runDir.new"
    if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
    New-Item -ItemType Directory -Force $stage | Out-Null
    $zip = Join-Path $env:TEMP "sessions-desk-node-$Port-$($sha.Substring(0,7)).zip"
    # Page et scripts d'accompagnement : legacy/ tant que le serveur historique est dans le dépôt, sinon page/ et server/scripts/.
    [string[]]$extra = if (Test-Path (Join-Path $repo 'legacy')) { 'legacy' } else { 'page', 'server/scripts' }
    git -C $repo archive --format=zip -o $zip $sha server/src server/package.json server/watchdog @extra
    if ($LASTEXITCODE -ne 0) { throw 'git archive en échec' }
    Expand-Archive $zip $stage -Force; Remove-Item $zip
    dotnet build (Join-Path $repo 'driver\SessionsDesk.Driver.csproj') -c Release -o (Join-Path $stage '.build\driver') --nologo -v q
    if ($LASTEXITCODE -ne 0) { throw 'compilation du pilote en échec' }
    Set-Content (Join-Path $stage 'DEPLOYED.txt') @(
        "commit $sha$(if ($onMain) { ' (origin/main)' } else { ' (PAS origin/main)' })"
        "posé le $(Get-Date -Format s) depuis $repo"
        "node $node ($v)"
        "mode $role"
    )

    # Poste saturé : la préparation a traîné, le démarrage du nouveau serveur traînerait aussi — et là ce serait une
    # coupure. On renonce tant que rien n'est touché ; un refus à tort ne coûte qu'une relance (la compilation
    # suivante est incrémentale). Sans serveur en service il n'y a rien à protéger.
    $prepSec = [math]::Round($prep.Elapsed.TotalSeconds, 1)
    if (Test-PrepareTooSlow $prepSec $PrepareLimitSeconds ([bool]$Force) (Test-Listening)) {
        Remove-Item $stage -Recurse -Force
        throw "déploiement RENONCÉ avant la coupure : préparation en $prepSec s (limite $PrepareLimitSeconds s), poste saturé ? Le serveur en service n'a pas été touché. Relancer plus tard, ou -Force pour déployer quand même."
    }
    if ($Force -and $PrepareLimitSeconds -gt 0 -and $prepSec -gt $PrepareLimitSeconds) { Write-DeployLog $Port "préparation en $prepSec s (limite $PrepareLimitSeconds s) : poursuivi sous -Force" }

    # 2. Tâche : mêmes réglages que celle du .ps1 (ouverture de session + toutes les 2 min, sans fenêtre). Sa pose
    #    (Register-ScheduledTask) prend de temps à autre 6 à 19 s au lieu d'une : elle ne se fait donc PAS pendant la
    #    coupure. Tâche en place et identique à celle voulue — le cas de presque tous les déploiements — : elle n'est
    #    pas reposée. Différente : reposée ici, serveur encore en service. Absente (première installation) : posée
    #    plus bas, il n'y a alors aucun serveur à couper.
    $watchdog = Join-Path $runDir 'server\watchdog\sessions-desk-node-watchdog.ps1'
    $taskExe = 'conhost.exe'
    $taskArgs = "--headless `"$pwsh`" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$watchdog`" -Port $Port -Node `"$node`"$(if ($Primary) { ' -Primary' } elseif ($AllowWrite) { ' -AllowWrite' })"
    $user = "$env:USERDOMAIN\$env:USERNAME"
    $poseTask = {
        $action = New-ScheduledTaskAction -Execute $taskExe -Argument $taskArgs
        $triggers = @(
            (New-ScheduledTaskTrigger -AtLogOn -User $user),
            (New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 2))
        )
        $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
        $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 1) `
            -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
        $null = Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $triggers -Principal $principal -Settings $settings `
            -Description "Serveur Node sessions-desk $(if ($Primary) { 'de PRODUCTION (primary)' } else { "à côté du .ps1, $role" }) (port $Port). Posé par server/watchdog/Install-NodeWatchdog.ps1 ; dossier $runDir." -Force
        # Relecture : l'action posée ne doit viser aucun dossier versionné du Store.
        $posed = (Get-ScheduledTask -TaskName $taskName).Actions[0].Arguments
        if ($posed -match '\\Program Files\\WindowsApps\\') { throw "action de la tâche sur un chemin versionné : $posed" }
    }
    $existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    $touched = $true
    $taskNote = 'tâche inchangée, non reposée'
    if (-not $existing) { $taskNote = 'tâche absente, posée pendant la coupure' }
    elseif (-not (Test-SameWatchdogTask $existing $taskExe $taskArgs $user)) {
        $t0 = Get-Date; & $poseTask
        $taskNote = "tâche différente, reposée avant la coupure en $([math]::Round(((Get-Date) - $t0).TotalSeconds, 1)) s"
        Write-DeployLog $Port "tâche planifiée différente de celle voulue : $taskNote"
    }
    # Dossier d'exécution remplacé tâche désactivée, pour que le watchdog ne relance pas en plein échange.
    if ($existing) { $null = Disable-ScheduledTask -TaskName $taskName }
    # L'ancienne copie de secours part AVANT l'arrêt : la coupure ne dure que l'échange des dossiers.
    if (Test-Path "$runDir.previous") { Remove-Item "$runDir.previous" -Recurse -Force }
    $cut = Get-Date   # début de la coupure : jusqu'à la première réponse du nouveau serveur
    # Étapes de la coupure, en secondes depuis son début (cumulées) : écrites au journal avec sa durée.
    $steps = [ordered]@{}; $mark = { param([string]$n) $steps[$n] = [math]::Round(((Get-Date) - $cut).TotalSeconds, 1) }
    Stop-NodeServer
    # Sur 8765, http.sys (le .ps1) ne figure pas comme écouteur TCP d'un process : on vérifie qu'aucun serveur ne répond.
    if ($Port -eq 8765) {
        $busy = (Test-Listening) -and $(try { $null = Invoke-RestMethod "http://localhost:$Port/api/ping" -TimeoutSec 2; $true } catch { $false })
        if ($busy) { if ($existing) { $null = Enable-ScheduledTask -TaskName $taskName }; throw "un serveur répond encore sur $Port (le .ps1 ?) : passer par Switch-SessionsDesk.ps1 -To node" }
    }
    & $mark 'arrêté, port libre'
    if (Test-Path $runDir) {
        Move-Item $runDir "$runDir.previous"
    }
    Move-Item $stage $runDir
    & $mark 'dossiers échangés'

    # 3. Tâche remise en service : réactivée si elle était là (elle a été désactivée pour l'échange), posée sinon.
    if ($existing) { $null = Enable-ScheduledTask -TaskName $taskName; & $mark 'tâche réactivée' }
    else { & $poseTask; & $mark 'tâche posée' }

    # 4. Lancer et attendre le serveur. Le marqueur dit au watchdog que ce démarrage est un déploiement : il démarre
    #    sans son délai de grâce et ne le trace pas comme une panne (« serveur muet => relance »).
    Set-Content $marker $sha.Substring(0, 10)
    Start-ScheduledTask -TaskName $taskName
    & $mark 'tâche lancée'
    # Le marqueur reste en place pendant l'attente : le watchdog, qui repasse toutes les 2 min, laisse démarrer le
    # serveur qu'il a lancé pour ce déploiement au lieu de l'arrêter comme « muet ».
    $up = Wait-Server $StartTimeoutSeconds
    if ($up) {
        & $mark 'première réponse'
        # Lancement de node par le watchdog : heure d'écriture du fichier pid, juste après son Start-Process.
        $pf = Join-Path $env:TEMP "sessions-desk-node-$Port.pid"
        if ((Test-Path $pf) -and (Get-Item $pf).LastWriteTime -gt $cut) { $steps['node lancé'] = [math]::Round(((Get-Item $pf).LastWriteTime - $cut).TotalSeconds, 1) }
        $detail = ($steps.GetEnumerator() | Sort-Object Value | ForEach-Object { "$($_.Key) $($_.Value)" }) -join ' · '
        Write-DeployLog $Port "serveur $($sha.Substring(0, 10)) en service : coupure de $($steps['première réponse']) s (s depuis l'arrêt demandé : $detail ; $taskNote ; préparation $prepSec s)"
    }
    if (-not $up) {
        Write-DeployLog $Port "serveur $($sha.Substring(0, 10)) muet après $StartTimeoutSeconds s : retour à la version précédente"
        $back = Restore-PreviousCopy
        throw "le serveur $($sha.Substring(0, 10)) ne répond pas sur $Port après $StartTimeoutSeconds s : $back (voir $env:TEMP\sessions-desk-node-watchdog.log et sessions-desk-node-$Port.err.log)"
    }
    $w = Invoke-RestMethod "http://localhost:$Port/api/whoami"
    if ([bool]$w.write -ne [bool]$AllowWrite) { throw "serveur en $(if ($w.write) { 'écriture' } else { 'lecture seule' }) alors que demandé : $(if ($AllowWrite) { 'écriture' } else { 'lecture seule' })" }
    Write-Host "Serveur Node sur http://localhost:$Port/ ($role), commit $($sha.Substring(0,7)), tâche « $taskName »"
} catch {
    Write-DeployLog $Port "installation de $($sha.Substring(0, 10)) EN ÉCHEC : $($_.Exception.Message)"
    # Ne jamais laisser le poste sans serveur : copie précédente remise en place si la nouvelle n'a pas pris sa place,
    # tâche réactivée et lancée (elle était désactivée pendant l'échange). Rien à remettre si rien n'a été touché
    # (renoncement avant la coupure).
    if ($touched) { try {
        if (-not (Test-Path $runDir) -and (Test-Path "$runDir.previous")) { Move-Item "$runDir.previous" $runDir; Write-DeployLog $Port 'copie précédente remise en service' }
        $t = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
        if ($t -and $t.State -eq 'Disabled') { $null = Enable-ScheduledTask -TaskName $taskName }
        if ($t) { Start-ScheduledTask -TaskName $taskName }
    } catch { Write-DeployLog $Port "remise en service impossible : $($_.Exception.Message)" } }
    throw
} finally {
    Remove-Item $marker -Force -ErrorAction SilentlyContinue
    Exit-DeployLock $lock
}
