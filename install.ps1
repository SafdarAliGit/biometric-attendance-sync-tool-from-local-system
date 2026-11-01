# Biometric Attendance Sync - Windows installer
#   install.ps1            startup task at logon (default) + desktop / Start-menu shortcuts
#   install.ps1 -Service   Windows service via NSSM, starts at boot (run as Administrator)
#   install.ps1 -NoService only create the venv and shortcuts
param([switch]$Service, [switch]$NoService)
$ErrorActionPreference = 'Stop'
$AppDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$TaskName = 'BiometricAttendanceSync'
function Say($m) { Write-Host "==> $m" -ForegroundColor Cyan }
function Warn($m) { Write-Host "!! $m" -ForegroundColor Yellow }

# ---- Python ----
$pyExe = $null; $pyArgs = @()
foreach ($c in @('py -3', 'python', 'python3')) {
    $parts = $c -split ' '
    $exe = $parts[0]; $extra = @($parts | Select-Object -Skip 1)
    try {
        $ok = & $exe @extra -c "import sys; print(1 if sys.version_info >= (3,10) else 0)" 2>$null
        if ("$ok".Trim() -eq '1') { $pyExe = $exe; $pyArgs = $extra; break }
    } catch {}
}
if (-not $pyExe) { Write-Host 'Python 3.10+ is required. Install it from https://www.python.org/downloads/ (tick "Add python.exe to PATH").' -ForegroundColor Red; exit 1 }
Say ("Using " + (& $pyExe @pyArgs --version))

$venvPy = Join-Path $AppDir '.venv\Scripts\python.exe'
$venvPyw = Join-Path $AppDir '.venv\Scripts\pythonw.exe'
if (-not (Test-Path $venvPy)) { Say 'Creating virtual environment'; & $pyExe @pyArgs -m venv (Join-Path $AppDir '.venv') }
Say 'Installing dependencies'
& $venvPy -m pip install --upgrade pip -q
& $venvPy -m pip install -r (Join-Path $AppDir 'requirements.txt') -q
New-Item -ItemType Directory -Force -Path (Join-Path $AppDir 'data') | Out-Null
$runPy = Join-Path $AppDir 'run.py'

# ---- service / startup task ----
if ($Service) {
    $admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    if (-not $admin) { Write-Host 'Run PowerShell as Administrator to install a Windows service.' -ForegroundColor Red; exit 1 }
    $nssm = Join-Path $AppDir 'tools\nssm.exe'
    if (-not (Test-Path $nssm)) {
        Say 'Downloading NSSM (service helper)'
        $zip = Join-Path $env:TEMP 'nssm.zip'
        Invoke-WebRequest 'https://nssm.cc/release/nssm-2.24.zip' -OutFile $zip -UseBasicParsing
        $ex = Join-Path $env:TEMP 'nssm'
        Expand-Archive $zip -DestinationPath $ex -Force
        New-Item -ItemType Directory -Force -Path (Join-Path $AppDir 'tools') | Out-Null
        Copy-Item (Join-Path $ex 'nssm-2.24\win64\nssm.exe') $nssm
    }
    & $nssm stop $TaskName 2>$null | Out-Null
    & $nssm remove $TaskName confirm 2>$null | Out-Null
    & $nssm install $TaskName $venvPy $runPy | Out-Null
    & $nssm set $TaskName AppDirectory $AppDir | Out-Null
    & $nssm set $TaskName DisplayName 'Biometric Attendance Sync' | Out-Null
    & $nssm set $TaskName Start SERVICE_AUTO_START | Out-Null
    & $nssm set $TaskName AppStdout (Join-Path $AppDir 'data\logs\service.log') | Out-Null
    & $nssm set $TaskName AppStderr (Join-Path $AppDir 'data\logs\service.log') | Out-Null
    New-Item -ItemType Directory -Force -Path (Join-Path $AppDir 'data\logs') | Out-Null
    & $nssm start $TaskName | Out-Null
    Warn 'The service runs as LocalSystem. Desktop notifications are not shown by a service; use e-mail alerts instead.'
} elseif (-not $NoService) {
    Say 'Creating startup task (runs at logon, hidden)'
    $action = New-ScheduledTaskAction -Execute $venvPyw -Argument "`"$runPy`"" -WorkingDirectory $AppDir
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Description 'Biometric Attendance Sync background service' | Out-Null
    Start-ScheduledTask -TaskName $TaskName
}

# ---- shortcuts ----
Say 'Creating desktop and Start-menu shortcuts'
$shell = New-Object -ComObject WScript.Shell
$targets = @([Environment]::GetFolderPath('Desktop'), (Join-Path ([Environment]::GetFolderPath('Programs')) ''))
foreach ($dir in $targets) {
    $lnk = $shell.CreateShortcut((Join-Path $dir 'Biometric Attendance Sync.lnk'))
    $lnk.TargetPath = $venvPyw
    $lnk.Arguments = "`"$(Join-Path $AppDir 'launcher.py')`""
    $lnk.WorkingDirectory = $AppDir
    $lnk.IconLocation = "$env:SystemRoot\System32\imageres.dll,27"
    $lnk.Description = 'Biometric Attendance Sync'
    $lnk.Save()
}

Start-Sleep -Seconds 3
Say 'Done! Double-click "Biometric Attendance Sync" on your desktop, or open http://127.0.0.1:8766'
if ($NoService) { Write-Host "    Start manually with: $venvPy `"$runPy`"" }
