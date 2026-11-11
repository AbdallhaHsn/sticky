# Smart Sticky Notes - Windows desktop agent
# Logs in as the employee, registers this device, and shows each assigned note as a sticky note on the desktop.
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type -Namespace Win -Name Native -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool ReleaseCapture();
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h, int m, int w, int l);
'@
[System.Windows.Forms.Application]::EnableVisualStyles()

$dir = if ($env:STICKY_DIR) { $env:STICKY_DIR } else { Join-Path $env:APPDATA 'StickyAgent' }
$cfgFile = Join-Path $dir 'config.json'
$logFile = Join-Path $dir 'agent.log'
function Log($m) { try { Add-Content $logFile ("{0} {1}" -f (Get-Date -Format s), $m) } catch {} }

[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
if (-not (Test-Path $cfgFile)) { Write-Host 'Run install.ps1 first.'; exit 1 }
$cfg = Get-Content $cfgFile -Raw -Encoding UTF8 | ConvertFrom-Json
$pw = if ($cfg.password) { try { [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR(($cfg.password | ConvertTo-SecureString))) } catch { '' } } else { '' }
$server = $cfg.server.TrimEnd('/')

$script:token = $cfg.token; $script:me = $null
$forms = @{}      # note id -> sticky note window
$dots = @{}       # note id -> small circle shown when the note is minimized
$aForms = @{}     # alert id -> distinct alert window
$aPills = @{}     # alert id -> minimized alert pill
$aFired = @{}     # alert occurrence key -> timestamp
$tip = New-Object Windows.Forms.ToolTip
$script:seen = 0

function Api($method, $path, $body) {
  $p = @{ Uri = "$server/api/$path"; Method = $method; Headers = @{ Authorization = "Bearer $($script:token)"; 'X-Client' = 'desktop' }; ContentType = 'application/json; charset=utf-8'; UseBasicParsing = $true }
  if ($body) { $p.Body = [Text.Encoding]::UTF8.GetBytes(($body | ConvertTo-Json -Depth 5)) }
  Invoke-RestMethod @p
}
function Login {
  $os = try { (Get-CimInstance Win32_OperatingSystem).Caption } catch { 'Windows' }
  $screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
  $dev = @{ key = "desktop-$($env:COMPUTERNAME)-$($env:USERNAME)"; kind = 'desktop'; name = $env:COMPUTERNAME; os = $os; user = $env:USERNAME; screen = "$($screen.Width)x$($screen.Height)" }
  if ($cfg.token) {
    try {
      $script:token = $cfg.token
      $r = Api 'POST' 'auto-login' @{ device = $dev }
      $script:token = $r.token; $script:me = $r.user
      Log "authenticated via token as $($r.user.name)"
      return
    } catch {}
  }
  try {
    $r = Api 'POST' 'login' @{ username = $cfg.username; password = $pw; device = $dev }
    $script:token = $r.token; $script:me = $r.user
    Log "logged in as $($r.user.name)"
  } catch {
    # local fallback if password changed or web user is logged in on same machine
    $sync = Api 'GET' "desktop-sync?username=$([Uri]::EscapeDataString($cfg.username))" $null
    $script:token = $sync.token; $script:me = $sync.user
    Log "synced local session as $($sync.user.name)"
  }
}

# ---- fonts: Tajawal (Arabic) bundled in .\fonts, icons from Segoe MDL2 Assets ----
$pfc = New-Object Drawing.Text.PrivateFontCollection
foreach ($ff in 'Tajawal-Regular.ttf', 'Tajawal-Bold.ttf') { $fp = Join-Path $PSScriptRoot "fonts\$ff"; if (Test-Path $fp) { $pfc.AddFontFile($fp) } }
$FAM = if ($pfc.Families.Count) { $pfc.Families[0] } else { New-Object Drawing.FontFamily('Segoe UI') }
$fontCache = @{}
function Fnt($size, $bold = $false) { $k = "t$size$bold"; if (-not $fontCache[$k]) { $fontCache[$k] = New-Object Drawing.Font($FAM, [single]$size, $(if ($bold) { [Drawing.FontStyle]::Bold } else { [Drawing.FontStyle]::Regular }), [Drawing.GraphicsUnit]::Point) }; $fontCache[$k] }
$ICONF = 'Segoe MDL2 Assets'
function IconFont($size) { $k = "i$size"; if (-not $fontCache[$k]) { $fontCache[$k] = New-Object Drawing.Font($ICONF, [single]$size, [Drawing.FontStyle]::Regular, [Drawing.GraphicsUnit]::Point) }; $fontCache[$k] }
Add-Type -ReferencedAssemblies System.Windows.Forms,System.Drawing -TypeDefinition 'public class BufForm : System.Windows.Forms.Form { public BufForm() { this.DoubleBuffered = true; } }'
function Glyph($code) { [string][char]$code }
function Col($hex, $alpha = 255) { $c = [Drawing.ColorTranslator]::FromHtml($hex); [Drawing.Color]::FromArgb($alpha, $c.R, $c.G, $c.B) }

# ---- priority (same rules as the web app) ----
function Get-Pri($n) {
  if ($n.status -eq 'pending') { return 'pending' }
  $now = [DateTimeOffset]::UtcNow; $s = [DateTimeOffset]::Parse($n.start); $e = [DateTimeOffset]::Parse($n.end)
  $left = ($e - $now).TotalDays
  if ($left -lt 0) { return 'late' }
  if ($now -lt $s) { return 'future' }
  $frac = ($now - $s).TotalSeconds / [math]::Max(1, ($e - $s).TotalSeconds)
  if ($left -le 1 -or $frac -ge .9) { return 'critical' }
  if ($left -le 3 -or $frac -ge .7) { return 'high' }
  if ($left -le 7 -or $frac -ge .4) { return 'medium' }
  'low'
}
# background, text, label, accent, icon glyph
$COLORS = @{
  future   = @('#C6ECFF', '#0B3B59', 'لم تبدأ', '#1C7ED6', 0xE823)
  low      = @('#B2F2BB', '#0B4228', 'أولوية منخفضة', '#2B8A3E', 0xE73E)
  medium   = @('#FFF078', '#5C4400', 'أولوية متوسطة', '#E67700', 0xE121)
  high     = @('#FFD08A', '#5F2700', 'أولوية عالية', '#E8590C', 0xE7C1)
  critical = @('#FFBFCE', '#660D24', 'حرجة', '#E03131', 0xE7BA)
  late     = @('#FFA8A8', '#5C0000', 'متأخرة', '#C92A2A', 0xE7BA)
  pending  = @('#DEC4FF', '#2E1065', 'بانتظار تأكيد المدير', '#7048E8', 0xE73E)
}
function Remaining($n) {
  $t = [DateTimeOffset]::Parse($n.end) - [DateTimeOffset]::UtcNow; $a = $t.Duration()
  $txt = if ($a.Days) { "$($a.Days) يوم $($a.Hours) س" } elseif ($a.Hours) { "$($a.Hours) س $($a.Minutes) د" } else { "$($a.Minutes) د" }
  if ($t.TotalSeconds -lt 0) { "متأخرة $txt" } else { "متبقي $txt" }
}
function Short-Remaining($n) {   # compact text for the small circle
  $t = [DateTimeOffset]::Parse($n.end) - [DateTimeOffset]::UtcNow; $a = $t.Duration()
  $v = if ($a.Days) { "$($a.Days)ي" } elseif ($a.Hours) { "$($a.Hours)س" } else { "$($a.Minutes)د" }
  if ($t.TotalSeconds -lt 0) { "-$v" } else { $v }
}
function Dt($s) { ([DateTimeOffset]::Parse($s)).LocalDateTime.ToString('yyyy/MM/dd HH:mm') }
function Elapsed-Fraction($n) {
  $s = [DateTimeOffset]::Parse($n.start); $e = [DateTimeOffset]::Parse($n.end)
  [math]::Min(1, [math]::Max(0, ([DateTimeOffset]::UtcNow - $s).TotalSeconds / [math]::Max(1, ($e - $s).TotalSeconds)))
}
function RoundRect($x, $y, $w, $h, $r) {
  $p = New-Object Drawing.Drawing2D.GraphicsPath; $d = $r * 2
  $p.AddArc($x, $y, $d, $d, 180, 90); $p.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
  $p.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90); $p.AddArc($x, $y + $h - $d, $d, $d, 90, 90); $p.CloseFigure(); $p
}
$rtl = New-Object Drawing.StringFormat; $rtl.FormatFlags = [Drawing.StringFormatFlags]::DirectionRightToLeft; $rtl.Trimming = 'EllipsisCharacter'; $rtl.LineAlignment = 'Center'
$ctr = New-Object Drawing.StringFormat; $ctr.Alignment = 'Center'; $ctr.LineAlignment = 'Center'
$script:projNames = @{}

# ================= expanded sticky note =================
$NW = 290; $NH = 262
function New-NoteForm($n, $index) {
  $f = New-Object BufForm
  $f.FormBorderStyle = 'None'; $f.ShowInTaskbar = $false; $f.StartPosition = 'Manual'; $f.Size = New-Object Drawing.Size($NW, $NH)
  $f.Region = New-Object Drawing.Region((RoundRect 0 0 $NW $NH 18))
  $wa = [Windows.Forms.Screen]::PrimaryScreen.WorkingArea
  $rows = [math]::Max(1, [math]::Floor($wa.Height / ($NH + 10))); $col = [math]::Floor($index / $rows)
  $f.Location = New-Object Drawing.Point(($wa.Right - $NW - 12 - $col * ($NW + 10)), ($wa.Top + 10 + ($index % $rows) * ($NH + 10)))
  $f.Tag = @{ id = $n.id }

  $min = New-Object Windows.Forms.Button; $min.Name = 'min'; $min.Text = [string][char]0x2013; $min.Tag = $n.id
  $min.SetBounds(8, 8, 30, 28); $min.FlatStyle = 'Flat'; $min.FlatAppearance.BorderSize = 0; $min.Font = Fnt 13 $true; $min.Cursor = 'Hand'
  $min.FlatAppearance.MouseOverBackColor = [Drawing.Color]::FromArgb(70, 255, 255, 255)
  $min.Add_Click({ Minimize-Note $this.Tag })
  $btn = New-Object Windows.Forms.Button; $btn.Name = 'btn'; $btn.Text = ([string][char]0x2714) + '  تم الانتهاء'; $btn.Tag = $n.id
  $btn.SetBounds(14, 218, ($NW - 28), 34); $btn.FlatStyle = 'Flat'; $btn.FlatAppearance.BorderSize = 0; $btn.Font = Fnt 11 $true; $btn.Cursor = 'Hand'
  $btn.RightToLeft = 'Yes'
  $btn.Region = New-Object Drawing.Region((RoundRect 0 0 ($NW - 28) 34 10))
  $btn.Add_Click({
    try { Api 'POST' "notes/$($this.Tag)/done" @{} | Out-Null; $this.Enabled = $false; Poll } catch { [Windows.Forms.MessageBox]::Show($_.Exception.Message) }
  })
  $f.Controls.AddRange(@($min, $btn))

  $f.Add_Paint({
    param($s, $e)
    $g = $e.Graphics; $st = $s.Tag
    if (-not $st.title) { return }
    $g.SmoothingMode = 'AntiAlias'; $g.TextRenderingHint = 'AntiAliasGridFit'
    $w = $s.Width
    $acc = Col $st.accent; $fg = Col $st.fg
    # header band + priority badge
    $b = New-Object Drawing.SolidBrush($acc); $g.FillRectangle($b, 0, 0, $w, 44); $b.Dispose()
    $b = New-Object Drawing.SolidBrush((Col '#FFFFFF' 235)); $g.FillEllipse($b, $w - 40, 8, 28, 28); $b.Dispose()
    $ib = New-Object Drawing.SolidBrush($acc); $g.DrawString((Glyph $st.glyph), (IconFont 13), $ib, (New-Object Drawing.RectangleF(($w - 40), 8, 28, 28)), $ctr); $ib.Dispose()
    $wb = [Drawing.Brushes]::White
    $g.DrawString($st.label, (Fnt 11 $true), $wb, (New-Object Drawing.RectangleF(46, 6, ($w - 94), 32)), $rtl)
    # title
    $fb = New-Object Drawing.SolidBrush($fg)
    $g.DrawString($st.title, (Fnt 14 $true), $fb, (New-Object Drawing.RectangleF(14, 50, ($w - 28), 30)), $rtl)
    # meta rows (icon + text)
    $mb = New-Object Drawing.SolidBrush((Col $st.fg 200)); $ab = New-Object Drawing.SolidBrush($acc)
    $g.DrawString((Glyph 0xE8B7), (IconFont 11), $ab, (New-Object Drawing.RectangleF(($w - 34), 82, 20, 20)), $ctr)
    $g.DrawString($st.project, (Fnt 10), $mb, (New-Object Drawing.RectangleF(14, 82, ($w - 52), 20)), $rtl)
    $g.DrawString((Glyph 0xE787), (IconFont 11), $ab, (New-Object Drawing.RectangleF(($w - 34), 104, 20, 20)), $ctr)
    $g.DrawString("ينتهي: $($st.endText)", (Fnt 10), $mb, (New-Object Drawing.RectangleF(14, 104, ($w - 52), 20)), $rtl)
    # description
    $df = New-Object Drawing.StringFormat; $df.FormatFlags = [Drawing.StringFormatFlags]::DirectionRightToLeft; $df.Trimming = 'EllipsisWord'
    $g.DrawString($st.desc, (Fnt 10), $mb, (New-Object Drawing.RectangleF(14, 130, ($w - 28), 44)), $df)
    # progress bar of elapsed time
    $track = RoundRect 14 180 ($w - 28) 8 4; $tb = New-Object Drawing.SolidBrush((Col '#000000' 25)); $g.FillPath($tb, $track); $tb.Dispose()
    $pw = [math]::Max(8, [int](($w - 28) * $st.frac)); $bar = RoundRect ($w - 14 - $pw) 180 $pw 8 4; $g.FillPath($ab, $bar)
    # remaining time
    $g.DrawString((Glyph 0xE823), (IconFont 12), $ab, (New-Object Drawing.RectangleF(($w - 34), 192, 20, 22)), $ctr)
    $g.DrawString($st.remaining, (Fnt 11 $true), $fb, (New-Object Drawing.RectangleF(14, 192, ($w - 52), 22)), $rtl)
    $fb.Dispose(); $mb.Dispose(); $ab.Dispose()
  })
  # drag the note by clicking on it
  $f.Add_MouseDown({ [Win.Native]::ReleaseCapture() | Out-Null; [Win.Native]::SendMessage($this.Handle, 0xA1, 2, 0) | Out-Null })
  $f
}
function Update-NoteForm($f, $n) {
  $k = Get-Pri $n; $c = $COLORS[$k]
  $f.BackColor = Col $c[0]
  $f.Tag = @{ id = $n.id; title = $n.title; desc = $n.description; project = $(if ($script:projNames[$n.projectId]) { $script:projNames[$n.projectId] } else { '—' })
    endText = (Dt $n.end); remaining = (Remaining $n); frac = (Elapsed-Fraction $n); label = $c[2]; accent = $c[3]; fg = $c[1]; glyph = $c[4] }
  $m = $f.Controls['min']; $m.BackColor = Col $c[3]; $m.ForeColor = [Drawing.Color]::White
  $b = $f.Controls['btn']; $b.Visible = ($n.status -eq 'open'); $b.Enabled = $true; $b.BackColor = Col $c[3]; $b.ForeColor = [Drawing.Color]::White
  $tip.SetToolTip($f, "$($n.title)`n$($n.description)")
  $f.Invalidate()
}

# ================= minimized circle =================
$DS = 60
function New-Dot($n) {
  $d = New-Object BufForm
  $d.FormBorderStyle = 'None'; $d.ShowInTaskbar = $false; $d.StartPosition = 'Manual'; $d.Size = New-Object Drawing.Size($DS, $DS); $d.TopMost = $true; $d.Cursor = 'Hand'
  $gp = New-Object Drawing.Drawing2D.GraphicsPath; $gp.AddEllipse(0, 0, $DS - 1, $DS - 1); $d.Region = New-Object Drawing.Region($gp)
  $d.Tag = @{ id = $n.id }
  $d.Add_Click({ Restore-Note $this.Tag.id })
  $d.Add_MouseEnter({ $this.Tag.hover = $true; $this.Invalidate() })
  $d.Add_MouseLeave({ $this.Tag.hover = $false; $this.Invalidate() })
  $d.Add_Paint({
    param($s, $e)
    $g = $e.Graphics; $st = $s.Tag
    if (-not $st.accent) { return }
    $g.SmoothingMode = 'AntiAlias'; $g.TextRenderingHint = 'AntiAliasGridFit'
    $acc = Col $st.accent
    $bg = New-Object Drawing.SolidBrush($(if ($st.hover) { Col '#FFFFFF' } else { Col $st.bg })); $g.FillEllipse($bg, 0, 0, $DS - 1, $DS - 1); $bg.Dispose()
    # elapsed-time ring
    $tp = New-Object Drawing.Pen((Col '#000000' 30), 5); $g.DrawEllipse($tp, 4, 4, $DS - 9, $DS - 9); $tp.Dispose()
    $ap = New-Object Drawing.Pen($acc, 5); $ap.StartCap = 'Round'; $ap.EndCap = 'Round'
    $sweep = [math]::Max(6, 360 * $st.frac); $g.DrawArc($ap, 4, 4, $DS - 9, $DS - 9, -90, $sweep); $ap.Dispose()
    # icon + compact remaining time
    $ab = New-Object Drawing.SolidBrush($acc); $fb = New-Object Drawing.SolidBrush((Col $st.fg))
    $g.DrawString((Glyph $st.glyph), (IconFont 14), $ab, (New-Object Drawing.RectangleF(0, 12, $DS, 20)), $ctr)
    $g.DrawString($st.text, (Fnt 10 $true), $fb, (New-Object Drawing.RectangleF(0, 32, $DS, 18)), $ctr)
    $ab.Dispose(); $fb.Dispose()
  })
  $d
}
function Update-Dot($d, $n) {
  $k = Get-Pri $n; $c = $COLORS[$k]
  $d.Tag.bg = $c[0]; $d.Tag.fg = $c[1]; $d.Tag.accent = $c[3]; $d.Tag.glyph = $c[4]; $d.Tag.frac = (Elapsed-Fraction $n); $d.Tag.text = (Short-Remaining $n)
  $tip.SetToolTip($d, "$($n.title)`n$($c[2]) - $(Remaining $n)")
  $d.Invalidate()
}
function Layout-Dots {
  $wa = [Windows.Forms.Screen]::PrimaryScreen.WorkingArea; $i = 0
  foreach ($id in @($dots.Keys | Sort-Object)) {
    if ($dots[$id].Visible) { $dots[$id].Location = New-Object Drawing.Point(($wa.Right - 68 * ($i + 1)), ($wa.Bottom - 68)); $i++ }
  }
}
function Minimize-Note($id) { if ($forms.ContainsKey($id)) { $forms[$id].Hide(); $dots[$id].Show(); Layout-Dots } }
function Restore-Note($id) { if ($forms.ContainsKey($id)) { $dots[$id].Hide(); $forms[$id].Show(); $forms[$id].BringToFront(); Layout-Dots } }

# ================= sound synthesis (iPhone Tri-tone, Chime, Bell, Radar) =================
$soundPlayers = @{}
function Build-WavPlayer($notes) {
  $sr = 44100; $dur = 0.85; $samples = [int]($sr * $dur)
  $ms = New-Object IO.MemoryStream; $bw = New-Object IO.BinaryWriter($ms)
  $bw.Write([Text.Encoding]::ASCII.GetBytes('RIFF')); $bw.Write([int](36 + $samples * 2))
  $bw.Write([Text.Encoding]::ASCII.GetBytes('WAVEfmt ')); $bw.Write([int]16); $bw.Write([int16]1); $bw.Write([int16]1)
  $bw.Write([int]$sr); $bw.Write([int]($sr * 2)); $bw.Write([int16]2); $bw.Write([int16]16)
  $bw.Write([Text.Encoding]::ASCII.GetBytes('data')); $bw.Write([int]($samples * 2))
  for ($i = 0; $i -lt $samples; $i++) {
    $t = $i / [double]$sr; $v = 0.0
    foreach ($n in $notes) {
      $f = $n[0]; $st = $n[1]; $ln = $n[2]
      if ($t -ge $st -and $t -lt ($st + $ln)) {
        $dt = $t - $st
        $env = if ($dt -lt 0.012) { $dt / 0.012 } else { [math]::Exp(-5.5 * ($dt / $ln)) }
        $v += (0.75 * [math]::Sin(2 * [math]::PI * $f * $dt) + 0.25 * [math]::Sin(4 * [math]::PI * $f * $dt)) * $env
      }
    }
    $s = [int][math]::Max(-32000, [math]::Min(32000, $v * 18000))
    $bw.Write([int16]$s)
  }
  $bw.Flush(); $ms.Position = 0
  New-Object Media.SoundPlayer($ms)
}
function Play-AlertTone($kind) {
  try {
    if (-not $kind) { $kind = 'iphone' }
    if (-not $soundPlayers[$kind]) {
      $spec = switch ($kind) {
        'chime' { @(@(523.25, 0.0, 0.20), @(659.25, 0.14, 0.20), @(783.99, 0.28, 0.22), @(1046.5, 0.42, 0.40)) }
        'bell'  { @(@(880.0, 0.0, 0.18), @(880.0, 0.22, 0.18), @(1174.66, 0.44, 0.38)) }
        'radar' { @(@(1046.5, 0.0, 0.12), @(1318.5, 0.13, 0.12), @(1046.5, 0.28, 0.12), @(1318.5, 0.41, 0.12), @(1567.98, 0.56, 0.28)) }
        default { @(@(987.77, 0.0, 0.14), @(1318.51, 0.12, 0.16), @(1567.98, 0.25, 0.45)) } # iPhone Tri-tone
      }
      $soundPlayers[$kind] = Build-WavPlayer $spec
    }
    $soundPlayers[$kind].Stream.Position = 0
    $soundPlayers[$kind].Play()
  } catch { [Media.SystemSounds]::Asterisk.Play() }
}

# ================= distinct alert note & pill (dark teal/cyan bell theme) =================
function Get-AlertSchedule($a) {
  $s = [DateTimeOffset]::Parse($(if ($a.startAt) { $a.startAt } else { $a.eventAt }))
  $ev = [DateTimeOffset]::Parse($a.eventAt)
  $cnt = [math]::Max(1, [int]$a.repeatCount)
  $hrs = [math]::Max(0.05, [double]$a.intervalHours)
  $times = @()
  for ($i = 0; $i -lt $cnt; $i++) {
    $t = $s.AddHours($i * $hrs)
    if ($t -le $ev.AddMinutes(1)) { $times += $t }
  }
  if ($times.Count -eq 0 -or [math]::Abs(($times[-1] - $ev).TotalMinutes) -gt 1) { $times += $ev }
  $times
}

$AW = 305; $AH = 236
function New-AlertForm($a, $index) {
  $f = New-Object BufForm
  $f.FormBorderStyle = 'None'; $f.ShowInTaskbar = $false; $f.StartPosition = 'Manual'; $f.Size = New-Object Drawing.Size($AW, $AH)
  $f.Region = New-Object Drawing.Region((RoundRect 0 0 $AW $AH 22))
  $wa = [Windows.Forms.Screen]::PrimaryScreen.WorkingArea
  $f.Location = New-Object Drawing.Point(($wa.Left + 16), ($wa.Top + 16 + ($index % 3) * ($AH + 12)))
  $f.BackColor = Col '#0F172A'
  $f.Tag = @{ id = $a.id }

  $min = New-Object Windows.Forms.Button; $min.Name = 'min'; $min.Text = [string][char]0x2013; $min.Tag = $a.id
  $min.SetBounds(10, 10, 30, 28); $min.FlatStyle = 'Flat'; $min.FlatAppearance.BorderSize = 0; $min.Font = Fnt 13 $true; $min.Cursor = 'Hand'
  $min.BackColor = Col '#0D9488'; $min.ForeColor = [Drawing.Color]::White
  $min.Add_Click({ Minimize-Alert $this.Tag })

  $snd = New-Object Windows.Forms.Button; $snd.Name = 'snd'; $snd.Text = (Glyph 0xE767); $snd.Tag = $a.id
  $snd.SetBounds(44, 10, 30, 28); $snd.FlatStyle = 'Flat'; $snd.FlatAppearance.BorderSize = 0; $snd.Font = IconFont 11; $snd.Cursor = 'Hand'
  $snd.BackColor = Col '#0D9488'; $snd.ForeColor = [Drawing.Color]::White
  $snd.Add_Click({ $al = $aForms[$this.Tag].Tag.raw; Play-AlertTone $al.sound })

  $btn = New-Object Windows.Forms.Button; $btn.Name = 'btn'; $btn.Text = ([string][char]0x2714) + '  تم الاطلاع / إيقاف التنبيه'; $btn.Tag = $a.id
  $btn.SetBounds(14, 190, ($AW - 28), 34); $btn.FlatStyle = 'Flat'; $btn.FlatAppearance.BorderSize = 0; $btn.Font = Fnt 10.5 $true; $btn.Cursor = 'Hand'
  $btn.RightToLeft = 'Yes'; $btn.BackColor = Col '#14B8A6'; $btn.ForeColor = Col '#042F2E'
  $btn.Region = New-Object Drawing.Region((RoundRect 0 0 ($AW - 28) 34 12))
  $btn.Add_Click({
    try { Api 'POST' "alerts/$($this.Tag)/dismiss" @{} | Out-Null; $this.Enabled = $false; Poll } catch {}
  })
  $f.Controls.AddRange(@($min, $snd, $btn))

  $f.Add_Paint({
    param($s, $e)
    $g = $e.Graphics; $st = $s.Tag
    if (-not $st.title) { return }
    $g.SmoothingMode = 'AntiAlias'; $g.TextRenderingHint = 'AntiAliasGridFit'
    $w = $s.Width
    $teal = Col '#0D9488'; $cyan = Col '#2DD4BF'; $light = Col '#CCFBF1'
    # header band
    $hb = New-Object Drawing.SolidBrush($teal); $g.FillRectangle($hb, 0, 0, $w, 46); $hb.Dispose()
    $cb = New-Object Drawing.SolidBrush((Col '#FFFFFF' 240)); $g.FillEllipse($cb, $w - 42, 9, 30, 30); $cb.Dispose()
    $tb = New-Object Drawing.SolidBrush($teal); $g.DrawString((Glyph 0xEA8F), (IconFont 13), $tb, (New-Object Drawing.RectangleF(($w - 42), 9, 30, 30)), $ctr); $tb.Dispose()
    $g.DrawString("نوتة تنبيه • $($st.statusLabel)", (Fnt 10.5 $true), [Drawing.Brushes]::White, (New-Object Drawing.RectangleF(80, 8, ($w - 128), 30)), $rtl)
    # border glow
    $bp = New-Object Drawing.Pen($cyan, 2); $g.DrawPath($bp, (RoundRect 1 1 ($w - 3) ($s.Height - 3) 21)); $bp.Dispose()
    # title & desc
    $g.DrawString($st.title, (Fnt 13.5 $true), [Drawing.Brushes]::White, (New-Object Drawing.RectangleF(14, 52, ($w - 28), 28)), $rtl)
    $lb = New-Object Drawing.SolidBrush($light); $cb2 = New-Object Drawing.SolidBrush($cyan)
    $df = New-Object Drawing.StringFormat; $df.FormatFlags = [Drawing.StringFormatFlags]::DirectionRightToLeft; $df.Trimming = 'EllipsisWord'
    $g.DrawString($st.desc, (Fnt 9.5), $lb, (New-Object Drawing.RectangleF(14, 82, ($w - 28), 36)), $df)
    # schedule info
    $g.DrawString((Glyph 0xE787), (IconFont 11), $cb2, (New-Object Drawing.RectangleF(($w - 34), 124, 20, 20)), $ctr)
    $g.DrawString("الموعد: $($st.evText)", (Fnt 9.5 $true), $cb2, (New-Object Drawing.RectangleF(14, 124, ($w - 52), 20)), $rtl)
    $g.DrawString((Glyph 0xE823), (IconFont 11), $cb2, (New-Object Drawing.RectangleF(($w - 34), 146, 20, 20)), $ctr)
    $g.DrawString($st.repText, (Fnt 9.5), $lb, (New-Object Drawing.RectangleF(14, 146, ($w - 52), 20)), $rtl)
    $g.DrawString((Glyph 0xEA8F), (IconFont 11), $cb2, (New-Object Drawing.RectangleF(($w - 34), 166, 20, 20)), $ctr)
    $g.DrawString($st.nextText, (Fnt 10 $true), [Drawing.Brushes]::White, (New-Object Drawing.RectangleF(14, 166, ($w - 52), 20)), $rtl)
    $lb.Dispose(); $cb2.Dispose()
  })
  $f.Add_MouseDown({ [Win.Native]::ReleaseCapture() | Out-Null; [Win.Native]::SendMessage($this.Handle, 0xA1, 2, 0) | Out-Null })
  $f
}

$PW = 86; $PH = 44
function New-AlertPill($a) {
  $p = New-Object BufForm
  $p.FormBorderStyle = 'None'; $p.ShowInTaskbar = $false; $p.StartPosition = 'Manual'; $p.Size = New-Object Drawing.Size($PW, $PH); $p.TopMost = $true; $p.Cursor = 'Hand'
  $p.Region = New-Object Drawing.Region((RoundRect 0 0 $PW $PH 22))
  $p.Tag = @{ id = $a.id }
  $p.Add_Click({ Restore-Alert $this.Tag.id })
  $p.Add_Paint({
    param($s, $e)
    $g = $e.Graphics; $st = $s.Tag
    $g.SmoothingMode = 'AntiAlias'; $g.TextRenderingHint = 'AntiAliasGridFit'
    $bg = New-Object Drawing.SolidBrush((Col '#0F172A')); $g.FillPath($bg, (RoundRect 0 0 $PW $PH 22)); $bg.Dispose()
    $pen = New-Object Drawing.Pen((Col '#2DD4BF'), 3); $g.DrawPath($pen, (RoundRect 2 2 ($PW - 5) ($PH - 5) 20)); $pen.Dispose()
    $cb = New-Object Drawing.SolidBrush((Col '#2DD4BF'))
    $g.DrawString((Glyph 0xEA8F), (IconFont 13), $cb, (New-Object Drawing.RectangleF(8, 10, 26, 24)), $ctr)
    $g.DrawString($st.short, (Fnt 9.5 $true), [Drawing.Brushes]::White, (New-Object Drawing.RectangleF(32, 10, ($PW - 38), 24)), $ctr)
    $cb.Dispose()
  })
  $p
}
function Update-AlertViews($f, $p, $a) {
  $times = Get-AlertSchedule $a; $now = [DateTimeOffset]::UtcNow
  $fired = @($times | Where-Object { $_ -le $now }).Count
  $next = $times | Where-Object { $_ -gt $now } | Select-Object -First 1
  $ev = [DateTimeOffset]::Parse($a.eventAt)
  $rem = if ($next) { $next - $now } else { $ev - $now }
  $d = $rem.Duration()
  $short = if ($rem.TotalSeconds -le 0) { 'الآن!' } elseif ($d.Days) { "$($d.Days)ي" } elseif ($d.Hours) { "$($d.Hours)س" } else { "$($d.Minutes)د" }
  $nextTxt = if ($next) { "التذكير القادم: $($next.LocalDateTime.ToString('HH:mm')) ($fired/$($times.Count))" } else { "حان وقت التنبيه ($($times.Count)/$($times.Count))" }
  $f.Tag = @{ id = $a.id; raw = $a; title = $a.title; desc = $(if ($a.description) { $a.description } else { 'تنبيه مجدول' });
    evText = (Dt $a.eventAt); repText = "تكرار $($a.repeatCount) مرات • كل $($a.intervalHours) ساعة";
    nextText = $nextTxt; statusLabel = "$fired/$($times.Count)" }
  $p.Tag.short = $short
  $tip.SetToolTip($p, "🔔 $($a.title)`nالموعد: $(Dt $a.eventAt)`n$nextTxt")
  $f.Invalidate(); $p.Invalidate()
}
function Layout-AlertPills {
  $wa = [Windows.Forms.Screen]::PrimaryScreen.WorkingArea; $i = 0
  foreach ($id in @($aPills.Keys | Sort-Object)) {
    if ($aPills[$id].Visible) { $aPills[$id].Location = New-Object Drawing.Point(($wa.Left + 14 + ($PW + 8) * $i), ($wa.Bottom - $PH - 10)); $i++ }
  }
}
function Minimize-Alert($id) { if ($aForms.ContainsKey($id)) { $aForms[$id].Hide(); $aPills[$id].Show(); Layout-AlertPills } }
function Restore-Alert($id) { if ($aForms.ContainsKey($id)) { $aPills[$id].Hide(); $aForms[$id].Show(); $aForms[$id].TopMost = $true; $aForms[$id].BringToFront(); Layout-AlertPills } }

$tray = New-Object Windows.Forms.NotifyIcon
$bmp = New-Object Drawing.Bitmap(32, 32); $gg = [Drawing.Graphics]::FromImage($bmp); $gg.SmoothingMode = 'AntiAlias'
$gg.FillPath((New-Object Drawing.SolidBrush((Col '#FFD43B'))), (RoundRect 2 2 28 28 6)); $gg.FillPolygon((New-Object Drawing.SolidBrush((Col '#F59F00'))), @((New-Object Drawing.Point(30, 20)), (New-Object Drawing.Point(20, 30)), (New-Object Drawing.Point(30, 30))))
$pen = New-Object Drawing.Pen((Col '#7A4B00'), 2); $gg.DrawLine($pen, 8, 10, 24, 10); $gg.DrawLine($pen, 8, 16, 22, 16); $gg.Dispose()
$tray.Icon = [Drawing.Icon]::FromHandle($bmp.GetHicon()); $tray.Text = 'النوتات الذكية'; $tray.Visible = $true
$menu = New-Object Windows.Forms.ContextMenuStrip
$menu.Items.Add('إظهار كل المهام والتنبيهات').Add_Click({
  foreach ($id in @($forms.Keys)) { Restore-Note $id }
  foreach ($id in @($aForms.Keys)) { Restore-Alert $id }
})
$menu.Items.Add('تصغير الكل').Add_Click({
  foreach ($id in @($forms.Keys)) { Minimize-Note $id }
  foreach ($id in @($aForms.Keys)) { Minimize-Alert $id }
})
$menu.Items.Add('تحديث الآن').Add_Click({ Poll })
$menu.Items.Add('خروج').Add_Click({ $tray.Visible = $false; [Windows.Forms.Application]::Exit() })
$tray.ContextMenuStrip = $menu
$tray.Add_DoubleClick({
  foreach ($id in @($forms.Keys)) { Restore-Note $id }
  foreach ($id in @($aForms.Keys)) { Restore-Alert $id }
})

function Poll {
  try {
    if (-not $script:token -or -not $script:me) { Login }
    try { $data = Api 'GET' 'data' $null } catch { Login; $data = Api 'GET' 'data' $null }
    $sync = try { Api 'GET' 'desktop-sync' $null } catch { $null }
  } catch { Log "poll failed: $($_.Exception.Message)"; return }
  # show open and pending notes on desktop so the employee always sees their tasks until confirmed by manager
  $script:projNames = @{}; foreach ($pr in $data.projects) { $script:projNames[$pr.id] = $pr.name }
  $mine = @($data.notes | Where-Object { $_.assigneeId -eq $script:me.id })
  $ids = @($mine | ForEach-Object { $_.id })
  foreach ($id in @($forms.Keys)) {           # note confirmed/removed -> take it off the desktop
    if ($ids -notcontains $id) { $forms[$id].Close(); $forms[$id].Dispose(); $forms.Remove($id); $dots[$id].Close(); $dots[$id].Dispose(); $dots.Remove($id); Layout-Dots }
  }
  foreach ($n in $mine) {
    if (-not $forms.ContainsKey($n.id)) {
      $f = New-NoteForm $n $forms.Count
      $forms[$n.id] = $f; Update-NoteForm $f $n
      $dots[$n.id] = New-Dot $n; Update-Dot $dots[$n.id] $n
      $f.Show(); $f.TopMost = $true; $f.BringToFront(); $f.TopMost = $false
      $tray.ShowBalloonTip(5000, 'مهمة على سطح المكتب', $n.title, 'Info')
      Log "new note $($n.title)"
    } else {
      Update-NoteForm $forms[$n.id] $n; Update-Dot $dots[$n.id] $n
    }
  }

  # ---- sync active alerts targeted to this user ----
  $alertMap = @{}
  foreach ($a in @($data.alerts)) { if ($a -and $a.status -eq 'active' -and $a.targetId -eq $script:me.id) { $alertMap[$a.id] = $a } }
  if ($sync -and $sync.extraAlerts) { foreach ($a in @($sync.extraAlerts)) { if ($a -and $a.status -eq 'active' -and $a.targetId -eq $script:me.id) { $alertMap[$a.id] = $a } } }
  $myAlerts = @($alertMap.Values)
  $aIds = @($myAlerts | ForEach-Object { $_.id })
  foreach ($id in @($aForms.Keys)) {
    if ($aIds -notcontains $id) { $aForms[$id].Close(); $aForms[$id].Dispose(); $aForms.Remove($id); $aPills[$id].Close(); $aPills[$id].Dispose(); $aPills.Remove($id); Layout-AlertPills }
  }
  $now = [DateTimeOffset]::UtcNow
  foreach ($a in $myAlerts) {
    $isNew = -not $aForms.ContainsKey($a.id)
    if ($isNew) {
      $af = New-AlertForm $a $aForms.Count; $ap = New-AlertPill $a
      $aForms[$a.id] = $af; $aPills[$a.id] = $ap
      Update-AlertViews $af $ap $a
      $af.Show(); $af.TopMost = $true; $af.BringToFront()
      Play-AlertTone $a.sound
      Log "new alert $($a.title)"
    } else {
      Update-AlertViews $aForms[$a.id] $aPills[$a.id] $a
    }
    # check scheduled occurrences to ring and pop up
    $times = Get-AlertSchedule $a
    for ($idx = 0; $idx -lt $times.Count; $idx++) {
      $occ = $times[$idx]
      $key = "$($a.id):$idx"
      $minsAgo = ($now - $occ).TotalMinutes
      if ($minsAgo -ge 0 -and $minsAgo -lt 15 -and -not $aFired.ContainsKey($key)) {
        $aFired[$key] = $now
        if (-not $isNew) { Play-AlertTone $a.sound }
        Restore-Alert $a.id
        $tray.ShowBalloonTip(5000, "🔔 تنبيه ($($idx + 1)/$($times.Count))", $a.title, 'Info')
        Log "alert rang: $($a.title) ($($idx + 1)/$($times.Count))"
      }
    }
  }
}

$timer = New-Object Windows.Forms.Timer; $timer.Interval = 3000; $timer.Add_Tick({ Poll })
$timer.Start(); Poll
if ($env:STICKY_SHOT) {   # developer aid: render every note and circle to PNG files, then exit
  $i = 0
  foreach ($id in @($forms.Keys)) {
    foreach ($w in @($forms[$id], $dots[$id])) {
      $w.Show(); [Windows.Forms.Application]::DoEvents()
      $bm = New-Object Drawing.Bitmap($w.Width, $w.Height); $w.DrawToBitmap($bm, (New-Object Drawing.Rectangle(0, 0, $w.Width, $w.Height)))
      $bm.Save((Join-Path $env:STICKY_SHOT ("shot{0}.png" -f $i++))); $bm.Dispose()
    }
  }
  $tray.Visible = $false; exit 0
}
[Windows.Forms.Application]::Run()

