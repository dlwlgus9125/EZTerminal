$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class ChatReviewCapture {
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out Rect rect);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdcBlt, uint flags);
}
'@
$target = Get-Process -Name EZTerminal | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $target) { throw 'No installed EZTerminal window is available.' }
$rect = New-Object ChatReviewCapture+Rect
[ChatReviewCapture]::GetWindowRect($target.MainWindowHandle, [ref]$rect) | Out-Null
$captureDir = Join-Path $PSScriptRoot 'evidence'
New-Item -ItemType Directory -Force -Path $captureDir | Out-Null
$bitmap = New-Object System.Drawing.Bitmap(($rect.Right - $rect.Left), ($rect.Bottom - $rect.Top))
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$dc = $graphics.GetHdc()
try { $captured = [ChatReviewCapture]::PrintWindow($target.MainWindowHandle, $dc, 2) }
finally { $graphics.ReleaseHdc($dc) }
$destination = Join-Path $captureDir 'installed-ezterminal.png'
$bitmap.Save($destination, [System.Drawing.Imaging.ImageFormat]::Png)
$graphics.Dispose()
$bitmap.Dispose()
@{ path = $destination; captured = $captured; process = $target.Id; width = $rect.Right - $rect.Left; height = $rect.Bottom - $rect.Top } | ConvertTo-Json -Compress
