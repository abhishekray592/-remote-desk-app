# mouse-control.ps1
# Reads JSON commands from stdin, injects OS-level mouse + keyboard events.
# Uses SendInput with MOUSEEVENTF_ABSOLUTE — no screen-resolution detection needed.

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -AssemblyName System.Windows.Forms

Add-Type @"
using System;
using System.Runtime.InteropServices;

public class WinInput {
    public const uint INPUT_MOUSE        = 0;
    public const uint MOUSEEVENTF_MOVE   = 0x0001;
    public const uint MOUSEEVENTF_LDOWN  = 0x0002;
    public const uint MOUSEEVENTF_LUP    = 0x0004;
    public const uint MOUSEEVENTF_RDOWN  = 0x0008;
    public const uint MOUSEEVENTF_RUP    = 0x0010;
    public const uint MOUSEEVENTF_MDOWN  = 0x0020;
    public const uint MOUSEEVENTF_MUP    = 0x0040;
    public const uint MOUSEEVENTF_WHEEL  = 0x0800;
    public const uint MOUSEEVENTF_ABS    = 0x8000;

    [StructLayout(LayoutKind.Sequential)]
    public struct MOUSEINPUT {
        public int    dx, dy;
        public int    mouseData;   // int so negative wheel values work directly
        public uint   dwFlags;
        public uint   time;
        public IntPtr dwExtraInfo;
    }

    // Sequential layout: CLR pads 4 bytes after 'type' on 64-bit to align
    // IntPtr inside MOUSEINPUT — matches Win32 INPUT layout on both 32/64-bit.
    [StructLayout(LayoutKind.Sequential)]
    public struct INPUT {
        public uint      type;
        public MOUSEINPUT mi;
    }

    static readonly int InputSize = Marshal.SizeOf(typeof(INPUT));

    [DllImport("user32.dll", SetLastError = true)]
    static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

    public static void MouseAbs(int ax, int ay, uint extraFlags, int data) {
        var inp = new INPUT[1];
        inp[0].type        = INPUT_MOUSE;
        inp[0].mi.dx       = ax;
        inp[0].mi.dy       = ay;
        inp[0].mi.dwFlags  = MOUSEEVENTF_MOVE | MOUSEEVENTF_ABS | extraFlags;
        inp[0].mi.mouseData = data;
        SendInput(1, inp, InputSize);
    }

    public static void MouseEvent(uint flags, int data) {
        var inp = new INPUT[1];
        inp[0].type         = INPUT_MOUSE;
        inp[0].mi.dwFlags   = flags;
        inp[0].mi.mouseData = data;
        SendInput(1, inp, InputSize);
    }
}
"@

$keyMap = @{
    'Enter'       = '{ENTER}'
    'Tab'         = '{TAB}'
    'Escape'      = '{ESC}'
    'Backspace'   = '{BACKSPACE}'
    'Delete'      = '{DELETE}'
    'Insert'      = '{INSERT}'
    'Home'        = '{HOME}'
    'End'         = '{END}'
    'PageUp'      = '{PGUP}'
    'PageDown'    = '{PGDN}'
    'ArrowUp'     = '{UP}'
    'ArrowDown'   = '{DOWN}'
    'ArrowLeft'   = '{LEFT}'
    'ArrowRight'  = '{RIGHT}'
    'F1'='{F1}';  'F2'='{F2}';  'F3'='{F3}';  'F4'='{F4}'
    'F5'='{F5}';  'F6'='{F6}';  'F7'='{F7}';  'F8'='{F8}'
    'F9'='{F9}';  'F10'='{F10}'; 'F11'='{F11}'; 'F12'='{F12}'
    'CapsLock'    = '{CAPSLOCK}'
    'PrintScreen' = '{PRTSC}'
    'NumLock'     = '{NUMLOCK}'
    'ScrollLock'  = '{SCROLLLOCK}'
    ' '           = ' '
}

[Console]::Error.WriteLine("[PS] Ready - SendInput injector active")

$stdin = [System.IO.StreamReader]::new([Console]::OpenStandardInput())

while ($true) {
    $line = $stdin.ReadLine()
    if ($null -eq $line) { break }
    $line = $line.Trim()
    if (-not $line) { continue }

    try {
        $cmd = $line | ConvertFrom-Json

        # nx/ny: normalized [0,1].  SendInput ABSOLUTE coords: [0,65535].
        $ax = [int]([double]$cmd.nx * 65535)
        $ay = [int]([double]$cmd.ny * 65535)

        switch ($cmd.type) {

            'mousemove' {
                [WinInput]::MouseAbs($ax, $ay, 0, 0)
            }

            'mousedown' {
                [WinInput]::MouseAbs($ax, $ay, 0, 0)
                switch ([int]$cmd.button) {
                    0 { [WinInput]::MouseEvent([WinInput]::MOUSEEVENTF_LDOWN, 0) }
                    1 { [WinInput]::MouseEvent([WinInput]::MOUSEEVENTF_MDOWN, 0) }
                    2 { [WinInput]::MouseEvent([WinInput]::MOUSEEVENTF_RDOWN, 0) }
                }
            }

            'mouseup' {
                switch ([int]$cmd.button) {
                    0 { [WinInput]::MouseEvent([WinInput]::MOUSEEVENTF_LUP, 0) }
                    1 { [WinInput]::MouseEvent([WinInput]::MOUSEEVENTF_MUP, 0) }
                    2 { [WinInput]::MouseEvent([WinInput]::MOUSEEVENTF_RUP, 0) }
                }
            }

            'wheel' {
                # Browser deltaY >0 = scroll down = negative WHEEL_DELTA (-120)
                $delta = if ([double]$cmd.deltaY -gt 0) { -120 } else { 120 }
                [WinInput]::MouseEvent([WinInput]::MOUSEEVENTF_WHEEL, $delta)
            }

            'keydown' {
                $key = [string]$cmd.key
                if ($keyMap.ContainsKey($key)) {
                    $sk = $keyMap[$key]
                } elseif ($key.Length -eq 1) {
                    $sk = $key -replace '([+^%~{}()\[\]])', '{$1}'
                } else {
                    continue
                }
                if ($cmd.ctrl)  { $sk = '^' + $sk }
                if ($cmd.alt)   { $sk = '%' + $sk }
                if ($cmd.shift -and $key.Length -gt 1) { $sk = '+' + $sk }
                [System.Windows.Forms.SendKeys]::SendWait($sk)
            }

            'get-clipboard' {
                try {
                    $txt = ''
                    if ([System.Windows.Forms.Clipboard]::ContainsText()) {
                        $txt = [System.Windows.Forms.Clipboard]::GetText()
                    }
                    if ($null -eq $txt) { $txt = '' }
                    $obj = @{ type = 'clipboard'; text = $txt } | ConvertTo-Json -Compress
                    [Console]::Out.WriteLine($obj)
                } catch {
                    [Console]::Error.WriteLine("[PS] get-clipboard err: $($_.Exception.Message)")
                }
            }

            'set-clipboard' {
                try {
                    $t = [string]$cmd.text
                    if ([string]::IsNullOrEmpty($t)) {
                        [System.Windows.Forms.Clipboard]::Clear()
                    } else {
                        [System.Windows.Forms.Clipboard]::SetText($t)
                    }
                    [Console]::Error.WriteLine("[PS] clipboard set ($($t.Length) chars)")
                } catch {
                    [Console]::Error.WriteLine("[PS] set-clipboard err: $($_.Exception.Message)")
                }
            }
        }
    } catch {
        # Silently continue on malformed input
    }
}
