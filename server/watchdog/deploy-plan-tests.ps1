<#
.SYNOPSIS
  Tests de Deploy-Plan.ps1 : la décision « redémarrer ou remplacer la page », le remplacement à chaud, le refus d'un
  commit en retard, le verrou (un seul déploiement à la fois) et le journal.
.DESCRIPTION
  La décision est testée sur des listes de fichiers ET sur de vrais écarts de l'historique du dépôt ; le remplacement
  sur une copie FACTICE (dossier temporaire) : ni la copie de production, ni son serveur, ni aucune tâche ne sont
  touchés. Se lance depuis un clone complet (l'historique sert de jeu de données).
#>
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Deploy-Plan.ps1')
$repo = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent

$script:fail = 0
function Check([string]$name, [bool]$ok, [string]$detail = '') {
    if ($ok) { Write-Host "ok   $name" } else { $script:fail++; Write-Host "FAIL $name $detail" }
}

# ── Décision sur des listes ──
Check 'page seule ⇒ page' ((Get-DeployPlan @('page/app.js', 'page/app.css')) -eq 'page')
Check 'page + tests ⇒ page (les tests ne sont pas dans la copie)' ((Get-DeployPlan @('page/app.js', 'server/test/x.test.ts')) -eq 'page')
Check 'code du serveur ⇒ restart' ((Get-DeployPlan @('page/app.js', 'server/src/http.ts')) -eq 'restart')
Check 'package.json du serveur ⇒ restart' ((Get-DeployPlan @('server/package.json')) -eq 'restart')
Check 'watchdog ⇒ restart' ((Get-DeployPlan @('server/watchdog/Deploy.ps1')) -eq 'restart')
Check 'scripts ⇒ restart' ((Get-DeployPlan @('server/scripts/guard.mjs')) -eq 'restart')
Check 'pilote ⇒ restart' ((Get-DeployPlan @('driver/src/Procs.cs')) -eq 'restart')
Check 'tests, README seuls ⇒ none' ((Get-DeployPlan @('server/test/a.test.ts', 'README.md', '.github/workflows/ci.yml')) -eq 'none')
Check 'rien ⇒ none' ((Get-DeployPlan @()) -eq 'none')
Check 'séparateurs Windows acceptés' ((Get-DeployPlan @('server\src\http.ts')) -eq 'restart')
Check 'préfixe trompeur (server/srcx) ⇒ pas restart' ((Get-DeployPlan @('server/srcx/a.ts')) -eq 'none')

# ── Décision sur de vrais écarts de l'historique ──
function Plan([string]$a, [string]$b) { Get-DeployPlan @(git -C $repo diff --name-only $a $b) }
$have = { param($c) git -C $repo cat-file -e "$c^{commit}" 2>$null; -not $LASTEXITCODE }
if ((& $have '681f35c') -and (& $have 'ecb83b3') -and (& $have 'e56ea97') -and (& $have '3b94614')) {
    Check 'historique : correctif de page (#12) ⇒ page' ((Plan '681f35c' 'ecb83b3') -eq 'page')
    Check 'historique : page + serveur (#14) ⇒ restart' ((Plan 'e56ea97' '681f35c') -eq 'restart')
    Check 'historique : tests seuls (#11) ⇒ none' ((Plan '3b94614' 'e56ea97') -eq 'none')
    Check 'retard : commit plus ancien que celui en service' (Test-BehindRunning $repo (git -C $repo rev-parse e56ea97) (git -C $repo rev-parse 681f35c))
    Check 'retard : commit plus récent ⇒ non' (-not (Test-BehindRunning $repo (git -C $repo rev-parse 681f35c) (git -C $repo rev-parse e56ea97)))
    Check 'retard : même commit ⇒ non' (-not (Test-BehindRunning $repo (git -C $repo rev-parse 681f35c) (git -C $repo rev-parse 681f35c)))
} else { Write-Host 'skip historique (clone incomplet)' }
Check 'retard : commit en service inconnu ⇒ non' (-not (Test-BehindRunning $repo 'abc' $null))

# ── Version d'un commit ──
$rank = { param($c) [int]((Get-CommitVersion $repo (git -C $repo rev-parse $c).Trim()) -replace '^\d+\.\d+\.(\d+).*', '$1') }
$v = Get-CommitVersion $repo (git -C $repo rev-parse HEAD).Trim()
Check 'version : majeur.mineur.rang (+sha hors de main)' ($v -match '^\d+\.\d+\.\d+(\+[0-9a-f]{7})?$') $v
Check 'version : le rang est le nombre de commits' ((& $rank 'HEAD') -eq [int](git -C $repo rev-list --count HEAD)) $v
if (& $have '681f35c') { Check 'version : un commit plus ancien a un rang plus petit' ((& $rank '681f35c') -lt (& $rank 'HEAD')) }

# ── DEPLOYED.txt ──
$fake = (New-Item -ItemType Directory -Force (Join-Path ([IO.Path]::GetTempPath()) "sd-deploy-plan-$PID")).FullName
try {
    Check 'pas de DEPLOYED.txt ⇒ $null' ($null -eq (Get-DeployedCommit $fake))
    Set-Content (Join-Path $fake 'DEPLOYED.txt') 'commit abc'
    Check 'DEPLOYED.txt illisible ⇒ $null' ($null -eq (Get-DeployedCommit $fake))

    # ── Remplacement à chaud sur une copie factice : page de 681f35c → page de ecb83b3 ──
    if ((& $have '681f35c') -and (& $have 'ecb83b3')) {
        $from = (git -C $repo rev-parse 681f35c).Trim(); $to = (git -C $repo rev-parse ecb83b3).Trim()
        $zip = Join-Path $fake 'p.zip'
        git -C $repo archive --format=zip -o $zip $from page; Expand-Archive $zip $fake -Force; Remove-Item $zip
        Set-Content (Join-Path $fake 'page\obsolete.js') 'retiré par le commit suivant'
        Set-Content (Join-Path $fake 'DEPLOYED.txt') @("commit $from (origin/main)", 'posé le …', 'mode PRIMARY')
        Check 'DEPLOYED.txt ⇒ commit lu' ((Get-DeployedCommit $fake) -eq $from)

        Update-RunCopy -Repo $repo -Head $to -RunDir $fake -Plan 'page' -Running $from
        # Comparé par empreinte git (octets) : une comparaison de texte dépend de l'encodage de la console.
        $want = (git -C $repo rev-parse "${to}:page/app.js").Trim()
        $got = (git -C $repo hash-object (Join-Path $fake 'page\app.js')).Trim()
        Check 'app.js remplacé par celui du nouveau commit' ($got -eq $want) "$got / $want"
        Check 'fichier disparu du commit retiré' (-not (Test-Path (Join-Path $fake 'page\obsolete.js')))
        Check 'aucun .tmp ni page.new laissé' (-not (Get-ChildItem $fake -Recurse -Filter '*.tmp') -and -not (Test-Path (Join-Path $fake 'page.new')))
        Check 'DEPLOYED.txt pointe le nouveau commit' ((Get-DeployedCommit $fake) -eq $to)
        $ver = "version $(Get-CommitVersion $repo $to)"
        Check 'DEPLOYED.txt porte la version du nouveau commit, en 2e ligne' ((Get-Content (Join-Path $fake 'DEPLOYED.txt'))[1] -eq $ver) $ver
        Update-RunCopy -Repo $repo -Head $to -RunDir $fake -Plan 'none' -Running $from
        Check 'une seule ligne « version » après deux passes' (@(Get-Content (Join-Path $fake 'DEPLOYED.txt') | Where-Object { $_ -match '^version ' }).Count -eq 1)
        Check 'DEPLOYED.txt garde le commit de démarrage du serveur' ((Get-Content (Join-Path $fake 'DEPLOYED.txt') -Raw) -match "page remplacée à chaud .*serveur démarré sur $($from.Substring(0, 10))")

        # ── Page qui ne se compile pas (2920d69 : retours à la ligne bruts dans une chaîne d'app.js) : refusée ──
        if (& $have '2920d69') {
            $bad = (git -C $repo rev-parse 2920d69).Trim()
            $before = Get-Content (Join-Path $fake 'DEPLOYED.txt') -Raw
            $msg = $null; try { Update-RunCopy -Repo $repo -Head $bad -RunDir $fake -Plan 'page' -Running $from } catch { $msg = $_.Exception.Message }
            Check 'page cassée ⇒ déploiement renoncé' ("$msg" -match 'RENONCÉ.*app\.js : SyntaxError.*app\.js:\d+') "$msg"
            Check 'page cassée ⇒ app.js en service intact' ((git -C $repo hash-object (Join-Path $fake 'page\app.js')).Trim() -eq $want)
            Check 'page cassée ⇒ ni page.new ni .tmp laissés' (-not (Get-ChildItem $fake -Recurse -Filter '*.tmp') -and -not (Test-Path (Join-Path $fake 'page.new')))
            Check 'page cassée ⇒ DEPLOYED.txt inchangé' ((Get-Content (Join-Path $fake 'DEPLOYED.txt') -Raw) -eq $before)
        } else { Write-Host 'skip page cassée (clone incomplet)' }
    } else { Write-Host 'skip remplacement (clone incomplet)' }

    # ── Test-PageScripts sur des fichiers faits main ──
    $pd = Join-Path $fake 'pagecheck'; $null = New-Item -ItemType Directory -Force (Join-Path $pd 'sub')
    Set-Content (Join-Path $pd 'ok.js') "const a = 'x\ny';"
    Set-Content (Join-Path $pd 'sub\ok.mjs') 'export const b = 1;'
    Set-Content (Join-Path $pd 'style.css') 'pas du js {'
    Check 'page saine ⇒ aucune erreur' (@(Test-PageScripts $pd).Count -eq 0)
    Set-Content (Join-Path $pd 'sub\ko.js') "const c = 'coupée`ren deux';"
    $errs = @(Test-PageScripts $pd)
    Check 'page cassée ⇒ une erreur, nommée par son chemin relatif' ($errs.Count -eq 1 -and $errs[0] -match '^sub\\ko\.js : SyntaxError') "$errs"
    Check 'dossier absent ⇒ aucune erreur (copie legacy sans page/)' (@(Test-PageScripts (Join-Path $fake 'absent')).Count -eq 0)
} finally { Remove-Item $fake -Recurse -Force -ErrorAction SilentlyContinue }

# ── Verrou de déploiement (port fictif, journal dans un TEMP factice : le vrai journal n'est pas touché) ──
$realTemp = $env:TEMP
$lt = (New-Item -ItemType Directory -Force (Join-Path ([IO.Path]::GetTempPath()) "sd-deploy-lock-$PID")).FullName
$env:TEMP = $lt
$plan = Join-Path $PSScriptRoot 'Deploy-Plan.ps1'
$pwshExe = (Get-Process -Id $PID).Path
try {
    $tp = 8899; $held = Join-Path $lt 'held'
    # Un autre process prend le verrou et MEURT sans le rendre (déploiement tué en route).
    $child = Start-Process $pwshExe -PassThru -WindowStyle Hidden -ArgumentList '-NoProfile', '-Command',
        ". '$plan'; `$l = Enter-DeployLock $tp 'test enfant'; Set-Content '$held' 1; Start-Sleep -Seconds 3; exit 0"
    for ($i = 0; $i -lt 100 -and -not (Test-Path $held); $i++) { Start-Sleep -Milliseconds 100 }
    Check 'verrou : pris par un autre process' (Test-Path $held)
    $refused = $false; try { $null = Enter-DeployLock $tp 'test' -TimeoutSec 1 } catch { $refused = $_.Exception.Message -match 'tient toujours le verrou' }
    Check 'verrou : un second déploiement attend puis abandonne (délai court)' $refused
    $t0 = Get-Date; $l1 = Enter-DeployLock $tp 'test' -TimeoutSec 20
    Check 'verrou : rendu à la mort du détenteur (abandonné = repris)' ($null -ne $l1 -and ((Get-Date) - $t0).TotalSeconds -lt 15)
    Check 'verrou : attente tracée' ((Get-Content (Join-Path $lt 'sessions-desk-node-watchdog.log') -Raw) -match "\[$tp\] déploiement : attendu \d+ s la fin d'un autre déploiement \(pid $($child.Id)")
    $l2 = Enter-DeployLock $tp 'imbriqué' -TimeoutSec 1
    Check 'verrou : réentrant dans le même process (Deploy ⇒ Install)' ($null -ne $l2)
    Exit-DeployLock $l2; Exit-DeployLock $l1
    $p2 = Start-Process $pwshExe -PassThru -Wait -WindowStyle Hidden -ArgumentList '-NoProfile', '-Command',
        ". '$plan'; try { `$l = Enter-DeployLock $tp 'test enfant 2' -TimeoutSec 1; Exit-DeployLock `$l; exit 0 } catch { exit 3 }"
    Check 'verrou : libre pour un autre process une fois rendu' ($p2.ExitCode -eq 0) "code $($p2.ExitCode)"
    Write-DeployLog $tp 'essai'
    Check 'journal : ligne datée, port, « déploiement : »' ((Get-Content (Join-Path $lt 'sessions-desk-node-watchdog.log') -Tail 1) -match "^\d{4}-\d\d-\d\dT[\d:]+ \[$tp\] déploiement : essai$")
} finally { $env:TEMP = $realTemp; Remove-Item $lt -Recurse -Force -ErrorAction SilentlyContinue }

# ── Tâche planifiée : celle en place est-elle celle qu'on poserait ? (elle n'est alors pas reposée) ──
$tx = 'conhost.exe'; $ta = '--headless "C:\pw\pwsh.exe" -NoProfile -File "C:\run\watchdog.ps1" -Port 8999 -Node "C:\n\node.exe"'; $tu = 'POSTE\quelquun'
function FakeTask([hashtable]$o = @{}) {
    $d = @{ Exe = $tx; Args = $ta; User = 'quelquun'; Logon = 'Interactive'; Run = 'Limited'; Interval = 'PT2M'; LogonUser = $tu; Multi = 'IgnoreNew'; Limit = 'PT1M'; NoBatt = $false; StopBatt = $false; Avail = $true; Actions = 1; Triggers = 2 }
    foreach ($k in $o.Keys) { $d[$k] = $o[$k] }
    [pscustomobject]@{
        Actions   = @(1..$d.Actions | ForEach-Object { [pscustomobject]@{ Execute = $d.Exe; Arguments = $d.Args } })
        Principal = [pscustomobject]@{ UserId = $d.User; LogonType = $d.Logon; RunLevel = $d.Run }
        Triggers  = @(@([pscustomobject]@{ UserId = $d.LogonUser; Repetition = [pscustomobject]@{ Interval = $null } }, [pscustomobject]@{ UserId = $null; Repetition = [pscustomobject]@{ Interval = $d.Interval } }, [pscustomobject]@{ UserId = $null; Repetition = [pscustomobject]@{ Interval = 'PT1H' } }) | Select-Object -First $d.Triggers)
        Settings  = [pscustomobject]@{ MultipleInstances = $d.Multi; ExecutionTimeLimit = $d.Limit; DisallowStartIfOnBatteries = $d.NoBatt; StopIfGoingOnBatteries = $d.StopBatt; StartWhenAvailable = $d.Avail }
    }
}
Check 'tâche : identique (compte rendu sans domaine) ⇒ pas reposée' (Test-SameWatchdogTask (FakeTask) $tx $ta $tu)
Check 'tâche : absente ⇒ à poser' (-not (Test-SameWatchdogTask $null $tx $ta $tu))
foreach ($c in @(
        @('chemin de node changé', @{ Args = $ta.Replace('C:\n\node.exe', 'C:\n2\node.exe') }), @('casse d''un chemin changée', @{ Args = $ta.Replace('C:\run', 'C:\RUN') }),
        @('-Primary ajouté', @{ Args = "$ta -Primary" }), @('autre exécutable', @{ Exe = 'pwsh.exe' }), @('deux actions', @{ Actions = 2 }),
        @('autre compte', @{ User = 'autre' }), @('droits élevés', @{ Run = 'Highest' }), @('autre type de session', @{ Logon = 'S4U' }),
        @('autre cadence', @{ Interval = 'PT5M' }), @('un seul déclencheur', @{ Triggers = 1 }), @('un déclencheur de trop', @{ Triggers = 3 }),
        @('ouverture de session d''un autre compte', @{ LogonUser = 'POSTE\autre' }), @('instances multiples', @{ Multi = 'Parallel' }), @('autre durée limite', @{ Limit = 'PT72H' }),
        @('arrêt sur batterie', @{ StopBatt = $true }), @('pas de démarrage sur batterie', @{ NoBatt = $true }), @('pas de rattrapage', @{ Avail = $false }))) {
    Check "tâche : $($c[0]) ⇒ reposée" (-not (Test-SameWatchdogTask (FakeTask $c[1]) $tx $ta $tu))
}
# Sur une vraie définition (en mémoire, rien n'est posé) : les propriétés lues sont bien celles que les cmdlets écrivent.
if (Get-Command New-ScheduledTask -ErrorAction SilentlyContinue) {
    $me = "$env:USERDOMAIN\$env:USERNAME"
    $real = New-ScheduledTask -Action (New-ScheduledTaskAction -Execute $tx -Argument $ta) `
        -Trigger @((New-ScheduledTaskTrigger -AtLogOn -User $me), (New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 2))) `
        -Principal (New-ScheduledTaskPrincipal -UserId $me -LogonType Interactive -RunLevel Limited) `
        -Settings (New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable)
    Check 'tâche : définition réelle des cmdlets ⇒ identique' (Test-SameWatchdogTask $real $tx $ta $me)
    Check 'tâche : définition réelle, autre argument ⇒ reposée' (-not (Test-SameWatchdogTask $real $tx "$ta -AllowWrite" $me))
}

# ── Renoncer avant de couper (poste saturé) ──
Check 'préparation normale ⇒ on déploie' (-not (Test-PrepareTooSlow 5.2 20 $false $true))
Check 'préparation à la limite ⇒ on déploie' (-not (Test-PrepareTooSlow 20 20 $false $true))
Check 'préparation trop longue, serveur en service ⇒ on renonce' (Test-PrepareTooSlow 80.4 20 $false $true)
Check 'préparation trop longue sous -Force ⇒ on déploie' (-not (Test-PrepareTooSlow 80.4 20 $true $true))
Check 'préparation trop longue, aucun serveur en service ⇒ on déploie' (-not (Test-PrepareTooSlow 80.4 20 $false $false))
Check 'limite à 0 ⇒ jamais de renoncement' (-not (Test-PrepareTooSlow 80.4 0 $false $true))

# ── Mise à jour automatique : décisions ──
$A = 'a' * 40; $B = 'b' * 40
$run = { param($s, $c) [pscustomobject]@{ status = $s; conclusion = $c } }
Check 'contrôles : tous verts ⇒ ok' ((Get-ChecksVerdict @((& $run 'completed' 'success'), (& $run 'completed' 'skipped'))) -eq 'ok')
Check 'contrôles : un en cours ⇒ pending' ((Get-ChecksVerdict @((& $run 'completed' 'success'), (& $run 'in_progress' $null))) -eq 'pending')
Check 'contrôles : un rouge ⇒ failed' ((Get-ChecksVerdict @((& $run 'completed' 'success'), (& $run 'completed' 'failure'))) -eq 'failed')
Check 'contrôles : un annulé ⇒ failed' ((Get-ChecksVerdict @((& $run 'completed' 'cancelled'))) -eq 'failed')
Check 'contrôles : aucun ⇒ unknown (on ne déploie pas sans savoir)' ((Get-ChecksVerdict @()) -eq 'unknown')
$dec = { param($over) $p = @{ Branch = 'main'; Dirty = $false; Ahead = 0; Remote = $B; Deployed = $A; DeployedOnMain = $true; Checks = 'ok' }; foreach ($k in $over.Keys) { $p[$k] = $over[$k] }; (Get-UpdateDecision @p).Action }
Check 'mise à jour : main a avancé, contrôles verts ⇒ update' ((& $dec @{}) -eq 'update')
Check 'mise à jour : déjà sur main ⇒ none, quel que soit le reste' ((& $dec @{ Deployed = $B; Branch = 'autre'; Dirty = $true; Checks = 'failed' }) -eq 'none')
Check 'mise à jour : contrôles en cours ⇒ wait' ((& $dec @{ Checks = 'pending' }) -eq 'wait')
Check 'mise à jour : contrôles rouges ⇒ wait, jamais déployé' ((& $dec @{ Checks = 'failed' }) -eq 'wait')
Check 'mise à jour : contrôles illisibles ⇒ wait' ((& $dec @{ Checks = 'unknown' }) -eq 'wait')
Check 'mise à jour : clone sur une autre branche ⇒ refuse' ((& $dec @{ Branch = 'feat/x' }) -eq 'refuse')
Check 'mise à jour : clone modifié ⇒ refuse' ((& $dec @{ Dirty = $true }) -eq 'refuse')
Check 'mise à jour : commits locaux ⇒ refuse' ((& $dec @{ Ahead = 2 }) -eq 'refuse')
Check 'mise à jour : version en service hors de main ⇒ refuse (posée à la main)' ((& $dec @{ DeployedOnMain = $false }) -eq 'refuse')
Check 'mise à jour : commit en service inconnu, contrôles verts ⇒ update' ((& $dec @{ Deployed = '' }) -eq 'update')
Check 'mise à jour : la raison nomme le commit visé' ((Get-UpdateDecision -Branch main -Dirty $false -Ahead 0 -Remote $B -Deployed $A -DeployedOnMain $true -Checks ok).Why -match 'bbbbbbbbbb')

if ($script:fail) { Write-Host "$($script:fail) échec(s)"; exit 1 }
Write-Host 'tous les tests passent'
