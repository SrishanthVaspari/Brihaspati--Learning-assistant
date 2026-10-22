param(
  [Parameter(Mandatory=$false)][string]$StatePath = "",
  [Parameter(Mandatory=$false)][string]$UserSid,
  [Parameter(Mandatory=$false)][string]$SessionId,
  [Parameter(Mandatory=$false)][int]$ParentPid = 0,
  [Parameter(Mandatory=$false)][string]$StopFlagPath,
  [Parameter(Mandatory=$false)][switch]$NoElevate,
  [Parameter(Mandatory=$false)][switch]$ForceRestore
)

# LifeOS Focus Guard v23 — crash + emergency recovery.
# This script NEVER closes LifeOS. It only restores the exact saved network
# state, removes LifeOS firewall rules, and stops the separate app worker.
$ErrorActionPreference='SilentlyContinue'

function Test-IsAdmin {
  try {
    $id=[Security.Principal.WindowsIdentity]::GetCurrent()
    $p=New-Object Security.Principal.WindowsPrincipal($id)
    return $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  } catch { return $false }
}

# The standalone Emergency-FocusGuard.cmd can invoke this script unelevated.
# Elevate only this recovery process, not LifeOS itself.
if(-not $NoElevate -and -not (Test-IsAdmin)){
  try {
    $argList=@('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',"`"$PSCommandPath`"",'-StatePath',"`"$StatePath`"")
    if($ForceRestore){$argList += @('-ForceRestore')}
    if($UserSid){$argList += @('-UserSid',"`"$UserSid`"")}
    if($SessionId){$argList += @('-SessionId',"`"$SessionId`"")}
    Start-Process -FilePath "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -Verb RunAs -ArgumentList $argList | Out-Null
  } catch {
    Write-Error "Administrator elevation was cancelled or failed: $($_.Exception.Message)"
    exit 1
  }
  exit 0
}

if([string]::IsNullOrWhiteSpace($UserSid)){
  try { $UserSid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value } catch {}
}

function Get-State {
  try { if(Test-Path -LiteralPath $StatePath){ return Get-Content -Raw -LiteralPath $StatePath | ConvertFrom-Json } } catch {}
  return $null
}

function Get-ProcessInfo([int]$ProcessId){
  # Get-CimInstance Win32_Process has been observed returning nothing for LIVE
  # processes in spawned (non-interactive) PowerShell children, which made the
  # watchdog believe a live owner had died. Get-Process / .NET are reliable in
  # the same context, so liveness always uses Get-Process. CIM is only a
  # best-effort enrichment for the command line, never the liveness gate.
  try { $p = Get-Process -Id $ProcessId -ErrorAction Stop; if($p -and -not $p.HasExited){ return $p } } catch { return $null }
  return $null
}

function Get-ProcessCommandLine([int]$ProcessId){
  for($i=0;$i -lt 2;$i++){
    try {
      $row = Get-CimInstance Win32_Process -Filter "ProcessId=$ProcessId" -ErrorAction Stop
      if($row){ return [string]$row.CommandLine }
    } catch { Start-Sleep -Milliseconds 300 }
  }
  return ''
}

function Test-PidAlive([int]$ProcessId){
  if($ProcessId -le 0){ return $false }
  try {
    $p = Get-ProcessInfo $ProcessId
    return [bool]$p
  } catch { return $false }
}

function Test-OwnerAlive($state){
  try {
    $pidToCheck=0
    if($state -and $state.parentPid){ $pidToCheck=[int]$state.parentPid }
    elseif($ParentPid -gt 0){ $pidToCheck=$ParentPid }
    if($pidToCheck -le 0){ return $false }
    $p = Get-ProcessInfo $pidToCheck
    if(-not $p){ return $false }
    $expectedExe=''
    if($state){ $expectedExe=[string]$state.parentExePath }
    $actualExe=''
    try { $actualExe=[string]$p.Path } catch {}
    # Empty Path is common for some hosts; only treat as dead when BOTH paths
    # are known and they disagree. Never invent a crash from missing metadata.
    if($expectedExe -and $actualExe -and $expectedExe.TrimEnd('\').ToLowerInvariant() -ne $actualExe.TrimEnd('\').ToLowerInvariant()){return $false}
    return $true
  } catch { return $false }
}

function Test-StopRequested {
  if([string]::IsNullOrWhiteSpace($StopFlagPath)){ return $false }
  try { return Test-Path -LiteralPath $StopFlagPath } catch { return $false }
}

function Stop-Worker([int]$WorkerPid){
  if($WorkerPid -le 0){return}
  try {
    $p = Get-ProcessInfo $WorkerPid
    if(-not $p){ return }
    $procPath=''
    try { $procPath=[string]$p.Path } catch {}
    if($procPath -and $procPath -notmatch '(?i)powershell\.exe$'){ return }
    $cmd = Get-ProcessCommandLine $WorkerPid
    # Identity gate: kill only when the command line proves it is our worker,
    # OR when CIM is unavailable in this context but the PID came from this
    # session's own state file and the process really is a PowerShell host.
    if($cmd -match '(?i)focusguardworker\.ps1'){
      Stop-Process -Id $WorkerPid -Force -ErrorAction SilentlyContinue
    } elseif(-not $cmd -and $procPath -match '(?i)powershell\.exe$'){
      Stop-Process -Id $WorkerPid -Force -ErrorAction SilentlyContinue
    }
  } catch {}
}

function Restore-Hosts($state){
  $hostsPath=Join-Path $env:SystemRoot 'System32\drivers\etc\hosts'
  $backupPath=Join-Path (Split-Path -Parent $StatePath) 'focus-guard-hosts-backup.txt'
  try {
    if(Test-Path -LiteralPath $backupPath){
      Copy-Item -LiteralPath $backupPath -Destination $hostsPath -Force -ErrorAction Stop
      $a=[IO.File]::ReadAllBytes($backupPath)
      $b=[IO.File]::ReadAllBytes($hostsPath)
      if($a.Length -ne $b.Length){return $false}
      for($i=0;$i -lt $a.Length;$i++){if($a[$i] -ne $b[$i]){return $false}}
      Remove-Item -LiteralPath $backupPath -Force -ErrorAction SilentlyContinue
      & ipconfig.exe /flushdns 2>$null | Out-Null
      return $true
    }
    if($state -and $null -ne $state.hostsBackup){
      $enc=New-Object System.Text.UTF8Encoding($false)
      [IO.File]::WriteAllText($hostsPath,[string]$state.hostsBackup,$enc)
      & ipconfig.exe /flushdns 2>$null | Out-Null
      return ([IO.File]::ReadAllText($hostsPath) -eq [string]$state.hostsBackup)
    }
    # Fail-safe: Clean markers directly from hosts file if backup was missing
    if(Test-Path -LiteralPath $hostsPath){
      $content = [IO.File]::ReadAllText($hostsPath)
      if($content -match '# === LifeOS FocusGuard Blocklist ==='){
        $idx = $content.IndexOf('# === LifeOS FocusGuard Blocklist ===')
        $clean = $content.Substring(0, $idx).TrimEnd() + [Environment]::NewLine
        [IO.File]::WriteAllText($hostsPath, $clean, [System.Text.Encoding]::UTF8)
      }
    }
    & ipconfig.exe /flushdns 2>$null | Out-Null
    return $true
  } catch { return $false }
}

function Stop-Enforcer([int]$EnforcerPid){
  if($EnforcerPid -le 0){return $true}
  try{
    $p=Get-ProcessInfo $EnforcerPid
    if(-not $p){return $true}
    $cmd=Get-ProcessCommandLine $EnforcerPid
    if($cmd -notmatch '(?i)focusGuardEnforcer\.cjs'){return $false}
    Stop-Process -Id $EnforcerPid -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 200
    return -not (Test-PidAlive $EnforcerPid)
  }catch{return $false}
}

function Restore-Proxy($backup){
  $key=if($UserSid){ "Registry::HKEY_USERS\$UserSid\Software\Microsoft\Windows\CurrentVersion\Internet Settings" } else { 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings' }
  try {
    if($backup){
      Set-ItemProperty -Path $key -Name ProxyEnable -Type DWord -Value ([int]$backup.ProxyEnable) -ErrorAction SilentlyContinue
      foreach($n in @('ProxyServer','ProxyOverride','AutoConfigURL')){
        $prop=$backup.PSObject.Properties[$n]
        if($prop -and $null -ne $prop.Value -and [string]$prop.Value -ne ''){
          Set-ItemProperty -Path $key -Name $n -Type String -Value ([string]$prop.Value) -ErrorAction SilentlyContinue
        } else {
          Remove-ItemProperty -Path $key -Name $n -ErrorAction SilentlyContinue
        }
      }
      Set-ItemProperty -Path $key -Name AutoDetect -Type DWord -Value ([int]$backup.AutoDetect) -ErrorAction SilentlyContinue
    } else {
      # Emergency fail-safe: Force-disable proxy
      Set-ItemProperty -Path $key -Name ProxyEnable -Type DWord -Value 0 -ErrorAction SilentlyContinue
      Remove-ItemProperty -Path $key -Name ProxyServer -ErrorAction SilentlyContinue
      Remove-ItemProperty -Path $key -Name ProxyOverride -ErrorAction SilentlyContinue
      Remove-ItemProperty -Path $key -Name AutoConfigURL -ErrorAction SilentlyContinue
    }

    # Also reset HKCU and other user profiles
    Set-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings' -Name ProxyEnable -Type DWord -Value 0 -ErrorAction SilentlyContinue
    Remove-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings' -Name ProxyServer -ErrorAction SilentlyContinue
    Remove-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings' -Name ProxyOverride -ErrorAction SilentlyContinue

    Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class LifeOSWinInetRecovery {
  [DllImport("wininet.dll", SetLastError=true)]
  public static extern bool InternetSetOption(IntPtr hInternet, int dwOption, IntPtr lpBuffer, int dwBufferLength);
}
'@ -ErrorAction SilentlyContinue
    [void][LifeOSWinInetRecovery]::InternetSetOption([IntPtr]::Zero,39,[IntPtr]::Zero,0)
    [void][LifeOSWinInetRecovery]::InternetSetOption([IntPtr]::Zero,37,[IntPtr]::Zero,0)

    & netsh.exe winhttp reset proxy 2>$null | Out-Null
    & ipconfig.exe /flushdns 2>$null | Out-Null
    return $true
  } catch { return $false }
}

function Remove-FirewallRules($state){
  # 1. Remove rules listed explicitly in state
  foreach($name in @($state.firewallRuleNames)){
    if([string]::IsNullOrWhiteSpace([string]$name)){continue}
    try { & netsh.exe advfirewall firewall delete rule "name=$name" 2>$null | Out-Null } catch {}
  }
  # 2. Match all LifeOS_FG_* rules by prefix for fail-safe complete removal
  try {
    if(Get-Command -Name Get-NetFirewallRule -ErrorAction SilentlyContinue){
      Get-NetFirewallRule -DisplayName "LifeOS_FG_*" -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction SilentlyContinue
    }
  } catch {}
  try { & netsh.exe advfirewall firewall delete rule name="LifeOS_FG_Allow_DNS" 2>$null | Out-Null } catch {}
  try { & netsh.exe advfirewall firewall delete rule name="LifeOS_FG_Allow_WisprFlow" 2>$null | Out-Null } catch {}
  try { & netsh.exe advfirewall firewall delete rule name="LifeOS_FG_Allow_StudyWeb" 2>$null | Out-Null } catch {}
  try { & netsh.exe advfirewall firewall delete rule name="LifeOS_FG_Block_QUIC" 2>$null | Out-Null } catch {}
  try { & netsh.exe advfirewall firewall delete rule name="LifeOS_FG_Block_DoH" 2>$null | Out-Null } catch {}
  try { & netsh.exe advfirewall firewall delete rule name="LifeOS_FG_Block_NonStudy_Web" 2>$null | Out-Null } catch {}
}

function Test-FirewallReleased($state){
  try {
    if(Get-Command -Name Get-NetFirewallRule -ErrorAction SilentlyContinue){
      $remaining = @(Get-NetFirewallRule -DisplayName "LifeOS_FG_*" -ErrorAction SilentlyContinue)
      foreach($rule in $remaining){
        if([string]$rule.Enabled -eq 'True'){return $false}
      }
    }
  } catch {}
  return $true
}

function Remove-RunOnce([string]$Name){
  if([string]::IsNullOrWhiteSpace($Name)){return}
  try{
    if($UserSid){& reg.exe delete "HKU\$UserSid\Software\Microsoft\Windows\CurrentVersion\RunOnce" /v $Name /f 2>$null | Out-Null}
    else{& reg.exe delete "HKCU\Software\Microsoft\Windows\CurrentVersion\RunOnce" /v $Name /f 2>$null | Out-Null}
  }catch{}
}

function Cleanup-Once($state){
  if(-not $state){return $true}
  # Restore hosts first, then any legacy proxy snapshot. Verify before releasing the rest.
  $hostsOk=Restore-Hosts $state
  if(-not $hostsOk){ return $false }
  $proxyOk=Restore-Proxy($state.originalProxy)
  if(-not $proxyOk){ return $false }
  Remove-FirewallRules $state
  if(-not (Test-FirewallReleased $state)){ return $false }
  Stop-Worker ([int]$state.appWorkerPid)
  if($state.appEnforcerPid){ if(-not (Stop-Enforcer ([int]$state.appEnforcerPid))){ return $false } }
  Remove-RunOnce ([string]$state.runOnceName)
  try { Remove-Item -LiteralPath $StatePath -Force -ErrorAction SilentlyContinue } catch {}
  return $true
}

# Monitor only. Intentional LifeOS teardown writes a stop flag and reaps this
# process; that is NOT a crash. Cleanup runs only when the owner is actually
# gone. A missing state file while the owner is alive is a torn write, not
# "Focus is off" — never exit 0 in that case (that created the restart storm).
Write-Output "WATCHDOG_MONITOR parent=$ParentPid session=$SessionId"
$missingStreak=0
while($true){
  if(Test-StopRequested){
    Write-Output 'WATCHDOG_STOP_FLAG received — exiting without cleanup'
    exit 0
  }

  $state=Get-State
  if($ForceRestore){
    if(-not $state){
      $state=[pscustomobject]@{hostsBackup=$null;firewallRuleNames=@();originalProxy=$null}
    }
    $success=$false
    for($attempt=0;$attempt -lt 6;$attempt++){
      if(Cleanup-Once $state){$success=$true;break}
      Start-Sleep -Milliseconds 500
      $state=Get-State
      if(-not $state){$state=[pscustomobject]@{hostsBackup=$null;firewallRuleNames=@();originalProxy=$null}}
    }
    if($success){exit 0}
    exit 2
  }
  if(Test-OwnerAlive $state){
    $missingStreak=0
    Start-Sleep -Milliseconds 1200
    continue
  }
  if($ParentPid -gt 0 -and (Test-PidAlive $ParentPid)){
    $missingStreak=0
    Start-Sleep -Milliseconds 1200
    continue
  }

  # Require three consecutive liveness misses before declaring the owner dead.
  $missingStreak++
  if($missingStreak -lt 3){ Start-Sleep -Milliseconds 800; continue }
  $missingStreak=0

  # Owner is gone. Restore the machine. Bounded retries, then keep looping
  # rather than abandoning a restricted network.
  if(-not $state){
    break
  }
  $status=[string]$state.status
  if($status -eq 'stopping' -or $status -eq 'restoring'){
    # Main process owns teardown. Do not race it.
    Start-Sleep -Milliseconds 1500
    if(-not (Test-OwnerAlive $state) -and -not (Test-PidAlive $ParentPid)){
      $cleaned=Cleanup-Once $state
      if($cleaned){ break }
    }
    continue
  }

  $success=$false
  for($attempt=0;$attempt -lt 6;$attempt++){
    if(Cleanup-Once $state){$success=$true;break}
    Start-Sleep -Milliseconds 800
    $state=Get-State
    if(-not $state){$success=$true;break}
  }
  if($success){break}
}

# If state is missing there is no authoritative pre-focus snapshot. Do not
# guess at the user's proxy/PAC configuration. A RunOnce/state-backed recovery
# remains the supported restoration path.
