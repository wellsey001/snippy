# Snippy's "Updating" window. Snippy starts this just before it closes to install an update, so
# you see Snippy's own splash instead of the installer (which runs silently in the background).
# It plays update-splash.gif in a small rounded window and closes itself when the new version
# opens (or when the installer has finished, or after a few minutes at most).
param(
  [string]$Gif,
  [string]$AppExe,
  [string]$Installer = '',
  [string]$Ready = '',
  [int]$MaxSeconds = 240
)
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices;
public static class SnippyWin {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();
}
"@
[SnippyWin]::SetProcessDPIAware() | Out-Null
# Keep PowerShell's own console hidden. (This also uses up Windows' "first window shown" rule,
# which would otherwise hide our window too when we're started hidden.)
[SnippyWin]::ShowWindow([SnippyWin]::GetConsoleWindow(), 0) | Out-Null
[System.Windows.Forms.Application]::EnableVisualStyles()

$form = New-Object System.Windows.Forms.Form
$form.FormBorderStyle = 'None'
$form.StartPosition = 'CenterScreen'
$form.TopMost = $true
$form.ShowInTaskbar = $true
$form.Text = 'Updating Snippy'
$form.BackColor = [System.Drawing.Color]::FromArgb(17, 15, 23)
$form.Opacity = 0
$g = $form.CreateGraphics(); $scale = $g.DpiX / 96.0; $g.Dispose()
$w = [int](420 * $scale); $h = [int](300 * $scale)
$form.ClientSize = New-Object System.Drawing.Size($w, $h)
try { $form.Icon = [System.Drawing.Icon]::ExtractAssociatedIcon($AppExe) } catch { }

$pic = New-Object System.Windows.Forms.PictureBox
$pic.Dock = 'Fill'
$pic.SizeMode = 'Zoom'
$pic.Image = [System.Drawing.Image]::FromFile($Gif)
$form.Controls.Add($pic)

# Rounded corners, like Snippy's own splash.
$r = [int](26 * $scale)
$path = New-Object System.Drawing.Drawing2D.GraphicsPath
$path.AddArc(0, 0, $r, $r, 180, 90)
$path.AddArc($w - $r, 0, $r, $r, 270, 90)
$path.AddArc($w - $r, $h - $r, $r, $r, 0, 90)
$path.AddArc(0, $h - $r, $r, $r, 90, 90)
$path.CloseFigure()
$form.Region = New-Object System.Drawing.Region($path)

$start = Get-Date
$appName = [IO.Path]::GetFileNameWithoutExtension($AppExe)
$instName = if ($Installer) { [IO.Path]::GetFileNameWithoutExtension($Installer) } else { '' }
$st = @{ sawInstaller = $false; doneAt = $null; closing = $false }

# Fade in, and out at the end.
$fade = New-Object System.Windows.Forms.Timer
$fade.Interval = 15
$fade.Add_Tick({
  if ($st.closing) {
    $form.Opacity = [Math]::Max(0, $form.Opacity - 0.08)
    if ($form.Opacity -le 0) { $fade.Stop(); $form.Close() }
  } else {
    $form.Opacity = [Math]::Min(1, $form.Opacity + 0.08)
    if ($form.Opacity -ge 1) { $fade.Stop() }
  }
})

$watch = New-Object System.Windows.Forms.Timer
$watch.Interval = 400
$watch.Add_Tick({
  $el = ((Get-Date) - $start).TotalSeconds
  $inst = $null
  if ($instName) { $inst = Get-Process -Name $instName -ErrorAction SilentlyContinue }
  if ($inst) { $st.sawInstaller = $true }
  # The new version is open: a Snippy started after this window, with a window of its own.
  $app = Get-Process -Name $appName -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 -and $_.StartTime -gt $start }
  $done = $false
  if ($app) { $done = $true }
  elseif ($st.sawInstaller -and -not $inst) {
    if (-not $st.doneAt) { $st.doneAt = Get-Date }
    elseif (((Get-Date) - $st.doneAt).TotalSeconds -gt 20) { $done = $true }
  }
  elseif (-not $st.sawInstaller -and $el -gt 30) { $done = $true }
  if ($el -gt $MaxSeconds) { $done = $true }
  if ($done) { $watch.Stop(); $st.closing = $true; $fade.Start() }
})

$form.Add_Shown({
  $form.Activate()
  $fade.Start()
  $watch.Start()
  # Tell Snippy the window is up, so it can close and let the installer start.
  if ($Ready) { Set-Content -Path $Ready -Value 'shown' }
})
[System.Windows.Forms.Application]::Run($form)
