# Removes the startup task / service and shortcuts. The data folder is kept.
$AppDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$TaskName = 'BiometricAttendanceSync'
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
$nssm = Join-Path $AppDir 'tools\nssm.exe'
if ((Get-Service $TaskName -ErrorAction SilentlyContinue) -and (Test-Path $nssm)) {
    & $nssm stop $TaskName | Out-Null
    & $nssm remove $TaskName confirm | Out-Null
}
Get-CimInstance Win32_Process -Filter "Name like 'python%'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like "*$AppDir*run.py*" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Remove-Item (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Biometric Attendance Sync.lnk') -ErrorAction SilentlyContinue
Remove-Item (Join-Path ([Environment]::GetFolderPath('Programs')) 'Biometric Attendance Sync.lnk') -ErrorAction SilentlyContinue
Write-Host "Removed. Your data in $AppDir\data was NOT deleted."
