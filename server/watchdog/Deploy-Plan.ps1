<#
.SYNOPSIS
  Décision du déploiement (pure, sans effet) : faut-il redémarrer le serveur, ou suffit-il de remplacer la page ?
.DESCRIPTION
  Le serveur de production tourne sur une COPIE d'un commit (Install-NodeWatchdog.ps1, git archive) et relit la page
  (page/) sur disque à chaque requête ; la page ouverte repère que ses fichiers ont changé et se recharge seule. Un
  déploiement qui ne touche que page/ n'a donc pas à arrêter le serveur — l'arrêter, c'est une coupure pour rien.

  Est « du serveur » tout ce que la copie contient en dehors de page/, plus le pilote (compilé dans la copie) :
  server/src, server/package.json, server/watchdog, server/scripts, driver, legacy. Le reste (tests, README,
  workflows…) n'est pas dans la copie : il ne compte pas.
#>

$script:ServerPaths = @('server/src/', 'server/package.json', 'server/watchdog/', 'server/scripts/', 'driver/', 'legacy/')

<# Fichiers modifiés entre deux commits → 'none' (rien qui concerne la copie), 'page' (page seule) ou 'restart'. #>
function Get-DeployPlan([string[]]$Changed) {
    $files = @($Changed | Where-Object { $_ } | ForEach-Object { $_.Trim().Replace('\', '/') })
    foreach ($f in $files) { foreach ($p in $script:ServerPaths) { if ($f -eq $p.TrimEnd('/') -or $f.StartsWith($p)) { return 'restart' } } }
    if ($files | Where-Object { $_.StartsWith('page/') }) { return 'page' }
    return 'none'
}

<# Commit inscrit dans DEPLOYED.txt de la copie (première ligne « commit <sha> … »), ou $null. #>
function Get-DeployedCommit([string]$RunDir) {
    $f = Join-Path $RunDir 'DEPLOYED.txt'
    if (-not (Test-Path $f)) { return $null }
    $first = @(Get-Content $f -TotalCount 1)[0]
    if ("$first" -match '^commit ([0-9a-f]{40})\b') { return $Matches[1] }
    return $null
}

<# Met la copie en service au niveau de $Head sans arrêter le serveur : page/ remplacée (plan 'page'), puis
   DEPLOYED.txt réécrit — la copie correspond désormais à $Head, base du prochain déploiement. #>
function Update-RunCopy([string]$Repo, [string]$Head, [string]$RunDir, [string]$Plan, [string]$Running) {
    if ($Plan -eq 'page') {
        $zip = Join-Path $env:TEMP "sessions-desk-page-$($Head.Substring(0, 7)).zip"; $tmp = Join-Path $RunDir 'page.new'
        if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
        git -C $Repo archive --format=zip -o $zip $Head page
        if ($LASTEXITCODE -ne 0) { throw 'git archive en échec' }
        Expand-Archive $zip $tmp -Force; Remove-Item $zip
        $new = Join-Path $tmp 'page'; $dst = Join-Path $RunDir 'page'
        # Fichier par fichier, écrit à côté puis renommé : le serveur ne sert jamais un app.js à moitié copié.
        foreach ($f in Get-ChildItem $new -File -Recurse) {
            $t = Join-Path $dst $f.FullName.Substring($new.Length + 1)
            $null = New-Item -ItemType Directory -Force (Split-Path $t -Parent)
            Copy-Item $f.FullName "$t.tmp" -Force
            for ($i = 0; ; $i++) { try { Move-Item "$t.tmp" $t -Force; break } catch { if ($i -ge 20) { throw }; Start-Sleep -Milliseconds 100 } }
        }
        foreach ($f in Get-ChildItem $dst -File -Recurse) { if (-not (Test-Path (Join-Path $new $f.FullName.Substring($dst.Length + 1)))) { Remove-Item $f.FullName -Force } }
        Remove-Item $tmp -Recurse -Force
    }
    # La copie correspond désormais à $Head : c'est la base du prochain déploiement.
    $onMain = (git -C $Repo rev-parse origin/main).Trim() -eq $Head
    $lines = @(Get-Content (Join-Path $RunDir 'DEPLOYED.txt'))
    $lines[0] = "commit $Head$(if ($onMain) { ' (origin/main)' } else { ' (PAS origin/main)' })"
    $lines += "$(if ($Plan -eq 'page') { 'page remplacée à chaud' } else { 'rien à remplacer' }) le $(Get-Date -Format s) (serveur démarré sur $($Running.Substring(0, 10)))"
    Set-Content (Join-Path $RunDir 'DEPLOYED.txt') $lines
}

<# $Head est-il un ANCÊTRE strict du commit en service ? (déployer depuis un clone en retard = revenir en arrière) #>
function Test-BehindRunning([string]$Repo, [string]$Head, [string]$Running) {
    if (-not $Running -or $Running -eq $Head) { return $false }
    git -C $Repo merge-base --is-ancestor $Head $Running 2>$null
    return -not $LASTEXITCODE
}

# ── Un seul déploiement à la fois, et une trace de chacun ──
# Plusieurs sessions déploient depuis le même poste : deux déploiements simultanés se marchent dessus (même dossier
# de préparation, l'un arrête le serveur que l'autre vient de lancer…). Verrou = mutex Windows nommé, par port : il
# est rendu à la sortie du process, même tué — pas de fichier de verrou orphelin à nettoyer. Réentrant dans le même
# process (Deploy.ps1 appelle Install-NodeWatchdog.ps1, qui le prend aussi).

<# Ligne du journal des relances du watchdog (%TEMP%\sessions-desk-node-watchdog.log) : les déploiements y sont
   tracés à côté des relances, qu'on distingue enfin des pannes. #>
function Write-DeployLog([int]$Port, [string]$Message) {
    try { Add-Content (Join-Path $env:TEMP 'sessions-desk-node-watchdog.log') "$(Get-Date -Format s) [$Port] déploiement : $Message" } catch { }
}

<# Prend le verrou de déploiement du port ; attend (au plus $TimeoutSec) qu'un autre déploiement finisse. #>
# La tâche planifiée en place est-elle celle qu'Install-NodeWatchdog.ps1 poserait ? Compare TOUT ce qu'il pose : action,
# compte, déclencheurs (ouverture de session + toutes les 2 min) et réglages. Au moindre écart : $false, et la tâche
# est reposée — une tâche périmée laissée en place lancerait un serveur avec d'anciens chemins. Pure : reçoit la tâche.
function Test-SameWatchdogTask($Task, [string]$Execute, [string]$Arguments, [string]$User) {
    if (-not $Task) { return $false }
    $a = @($Task.Actions); $t = @($Task.Triggers); $p = $Task.Principal; $s = $Task.Settings
    if ($a.Count -ne 1 -or "$($a[0].Execute)" -ne $Execute -or "$($a[0].Arguments)" -cne $Arguments) { return $false }
    $leaf = { param([string]$u) ($u -split '\\')[-1] }   # le planificateur rend le compte sans son domaine
    if (-not $p -or (& $leaf "$($p.UserId)") -ne (& $leaf $User) -or "$($p.LogonType)" -ne 'Interactive' -or "$($p.RunLevel)" -ne 'Limited') { return $false }
    if ($t.Count -ne 2) { return $false }
    if (@($t | Where-Object { "$($_.Repetition.Interval)" -eq 'PT2M' }).Count -ne 1) { return $false }
    if (@($t | Where-Object { -not "$($_.Repetition.Interval)" -and (& $leaf "$($_.UserId)") -eq (& $leaf $User) }).Count -ne 1) { return $false }
    if (-not $s -or "$($s.MultipleInstances)" -ne 'IgnoreNew' -or "$($s.ExecutionTimeLimit)" -ne 'PT1M') { return $false }
    if ($s.DisallowStartIfOnBatteries -or $s.StopIfGoingOnBatteries -or -not $s.StartWhenAvailable) { return $false }
    return $true
}

function Enter-DeployLock([int]$Port, [string]$What, [int]$TimeoutSec = 600) {
    $m = [Threading.Mutex]::new($false, "Local\sessions-desk-deploy-$Port")
    $info = Join-Path $env:TEMP "sessions-desk-deploy-$Port.lock.txt"
    $take = { param([int]$ms) try { $m.WaitOne($ms) } catch [Threading.AbandonedMutexException] { $true } }   # abandonné = détenteur mort : il est à nous
    if (-not (& $take 0)) {
        $who = if (Test-Path $info) { "$(Get-Content $info -Raw)".Trim() } else { 'détenteur inconnu' }
        Write-Host "un autre déploiement est en cours ($who) : attente de sa fin…" -ForegroundColor Yellow
        $t0 = Get-Date
        if (-not (& $take ($TimeoutSec * 1000))) { $m.Dispose(); throw "un autre déploiement tient toujours le verrou après $TimeoutSec s ($who)" }
        Write-DeployLog $Port "attendu $([int]((Get-Date) - $t0).TotalSeconds) s la fin d'un autre déploiement ($who)"
    }
    try { Set-Content $info "pid $PID, $What, depuis $(Get-Date -Format s)" } catch { }
    return $m
}

function Exit-DeployLock($Lock) {
    if (-not $Lock) { return }
    try { $Lock.ReleaseMutex() } catch { }
    $Lock.Dispose()
}

# ── Mise à jour automatique (Auto-Update.ps1) : décisions pures ──

<# Contrôles d'un commit (check-runs de l'API GitHub) → 'ok' (tous terminés et verts), 'pending', 'failed', ou
   'unknown' (aucun contrôle connu : on ne déploie pas un commit dont on ne sait rien). #>
function Get-ChecksVerdict($Runs) {
    $list = @($Runs | Where-Object { $_ })
    if (-not $list.Count) { return 'unknown' }
    if ($list | Where-Object { "$($_.status)" -ne 'completed' }) { return 'pending' }
    if ($list | Where-Object { "$($_.conclusion)" -notin @('success', 'skipped', 'neutral') }) { return 'failed' }
    return 'ok'
}

<# Que fait une passe ? Action 'none' (à jour), 'update', 'wait' (réessayer à la passe suivante) ou 'refuse' (le poste
   n'est pas dans un état où l'on met à jour seul), avec sa raison. $Deployed : commit en service ($null : inconnu) ;
   $DeployedOnMain : ce commit est-il un ancêtre de $Remote ? #>
function Get-UpdateDecision([string]$Branch, [bool]$Dirty, [int]$Ahead, [string]$Remote, [string]$Deployed, [bool]$DeployedOnMain, [string]$Checks) {
    $r = { param($a, $w) [pscustomobject]@{ Action = $a; Why = $w } }
    if ($Deployed -and $Deployed -eq $Remote) { return & $r 'none' 'déjà sur main' }
    if ($Branch -ne 'main') { return & $r 'refuse' "clone sur la branche « $Branch », pas main" }
    if ($Dirty) { return & $r 'refuse' 'modifications non commitées dans le clone' }
    if ($Ahead -gt 0) { return & $r 'refuse' "$Ahead commit(s) local(aux) absents de main" }
    if ($Deployed -and -not $DeployedOnMain) { return & $r 'refuse' "la version en service ($($Deployed.Substring(0, 10))) ne vient pas de main : posée à la main, jamais écrasée" }
    $to = $Remote.Substring(0, [math]::Min(10, $Remote.Length))
    switch ($Checks) {
        'ok' { return & $r 'update' "main est passé à $to, contrôles verts" }
        'pending' { return & $r 'wait' "contrôles de $to encore en cours" }
        'failed' { return & $r 'wait' "contrôles de $to en échec : main n'est pas déployé" }
        default { return & $r 'wait' "contrôles de $to illisibles (réseau, quota de l'API, ou aucun contrôle)" }
    }
}
