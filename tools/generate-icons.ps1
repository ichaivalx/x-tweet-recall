param(
    [string]$OutputDirectory = (Join-Path $PSScriptRoot "..\icons")
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null

foreach ($size in 16, 32, 48, 128) {
    $scale = $size / 128.0
    $bitmap = [System.Drawing.Bitmap]::new($size, $size)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $graphics.Clear([System.Drawing.Color]::FromArgb(12, 13, 15))

    $bookmark = [System.Drawing.Drawing2D.GraphicsPath]::new()
    $bookmark.AddPolygon([System.Drawing.PointF[]]@(
        [System.Drawing.PointF]::new(36 * $scale, 18 * $scale),
        [System.Drawing.PointF]::new(92 * $scale, 18 * $scale),
        [System.Drawing.PointF]::new(92 * $scale, 110 * $scale),
        [System.Drawing.PointF]::new(64 * $scale, 90 * $scale),
        [System.Drawing.PointF]::new(36 * $scale, 110 * $scale)
    ))

    $bookmarkBrush = [System.Drawing.SolidBrush]::new(
        [System.Drawing.Color]::FromArgb(213, 215, 218)
    )
    $graphics.FillPath($bookmarkBrush, $bookmark)

    $linePen = [System.Drawing.Pen]::new(
        [System.Drawing.Color]::FromArgb(12, 13, 15),
        [Math]::Max(1.0, 7 * $scale)
    )
    $linePen.StartCap = [System.Drawing.Drawing2D.LineCap]::Square
    $linePen.EndCap = [System.Drawing.Drawing2D.LineCap]::Square
    $graphics.DrawLine($linePen, 49 * $scale, 45 * $scale, 79 * $scale, 45 * $scale)
    $graphics.DrawLine($linePen, 49 * $scale, 65 * $scale, 71 * $scale, 65 * $scale)

    $path = Join-Path $OutputDirectory "icon-$size.png"
    $bitmap.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)

    $linePen.Dispose()
    $bookmarkBrush.Dispose()
    $bookmark.Dispose()
    $graphics.Dispose()
    $bitmap.Dispose()
}

Write-Output "Generated Chrome extension icons in $OutputDirectory"
