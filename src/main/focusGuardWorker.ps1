param(
  [Parameter(Mandatory=$true)][int]$ParentPid,
  [Parameter(Mandatory=$true)][string]$AllowedAppsBase64,
  [Parameter(Mandatory=$false)][string]$BlockedAppsBase64,
  [Parameter(Mandatory=$false)][string]$LifeOSRootBase64,
  [Parameter(Mandatory=$false)][string]$ParentExePathBase64,
  [Parameter(Mandatory=$false)][string]$SessionId,
  [Parameter(Mandatory=$false)][string]$ProtectedPidsBase64,
  [Parameter(Mandatory=$false)][string]$IdentityPath,
  [Parameter(Mandatory=$false)][switch]$TestMode
)

# LifeOS Focus Guard — real Windows application enforcement.
# Policy: EXPLICIT BLOCKED -> terminate; EXPLICIT ALLOWED -> allow;
# PROTECTED -> never terminate; UNKNOWN -> allow.
# The monitor uses Win32_ProcessStartTrace when available and a lightweight
# PID-delta sweep as a fallback. It does not use "not allowed = blocked".
$ErrorActionPreference='SilentlyContinue'
$script:enforcementEnabled=$true

function Decode-Json([string]$b64) {
  try { return [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b64)) | ConvertFrom-Json } catch { return @() }
}

function Normalize-Path([string]$value) {
  if([string]::IsNullOrWhiteSpace($value)){ return '' }
  try { return [IO.Path]::GetFullPath($value).TrimEnd('\').ToLowerInvariant() } catch { return $value.Trim().TrimEnd('\').ToLowerInvariant() }
}

function New-Rule($raw) {
  $pathValue='';$nameValue='';$appIdValue='';$dirValue='';$enabled=$true
  if($raw -is [string]){
    $pathValue=[string]$raw
  } else {
    try { $pathValue=[string]$raw.path } catch {}
    if(-not $pathValue){ try { $pathValue=[string]$raw.executablePath } catch {} }
    try { $nameValue=[string]$raw.name } catch {}
    if(-not $nameValue){ try { $nameValue=[string]$raw.executableName } catch {} }
    try { $appIdValue=[string]$raw.appId } catch {}
    try { $dirValue=[string]$raw.dirScope } catch {}
    try { if($null -ne $raw.enabled){ $enabled=[bool]$raw.enabled } } catch {}
  }
  $pathValue=Normalize-Path $pathValue
  $dirValue=Normalize-Path $dirValue
  $nameValue=[string]$nameValue.ToLowerInvariant()
  if($nameValue -and -not $nameValue.EndsWith('.exe')){ $nameValue += '.exe' }
  return [pscustomobject]@{
    Path=$pathValue
    Name=$nameValue
    AppId=[string]$appIdValue.ToLowerInvariant()
    DirScope=$dirValue
    Enabled=$enabled
  }
}

$allowedEntries = @($(Decode-Json $AllowedAppsBase64) | ForEach-Object { New-Rule $_ } | Where-Object { $_.Path -or $_.Name -or $_.AppId })
$blockedEntries = @($(Decode-Json $BlockedAppsBase64) | ForEach-Object { New-Rule $_ } | Where-Object { $_.Enabled -and ($_.Path -or $_.Name -or $_.AppId) })

$lifeosRoot=''
if($LifeOSRootBase64){
  try { $lifeosRoot=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($LifeOSRootBase64)) } catch { $lifeosRoot='' }
  $lifeosRoot=Normalize-Path $lifeosRoot
}

$protectedPids=[System.Collections.Generic.HashSet[int]]::new()
[void]$protectedPids.Add($ParentPid)
[void]$protectedPids.Add($PID)
foreach($p in @(Decode-Json $ProtectedPidsBase64)){
  try{[void]$protectedPids.Add([int]$p)}catch{}
}

$windowsSystemNames=@(
  'system','idle','registry','smss.exe','csrss.exe','wininit.exe','winlogon.exe','services.exe','lsass.exe',
  'svchost.exe','dwm.exe','explorer.exe','sihost.exe','ctfmon.exe','fontdrvhost.exe','runtimebroker.exe',
  'searchhost.exe','searchapp.exe','startmenuexperiencehost.exe','shellexperiencehost.exe','applicationframehost.exe',
  'textinputhost.exe','securityhealthsystray.exe','securityhealthservice.exe','smartscreen.exe','taskhostw.exe',
  'backgroundtaskhost.exe','dllhost.exe','spoolsv.exe','audiodg.exe','conhost.exe','openconsole.exe','windowsterminal.exe',
  'msmpeng.exe','mpdefendercoreservice.exe','nissrv.exe','lsaiso.exe','wudfhost.exe'
)

$protectedSystemRoots=@(
  (Normalize-Path (Join-Path $env:WINDIR 'System32')) + '\',
  (Normalize-Path (Join-Path $env:WINDIR 'SysWOW64')) + '\',
  (Normalize-Path (Join-Path $env:WINDIR 'SystemApps')) + '\'
)

$builtinAllowedPrefixes=[System.Collections.Generic.List[string]]::new()

$builtinAllowedNames=@()

function Test-IsWisprFlow([object]$Info) {
  if(-not $Info){return $false}
  $exe=Normalize-Path ([string]$Info.ExecutablePath)
  $name=[string]$Info.Name
  if($name -and $name.ToLowerInvariant() -match '^(wispr|wisprflow|wispr_flow|flow)\.exe$'){return $true}
  if($exe -and $exe -match '(?i)\\wispr|wisprflow|wispr-flow\\'){return $true}
  return $false
}

$ownerExe=''
try{$ownerExe=Normalize-Path ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($ParentExePathBase64)))}catch{}
$script:ownerAliveCacheUntil=[DateTime]::MinValue
$script:ownerAliveCache=$false
$script:loggedDecisions=@{}
$script:blockedTreePids=@{}

function Test-OwnerAlive {
  $now=[DateTime]::UtcNow
  if($now -lt $script:ownerAliveCacheUntil){return $script:ownerAliveCache}
  $alive=$false
  try{
    $p=Get-Process -Id $ParentPid -ErrorAction SilentlyContinue
    if($p -and -not $p.HasExited){
      $alive=$true
      if($ownerExe){
        $actual=''
        try{$actual=Normalize-Path ([string]$p.Path)}catch{}
        if($actual -and $actual -ne $ownerExe){$alive=$false}
      }
    }
  }catch{}
  $script:ownerAliveCache=$alive
  $script:ownerAliveCacheUntil=$now.AddSeconds(1)
  return $alive
}

function Get-ProcessInfo([int]$ProcessId) {
  if($ProcessId -le 0){return $null}
  try{
    $row=Get-CimInstance Win32_Process -Filter "ProcessId=$ProcessId" -ErrorAction SilentlyContinue
    if($row){
      return [pscustomobject]@{
        ProcessId=[int]$row.ProcessId
        Name=[string]$row.Name
        ExecutablePath=Normalize-Path ([string]$row.ExecutablePath)
        SessionId=0
        ParentProcessId=[int]$row.ParentProcessId
        CommandLine=[string]$row.CommandLine
        PackageFullName=''
      }
    }
  }catch{}
  try{
    $p=Get-Process -Id $ProcessId -ErrorAction Stop
    if(-not $p -or $p.HasExited){return $null}
    $exe='';try{$exe=Normalize-Path ([string]$p.Path)}catch{}
    return [pscustomobject]@{
      ProcessId=$p.Id;Name=[string]$p.ProcessName;ExecutablePath=$exe;SessionId=$p.SessionId;ParentProcessId=0;CommandLine='';PackageFullName=''
    }
  }catch{return $null}
}

function Get-ProcessSnapshot {
  $rows=@()
  try{
    foreach($row in @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)){
      try{
        $rows += [pscustomobject]@{
          ProcessId=[int]$row.ProcessId
          Name=[string]$row.Name
          ExecutablePath=Normalize-Path ([string]$row.ExecutablePath)
          SessionId=0
          ParentProcessId=[int]$row.ParentProcessId
          CommandLine=[string]$row.CommandLine
          PackageFullName=''
        }
      }catch{}
    }
  }catch{}
  return @($rows)
}

function Get-DescendantPids([int]$RootPid, $Snapshot) {
  $seen=[System.Collections.Generic.HashSet[int]]::new()
  if($RootPid -gt 0){[void]$seen.Add($RootPid)}
  $queue=@($Snapshot)
  $changed=$true
  while($changed){
    $changed=$false
    foreach($row in $queue){
      $child=0;$parent=0
      try{$child=[int]$row.ProcessId;$parent=[int]$row.ParentProcessId}catch{continue}
      if($child -gt 0 -and $parent -gt 0 -and $seen.Contains($parent) -and -not $seen.Contains($child)){
        [void]$seen.Add($child);$changed=$true
      }
    }
  }
  return @($seen | Where-Object {$_ -ne $RootPid})
}

function Protect-LifeOSDescendants($Snapshot) {
  foreach($pidValue in @(Get-DescendantPids $ParentPid $Snapshot)){[void]$protectedPids.Add([int]$pidValue)}
}

function Test-NameInList([string]$Name,$list) {
  if([string]::IsNullOrWhiteSpace($Name)){return $false}
  $n=$Name.ToLowerInvariant()
  if(-not $n.EndsWith('.exe')){$n += '.exe'}
  return $list -contains $n
}

function Test-Prefix([string]$Exe,$prefixes) {
  $full=Normalize-Path $Exe
  if(-not $full){return $false}
  foreach($prefix in @($prefixes)){
    if(-not $prefix){continue}
    $p=Normalize-Path $prefix
    if($p -and ($full -eq $p -or $full.StartsWith($p+'\'))){return $true}
  }
  return $false
}

function Test-RuleMatch($info,$entries,[ref]$matchedRule) {
  $exe=Normalize-Path ([string]$info.ExecutablePath)
  $name=[string]$info.Name
  if($name){$name=$name.ToLowerInvariant();if(-not $name.EndsWith('.exe')){$name += '.exe'}}
  $appId=[string]$info.PackageFullName
  if($appId){$appId=$appId.ToLowerInvariant()}
  foreach($entry in @($entries)){
    if($entry.Path -and $exe -and $exe -eq $entry.Path){$matchedRule.Value=$entry;return 'exact-path'}
    if($entry.DirScope -and $exe -and ($exe -eq $entry.DirScope -or $exe.StartsWith($entry.DirScope+'\'))){$matchedRule.Value=$entry;return 'install-directory'}
    if($entry.Name -and $name -and $name -eq $entry.Name -and -not $entry.Path){$matchedRule.Value=$entry;return 'name-only'}
    if($entry.AppId -and $appId -and $appId -eq $entry.AppId){$matchedRule.Value=$entry;return 'appx'}
  }
  return ''
}

function Test-ProtectedProcess([object]$Info) {
  if(-not $Info){return $true}
  $id=0;try{$id=[int]$Info.ProcessId}catch{}
  if($id -le 0){return $true}
  if($protectedPids.Contains($id)){return $true}
  if(Test-IsWisprFlow $Info){return $true}
  $systemExe=Normalize-Path ([string]$Info.ExecutablePath)
  foreach($root in $protectedSystemRoots){if($systemExe -and $root -and $systemExe.StartsWith($root)){return $true}}
  if($lifeosRoot -and $systemExe -and ($systemExe -eq $lifeosRoot -or $systemExe.StartsWith($lifeosRoot+'\'))){return $true}
  if($ownerExe -and $systemExe -and $systemExe -eq $ownerExe){return $true}
  if(Test-NameInList ([string]$Info.Name) $windowsSystemNames){return $true}
  $cmd=[string]$Info.CommandLine
  if($cmd -and $cmd.ToLowerInvariant() -match 'focusguardrecovery\.ps1|focusguardworker\.ps1|emergency-focusguard|scripts-repair-focusguard'){return $true}
  return $false
}

function Get-Decision([object]$Info) {
  if(Test-ProtectedProcess $Info){return @{Class='PROTECTED';Reason='protected Windows/LifeOS process'}}
  $blockedRule=$null
  $blockedHow=Test-RuleMatch $Info $blockedEntries ([ref]$blockedRule)
  if($blockedHow){return @{Class='BLOCKED';Reason="explicitly configured blocked application ($blockedHow)";Rule=$blockedRule}}
  $allowedRule=$null
  $allowedHow=Test-RuleMatch $Info $allowedEntries ([ref]$allowedRule)
  if($allowedHow){return @{Class='ALLOWED';Reason="explicitly allowed application ($allowedHow)"}}
  if(Test-Prefix ([string]$Info.ExecutablePath) $builtinAllowedPrefixes){return @{Class='ALLOWED';Reason='explicitly allowed application (built-in identity)'}}
  if(Test-NameInList ([string]$Info.Name) $builtinAllowedNames){
    $n=[string]$Info.Name.ToLowerInvariant()
    if($n -eq 'update.exe'){
      $discordRoot=Normalize-Path (Join-Path $env:LOCALAPPDATA 'Discord')
      if($discordRoot -and (Test-Prefix ([string]$Info.ExecutablePath) @($discordRoot))){return @{Class='ALLOWED';Reason='Discord helper'}}
    }else{return @{Class='ALLOWED';Reason='explicitly allowed application (built-in name)'}}
  }
  return @{Class='UNKNOWN';Reason='not explicitly blocked'}
}

function Should-LogDecision($Info,$Decision,$action) {
  try{
    $key="{0}|{1}|{2}" -f [int]$Info.ProcessId,(Normalize-Path $Info.ExecutablePath),$Decision.Class
    if($action -eq 'TERMINATED' -or -not $script:loggedDecisions.ContainsKey($key)){
      $script:loggedDecisions[$key]=[DateTime]::UtcNow
      return $true
    }
  }catch{}
  return $false
}

function Write-DecisionLog($info,$decision,$action) {
  if(-not (Should-LogDecision $info $decision $action)){return}
  $name=[string]$info.Name
  $pidValue=[int]$info.ProcessId
  $exe=[string]$info.ExecutablePath
  switch($action){
    'ALLOW' { Write-Output "[AppBlock] ALLOW $name pid=$pidValue $exe" }
    'PROTECTED' { Write-Output "[AppBlock] PROTECTED $name pid=$pidValue $exe" }
    'BLOCK' { Write-Output "[AppBlock] BLOCK $name pid=$pidValue $exe" }
    default { Write-Output "[AppBlock] $action $name pid=$pidValue $exe" }
  }
}

function Invoke-ExactTerminate([int]$PidValue) {
  if($PidValue -le 0 -or $PidValue -eq $ParentPid -or $PidValue -eq $PID){return $false}
  try { Stop-Process -Id $PidValue -Force -ErrorAction SilentlyContinue } catch {}
  try {
    if(Get-Process -Id $PidValue -ErrorAction SilentlyContinue){
      & taskkill.exe /PID $PidValue /F 2>$null | Out-Null
    }
  } catch {}
  Start-Sleep -Milliseconds 80
  try { return -not (Get-Process -Id $PidValue -ErrorAction SilentlyContinue) } catch { return $true }
}

function Stop-BlockedProcess([object]$Info,[object[]]$Snapshot) {
  $rootPid=[int]$Info.ProcessId
  if($rootPid -le 0 -or $rootPid -eq $ParentPid -or $rootPid -eq $PID){return}
  Write-DecisionLog $Info @{Class='BLOCKED'} 'BLOCK'
  $script:blockedTreePids[$rootPid]=[DateTime]::UtcNow.AddSeconds(10)

  $children=@(Get-DescendantPids $rootPid $Snapshot)
  $protectedChildren=0
  foreach($childPid in ($children | Sort-Object -Descending)){
    $childInfo=Get-ProcessInfo ([int]$childPid)
    if(-not $childInfo){continue}
    if(Test-ProtectedProcess $childInfo){
      $protectedChildren++
      Write-DecisionLog $childInfo @{Class='PROTECTED'} 'PROTECTED'
      continue
    }
    [void](Invoke-ExactTerminate ([int]$childPid))
  }

  # Re-read the root immediately before killing it to avoid PID-reuse races.
  $current=Get-ProcessInfo $rootPid
  if(-not $current){return}
  if(Test-ProtectedProcess $current){Write-DecisionLog $current @{Class='PROTECTED'} 'PROTECTED';return}
  $sameExe=$true
  $origExe=Normalize-Path ([string]$Info.ExecutablePath)
  $nowExe=Normalize-Path ([string]$current.ExecutablePath)
  if($origExe -and $nowExe -and $origExe -ne $nowExe){$sameExe=$false}
  if(-not $sameExe){return}
  $gone=Invoke-ExactTerminate $rootPid
  if($gone){Write-Output "[AppBlock] TERMINATED $([string]$Info.Name) pid=$rootPid $([string]$Info.ExecutablePath)"}
  else{Write-Output "[AppBlock] TERMINATE-FAILED $([string]$Info.Name) pid=$rootPid $([string]$Info.ExecutablePath)"}
}

function Evaluate-Process([int]$ProcessId,[object[]]$Snapshot) {
  if(-not $script:enforcementEnabled){return}
  if($ProcessId -le 0 -or $ProcessId -eq $ParentPid -or $ProcessId -eq $PID){return}
  $info=$null
  foreach($row in @($Snapshot)){if([int]$row.ProcessId -eq $ProcessId){$info=$row;break}}
  if(-not $info){$info=Get-ProcessInfo $ProcessId}
  if(-not $info){return}
  $decision=Get-Decision $info
  if($decision.Class -eq 'PROTECTED'){Write-DecisionLog $info $decision 'PROTECTED';return}
  if($decision.Class -eq 'ALLOWED'){Write-DecisionLog $info $decision 'ALLOW';return}

  # A helper can be created just after its explicitly blocked parent exits.
  # Keep the blocked root PID hot for a short window so late children cannot
  # escape merely because the parent disappeared first.
  $parentPid=0;try{$parentPid=[int]$info.ParentProcessId}catch{}
  if($parentPid -gt 0 -and $script:blockedTreePids.ContainsKey($parentPid)){
    $expires=$script:blockedTreePids[$parentPid]
    if([DateTime]::UtcNow -lt $expires){
      Stop-BlockedProcess $info $Snapshot
      return
    }
    $script:blockedTreePids.Remove($parentPid) | Out-Null
  }

  if($decision.Class -ne 'BLOCKED'){Write-DecisionLog $info $decision 'ALLOW';return}
  Stop-BlockedProcess $info $Snapshot
}

function Sweep-ExistingUserApps {
  $snapshot=Get-ProcessSnapshot
  foreach($row in @($snapshot)){try{Evaluate-Process ([int]$row.ProcessId) $snapshot}catch{}}
  return ,$snapshot
}

function Start-NativeProcessStartWatcher {
  try{
    $watcher=New-Object System.Management.ManagementEventWatcher
    $watcher.Query='SELECT * FROM Win32_ProcessStartTrace'
    $watcher.Options.Timeout=[TimeSpan]::FromMilliseconds(300)
    $watcher.Start()
    Write-Output 'PROCESS_WATCHER=WIN32_PROCESS_START_TRACE'
    return $watcher
  }catch{
    Write-Output "PROCESS_WATCHER=PID_POLL_FALLBACK reason=$($_.Exception.Message)"
    return $null
  }
}

function Stop-NativeProcessStartWatcher($watcher) {
  if(-not $watcher){return}
  try{$watcher.Stop()}catch{}
  try{$watcher.Dispose()}catch{}
}

function Write-IdentityFile {
  if([string]::IsNullOrWhiteSpace($IdentityPath)){return}
  try{
    $payload=@{pid=$PID;sessionId=$SessionId;ownerPid=$ParentPid;startedAt=([DateTime]::UtcNow.ToString('o'))}|ConvertTo-Json -Compress
    $dir=[IO.Path]::GetDirectoryName($IdentityPath)
    if($dir -and -not(Test-Path -LiteralPath $dir)){New-Item -ItemType Directory -Path $dir -Force|Out-Null}
    Set-Content -LiteralPath $IdentityPath -Value $payload -Encoding UTF8
  }catch{}
}
function Remove-IdentityFile {if([string]::IsNullOrWhiteSpace($IdentityPath)){return};try{Remove-Item -LiteralPath $IdentityPath -Force -ErrorAction SilentlyContinue}catch{}}

if($TestMode){
  $blockedEntries=@((New-Rule @{path='c:\games\mortal-shell-2.exe';name='mortal-shell-2.exe'}), (New-Rule @{path='c:\games\mortal-shell-2 extras';dirScope='c:\games\mortal-shell-2 extras';name='helper.exe'}))
  $cases=@(
    [pscustomobject]@{Name='unknown.exe';ExecutablePath='c:\tools\unknown.exe';ProcessId=9001;PackageFullName='';ParentProcessId=0;CommandLine=''},
    [pscustomobject]@{Name='WUDFHost.exe';ExecutablePath='c:\windows\system32\WUDFHost.exe';ProcessId=9002;PackageFullName='';ParentProcessId=0;CommandLine=''},
    [pscustomobject]@{Name='mortal-shell-2.exe';ExecutablePath='c:\games\mortal-shell-2.exe';ProcessId=9003;PackageFullName='';ParentProcessId=0;CommandLine=''},
    [pscustomobject]@{Name='Discord.exe';ExecutablePath=(Join-Path $env:LOCALAPPDATA 'Discord\app-1.0.0\Discord.exe');ProcessId=9004;PackageFullName='';ParentProcessId=0;CommandLine=''},
    [pscustomobject]@{Name='VALORANT-Win64-Shipping.exe';ExecutablePath='c:\games\mortal-shell-2 extras\helper.exe';ProcessId=9005;PackageFullName='';ParentProcessId=0;CommandLine=''}
  )
  $expected=@('UNKNOWN','PROTECTED','BLOCKED','ALLOWED','BLOCKED')
  for($i=0;$i -lt $cases.Count;$i++){
    $actual=(Get-Decision $cases[$i]).Class
    Write-Output "TEST;case=$($cases[$i].Name);decision=$actual;expected=$($expected[$i])"
    if($actual -ne $expected[$i]){exit 2}
  }
  exit 0
}

Write-Output "STATE=STARTING session=$SessionId pid=$PID owner=$ParentPid"
Write-IdentityFile
Write-Output "READY;allowedApps=$($allowedEntries.Count);blockedApps=$($blockedEntries.Count);protectedPids=$($protectedPids.Count);session=$SessionId"
$nativeWatcher=Start-NativeProcessStartWatcher
$lastSnapshot=@(Sweep-ExistingUserApps)
if($lastSnapshot.Count -lt 1){
  Start-Sleep -Milliseconds 300
  $lastSnapshot=@(Get-ProcessSnapshot)
  if($lastSnapshot.Count -lt 1){
    Write-Output 'STARTUP_FAILED=process-enumeration-unavailable'
    Stop-NativeProcessStartWatcher $nativeWatcher
    Remove-IdentityFile
    exit 1
  }
}
Write-Output 'SWEEP_DONE'
Write-Output 'STATE=ACTIVE'
Write-Output "[AppBlock] WORKER ACTIVE session=$SessionId pid=$PID blockedApps=$($blockedEntries.Count)"

$known=[System.Collections.Generic.HashSet[int]]::new()
foreach($row in @($lastSnapshot)){try{[void]$known.Add([int]$row.ProcessId)}catch{}}
$lastSweep=[DateTime]::UtcNow
$watcherFailed=$false

try{
  while(Test-OwnerAlive){
    $beforeWait=[DateTime]::UtcNow
    $eventPid=0
    if($nativeWatcher -and -not $watcherFailed){
      try{
        $event=$nativeWatcher.WaitForNextEvent()
        $eventPid=[int]$event.ProcessID
      }catch{
        $watchError=[string]$_.Exception.Message
        if($watchError -notmatch '(?i)timed.?out|timeout|0x80041009'){
          $watcherFailed=$true
          try{$nativeWatcher.Stop()}catch{}
          try{$nativeWatcher.Dispose()}catch{}
          $nativeWatcher=$null
          Write-Output "PROCESS_WATCHER=PID_POLL_FALLBACK reason=$watchError"
        }
      }
    }

    if($eventPid -gt 0){
      if(Test-OwnerAlive){try{Evaluate-Process $eventPid @()}catch{}}
    } else {
      Start-Sleep -Milliseconds 80
    }

    # Lightweight fallback/current-PID change detector. It runs every loop only
    # when the native watcher cannot be used; this guarantees relaunch blocking.
    if($watcherFailed){
      foreach($p in @(Get-Process -ErrorAction SilentlyContinue)){
        try{
          $pidValue=[int]$p.Id
          if($pidValue -gt 0 -and -not $known.Contains($pidValue)){
            [void]$known.Add($pidValue)
            try{Evaluate-Process $pidValue @()}catch{}
          }
        }catch{}
      }
    }

    if(([DateTime]::UtcNow-$lastSweep).TotalSeconds -ge 3){
      if(-not $script:enforcementEnabled){continue}
      try{
        $snapshot=@(Get-ProcessSnapshot)
        Protect-LifeOSDescendants $snapshot
        $liveIds=[System.Collections.Generic.HashSet[int]]::new()
        foreach($row in @($snapshot)){
          try{
            $pidValue=[int]$row.ProcessId
            [void]$liveIds.Add($pidValue)
            # Full safety sweep re-checks explicit blocked identities even if
            # the process start event was missed.
            $name=[string]$row.Name
            $nameNorm=$name.ToLowerInvariant();if($nameNorm -and -not $nameNorm.EndsWith('.exe')){$nameNorm += '.exe'}
            $blockedNameHit=($blockedEntries|Where-Object{$_.Name -and $_.Name -eq $nameNorm}).Count -gt 0
            $pathHit=$false
            $exe=Normalize-Path ([string]$row.ExecutablePath)
            if($exe){$pathHit=($blockedEntries|Where-Object{$_.Path -and $_.Path -eq $exe -or $_.DirScope -and ($exe -eq $_.DirScope -or $exe.StartsWith($_.DirScope+'\'))}).Count -gt 0}
            if($blockedNameHit -or $pathHit){try{Evaluate-Process $pidValue $snapshot}catch{}}
          }catch{}
        }
        $known=$liveIds
      }catch{}
      $lastSweep=[DateTime]::UtcNow
    }
  }
}finally{
  $script:enforcementEnabled=$false
  Stop-NativeProcessStartWatcher $nativeWatcher
  Write-Output 'STATE=STOPPING'
  Remove-IdentityFile
  Write-Output "[AppBlock] WORKER STOPPED session=$SessionId pid=$PID"
  Write-Output 'STATE=STOPPED verified'
}
