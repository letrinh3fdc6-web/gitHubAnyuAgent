param()
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$branding = Join-Path (Split-Path -Parent $PSScriptRoot) 'branding'
$source = [System.Drawing.Bitmap]::FromFile((Join-Path $branding 'anyu-mark.png'))
$sizes = @(16, 24, 32, 48, 64, 128, 256)
$images = @()
try {
    foreach ($size in $sizes) {
        $bitmap = New-Object System.Drawing.Bitmap($size, $size, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb))
        $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
        try {
            $graphics.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceCopy
            $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
            $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
            $graphics.DrawImage($source, 0, 0, $size, $size)
            $stream = New-Object System.IO.MemoryStream
            $writer = New-Object System.IO.BinaryWriter($stream)
            try {
                $maskStride = [int]([Math]::Ceiling($size / 32.0) * 4)
                # Windows ICO stores a bottom-up BGRA bitmap followed by its transparency mask.
                $writer.Write([uint32]40)
                $writer.Write([int32]$size)
                $writer.Write([int32]($size * 2))
                $writer.Write([uint16]1)
                $writer.Write([uint16]32)
                $writer.Write([uint32]0)
                $writer.Write([uint32]($size * $size * 4 + $maskStride * $size))
                foreach ($unused in 1..4) { $writer.Write([uint32]0) }
                for ($y = $size - 1; $y -ge 0; $y--) {
                    for ($x = 0; $x -lt $size; $x++) {
                        $pixel = $bitmap.GetPixel($x, $y)
                        $writer.Write([byte]$pixel.B)
                        $writer.Write([byte]$pixel.G)
                        $writer.Write([byte]$pixel.R)
                        $writer.Write([byte]$pixel.A)
                    }
                }
                for ($y = $size - 1; $y -ge 0; $y--) {
                    $mask = New-Object byte[] $maskStride
                    for ($x = 0; $x -lt $size; $x++) {
                        if ($bitmap.GetPixel($x, $y).A -eq 0) {
                            $index = [int][Math]::Floor($x / 8)
                            $mask[$index] = $mask[$index] -bor (128 -shr ($x % 8))
                        }
                    }
                    $writer.Write($mask)
                }
                $writer.Flush()
                $images += ,$stream.ToArray()
            } finally { $writer.Dispose(); $stream.Dispose() }
        } finally { $graphics.Dispose(); $bitmap.Dispose() }
    }
    $result = New-Object System.IO.MemoryStream
    $ico = New-Object System.IO.BinaryWriter($result)
    try {
        $ico.Write([uint16]0)
        $ico.Write([uint16]1)
        $ico.Write([uint16]$sizes.Length)
        $offset = 6 + 16 * $sizes.Length
        for ($index = 0; $index -lt $sizes.Length; $index++) {
            $encodedSize = if ($sizes[$index] -eq 256) { 0 } else { $sizes[$index] }
            $ico.Write([byte]$encodedSize)
            $ico.Write([byte]$encodedSize)
            $ico.Write([uint16]0)
            $ico.Write([uint16]1)
            $ico.Write([uint16]32)
            $ico.Write([uint32]$images[$index].Length)
            $ico.Write([uint32]$offset)
            $offset += $images[$index].Length
        }
        foreach ($image in $images) { $ico.Write([byte[]]$image) }
        $ico.Flush()
        [System.IO.File]::WriteAllBytes((Join-Path $branding 'anyu.ico'), $result.ToArray())
    } finally { $ico.Dispose(); $result.Dispose() }
} finally { $source.Dispose() }
Write-Output 'Generated Anyu Windows icon: 16/24/32/48/64/128/256 px, native 32-bit DIB entries.'
