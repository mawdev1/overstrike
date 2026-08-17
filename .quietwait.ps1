$quiet = 0
for ($i = 0; $i -lt 900; $i++) {
  $cpu = (Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average
  $hs = @(Get-Process -Name chrome-headless-shell -ErrorAction SilentlyContinue).Count
  if ($cpu -lt 25 -and $hs -eq 0) { $quiet++ } else { $quiet = 0 }
  if ($quiet -ge 6) { Write-Output "QUIET cpu=$cpu headless=$hs after $i polls"; exit 0 }
  Start-Sleep -Seconds 10
}
Write-Output "TIMEOUT still busy"
exit 1
