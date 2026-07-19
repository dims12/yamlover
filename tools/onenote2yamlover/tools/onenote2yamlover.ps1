#requires -Version 5.1
<#
  Prototype OneNote -> yamlover converter (Phase 2 spike).
  Syncs one notebook (default "Dmitry's Notebook") to the yamlover "chapter" concrete,
  expanded-directory layout. Validated mapping per project memory.
    -Section <name>  : only sync that one section (for fast format validation)
    -All             : sync every non-recycle section (default if -Section omitted)

  Emits the positional-body chapter model (yamlover CHAPTER.md): optional keyed
  title/description, then ONE ordered body of chunks and subchapter pointers.
#>
param(
  [string]$Notebook = "Dmitry's Notebook",
  [string]$Section  = '',
  # A local directory, or an ssh target `[user@]host:/abs/path`. An ssh target is STAGED to
  # -StageDir first, then shipped in one tar+scp — 500 files over 500 ssh handshakes is minutes.
  [string]$OutRoot  = (Join-Path $PSScriptRoot '..\sync-output'),
  [string]$StageDir = (Join-Path $PSScriptRoot '..\sync-output'),
  [string]$HierPath = (Join-Path $PSScriptRoot '..\.cache\hierarchy.xml'),
  [switch]$RefreshHierarchy,
  [switch]$Clean
)
$ErrorActionPreference = 'Stop'
$ONE = 'http://schemas.microsoft.com/office/onenote/2013/onenote'
$on = New-Object -ComObject OneNote.Application

# ---------------------------------------------------------------- utilities ---
function New-Ns([xml]$d) { $n = New-Object System.Xml.XmlNamespaceManager($d.NameTable); $n.AddNamespace('one', $ONE); Write-Output $n -NoEnumerate }
# Windows MAX_PATH is 260 chars and PS 5.1's .NET does not opt into long paths. A notebook nests
# notebook/section/page/subpage/.yamlover/body.yamlover, so the `\\?\` prefix is required even
# with capped names. It takes only a normalized absolute path — `..` is NOT resolved for you.
function Long-Path([string]$p) {
  $full = [System.IO.Path]::GetFullPath($p)
  if ($full.StartsWith('\\?\')) { return $full }
  if ($full.StartsWith('\\')) { return '\\?\UNC\' + $full.Substring(2) }
  return '\\?\' + $full
}
function New-Dir([string]$path) { [void][System.IO.Directory]::CreateDirectory((Long-Path $path)) }
# `[user@]host:/abs/path`. The path must be absolute so a Windows `D:\…` can never match
# (a drive letter is one char; a host is at least two).
function Parse-SshTarget([string]$s) {
  if ($s -match '^(?<host>[A-Za-z0-9_.@-]{2,}):(?<path>/.+)$') {
    return @{ host = $Matches['host']; path = $Matches['path'].TrimEnd('/') }
  }
  return $null
}
function Push-Remote([string]$stage, $target, [bool]$clean) {
  $ssh = (Get-Command ssh -ErrorAction SilentlyContinue).Source
  $tar = (Get-Command tar -ErrorAction SilentlyContinue).Source
  if (-not $ssh -or -not $tar) { throw "'ssh' and 'tar' must be on PATH to push to an ssh target" }
  # Take the scp that ships NEXT TO this ssh: Windows' OpenSSH scp.exe cannot spawn Git's ssh.exe
  # (CreateProcessW error 2), and PATH order happily mixes the two.
  $scp = Join-Path (Split-Path -Parent $ssh) 'scp.exe'
  if (-not (Test-Path -LiteralPath $scp)) { $scp = (Get-Command scp -ErrorAction SilentlyContinue).Source }
  if (-not $scp) { throw "no scp found beside '$ssh'" }
  $rp = $target.path
  if ($rp.Length -lt 10 -or $rp -match '^/(home|usr|etc|var|opt|tmp)?/?$') { throw "refusing to write to remote path '$rp'" }
  $tgz = Join-Path ([System.IO.Path]::GetTempPath()) ('o2y-' + [guid]::NewGuid().ToString('N').Substring(0, 8) + '.tgz')
  # A native exe writing to stderr is a TERMINATING error while $ErrorActionPreference is 'Stop' —
  # it killed ssh mid-extract over one benign GNU-tar warning. Judge these by exit code instead.
  $prevEap = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    Write-Host "packing $stage -> $(Split-Path -Leaf $tgz)"
    & $tar --format=pax -czf $tgz -C $stage .   # pax keeps UTF-8 filenames intact
    if ($LASTEXITCODE -ne 0) { throw "tar failed ($LASTEXITCODE)" }
    $rtmp = '/tmp/' + [System.IO.Path]::GetFileName($tgz)
    Write-Host ("scp -> {0}:{1} ({2:N0} bytes)" -f $target.host, $rp, (Get-Item $tgz).Length)
    & $scp -q $tgz ("{0}:{1}" -f $target.host, $rtmp)
    if ($LASTEXITCODE -ne 0) { throw "scp failed ($LASTEXITCODE)" }
    $rm = if ($clean) { "rm -rf '$rp'; " } else { '' }
    # bsdtar stamps LIBARCHIVE.* pax keywords GNU tar does not know; the warning is noise.
    $cmd = "set -e; ${rm}mkdir -p '$rp'; tar --warning=no-unknown-keyword -xzf '$rtmp' -C '$rp'; rm -f '$rtmp'; find '$rp' -type f | wc -l"
    $n = & $ssh $target.host $cmd 2>$null
    if ($LASTEXITCODE -ne 0) { throw "remote extract failed ($LASTEXITCODE)" }
  } finally {
    $ErrorActionPreference = $prevEap
    Remove-Item -Force $tgz -ErrorAction SilentlyContinue
  }
  Write-Host ("pushed: {0} files now under {1}:{2}" -f ($n | Select-Object -Last 1), $target.host, $rp)
}
function Write-TextFile($path, $text) {
  $enc = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText((Long-Path $path), $text, $enc)
}
function Write-BinFile($path, [byte[]]$bytes) { [System.IO.File]::WriteAllBytes((Long-Path $path), $bytes) }
# `Get-Content -Raw` decodes a BOM-less file as ANSI on PS 5.1, which mangles every non-ASCII
# page title. Read the hierarchy as UTF-8 explicitly (honouring a BOM if one is there).
function Load-Xml([string]$path) {
  $doc = New-Object System.Xml.XmlDocument
  $sr = New-Object System.IO.StreamReader((Long-Path $path), [System.Text.Encoding]::UTF8, $true)
  try { $doc.Load($sr) } finally { $sr.Dispose() }
  return $doc
}
function HtmlDecode([string]$s) { if ($null -eq $s) { '' } else { [System.Net.WebUtility]::HtmlDecode($s) } }
function Strip-Tags([string]$s) { [regex]::Replace($s, '(?is)<[^>]+>', '') }

# A OneNote page title is often a whole sentence; cap it so nested paths stay workable.
# -KeepExtension only for real filenames (an attachment's preferredName) — a page title's
# trailing ".2 notes" is not an extension.
function Sanitize-Name([string]$s, [int]$MaxLen = 60, [switch]$KeepExtension) {
  if ([string]::IsNullOrWhiteSpace($s)) { return 'Untitled' }
  $s = [regex]::Replace($s, '[\x00-\x1F]', ' ')          # control chars incl newlines
  $s = [regex]::Replace($s, '[<>:"/\\|?*]', '-')          # windows-illegal
  # `[`/`]` are legal on Windows but are the INDEX selector in a yamlover pointer path. A child
  # whose name holds one is unaddressable: the engine resolves it to null and the whole parent
  # chapter fails to render ("Cannot read properties of null"). Verified against the 0.3.21 engine.
  $s = [regex]::Replace($s, '[\[\]]', '-')
  $s = [regex]::Replace($s, '\s+', ' ').Trim()
  $s = $s.TrimEnd('.', ' ')
  if ($s.Length -gt $MaxLen) {
    $ext = ''
    if ($KeepExtension) {
      $e = [System.IO.Path]::GetExtension($s)
      if ($e.Length -ge 2 -and $e.Length -le 12) { $ext = $e }
    }
    $keep = $MaxLen - $ext.Length
    if ($keep -lt 1) { $keep = 1 }
    $s = $s.Substring(0, [Math]::Min($keep, $s.Length)).TrimEnd('.', ' ') + $ext
  }
  if ($s -eq '') { $s = 'Untitled' }
  if ($s -match '^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$') { $s = "_$s" }
  return $s
}
function Get-UniqueName($usedSet, [string]$base, [string]$ext) {
  $name = "$base$ext"; $i = 2
  while ($usedSet.Contains($name.ToLowerInvariant())) { $name = "$base ($i)$ext"; $i++ }
  [void]$usedSet.Add($name.ToLowerInvariant()); return $name
}
# A pointer key: bare when unambiguous, else double-quoted. Page names routinely contain
# spaces, and a bare key holding one is a parse error (parser/ts/src/pointer.ts, SEPARATOR.md
# "a key containing a space must be quoted"). An all-dots key must be quoted too, or `..`
# reads as the parent selector. Inside double quotes only \ and " need escaping.
function Escape-Ptr([string]$s) {
  if ($s -cmatch '^[^\s:\\/\[\]*&#~?!()<>=|''"]+$' -and $s -notmatch '^\.+$') { return $s }
  '"' + ($s -replace '\\', '\\' -replace '"', '\"') + '"'
}
function Yaml-Scalar([string]$s) {
  if ($null -eq $s) { return '""' }
  if ($s -ne '' -and $s -match '^[\p{L}\p{N}]' -and $s -notmatch '[:#\r\n]' -and $s -eq $s.Trim() -and $s -notmatch '^\*') { return $s }
  $e = $s -replace '\\', '\\' -replace '"', '\"' -replace "`r", '' -replace "`n", '\n'
  return '"' + $e + '"'
}

# ------------------------------------------------------- marklower conversion ---
function Html-To-Marklower([string]$h) {
  if ([string]::IsNullOrEmpty($h)) { return '' }
  # links first: [inner](href). OneNote often puts the separating space INSIDE the <a>;
  # keep it outside the label rather than trimming it away.
  $h = [regex]::Replace($h, '(?is)<a\s+[^>]*?href\s*=\s*"([^"]*)"[^>]*>(.*?)</a>', {
      param($m)
      $inner = HtmlDecode (Strip-Tags $m.Groups[2].Value)
      $core = $inner.Trim()
      if ($core -eq '') { return $inner }
      $lead = $inner.Substring(0, $inner.Length - $inner.TrimStart().Length)
      $trail = $inner.Substring($inner.TrimEnd().Length)
      $lead + '[' + $core + '](' + (HtmlDecode $m.Groups[1].Value) + ')' + $trail })
  # inline styles -> marklower
  $h = [regex]::Replace($h, '(?is)<span[^>]*font-weight\s*:\s*bold[^>]*>(.*?)</span>', { param($m) '**' + (Strip-Tags $m.Groups[1].Value) + '**' })
  $h = [regex]::Replace($h, '(?is)<span[^>]*font-style\s*:\s*italic[^>]*>(.*?)</span>', { param($m) '*' + (Strip-Tags $m.Groups[1].Value) + '*' })
  $h = [regex]::Replace($h, '(?is)<span[^>]*text-decoration\s*:[^>]*line-through[^>]*>(.*?)</span>', { param($m) '~~' + (Strip-Tags $m.Groups[1].Value) + '~~' })
  $h = [regex]::Replace($h, '(?is)<br\s*/?>', "`n")
  $h = Strip-Tags $h
  $h = HtmlDecode $h
  return $h.Trim()
}
function Get-OEText($oe, $ns) {
  $h = ''
  foreach ($r in $oe.SelectNodes('./one:T', $ns)) { $h += $r.InnerText }
  Html-To-Marklower $h
}

# --------------------------------------------------------------- page content ---
function Get-PageXml([string]$id, [bool]$binary) {
  $x = $null
  if ($binary) { $on.GetPageContent($id, [ref]$x, 1) } else { $on.GetPageContent($id, [ref]$x) }
  return $x
}
function Ext-FromFormat([string]$fmt) {
  switch ($fmt) {
    'image/png' { '.png' }; 'image/jpeg' { '.jpg' }; 'image/gif' { '.gif' }
    'image/bmp' { '.bmp' }; 'image/tiff' { '.tiff' }; default { '.png' }
  }
}
# Attachment MIME by extension. Declared in .yamlover/meta.yamlover so `/api/blob` streams the
# asset with the right Content-Type; the engine's own EXT_FORMAT knows images but not media.
function Mime-FromName([string]$name) {
  $mime = @{
    '.png'='image/png'; '.jpg'='image/jpeg'; '.jpeg'='image/jpeg'; '.gif'='image/gif'
    '.bmp'='image/bmp'; '.tif'='image/tiff'; '.tiff'='image/tiff'; '.webp'='image/webp'
    '.svg'='image/svg+xml'; '.ico'='image/x-icon'; '.heic'='image/heic'
    '.3gp'='audio/3gpp'; '.3g2'='audio/3gpp2'; '.m4a'='audio/mp4'; '.mp3'='audio/mpeg'
    '.wav'='audio/wav'; '.wma'='audio/x-ms-wma'; '.ogg'='audio/ogg'; '.oga'='audio/ogg'
    '.opus'='audio/opus'; '.aac'='audio/aac'; '.flac'='audio/flac'; '.amr'='audio/amr'
    '.mp4'='video/mp4'; '.m4v'='video/mp4'; '.mov'='video/quicktime'; '.avi'='video/x-msvideo'
    '.wmv'='video/x-ms-wmv'; '.mkv'='video/x-matroska'; '.webm'='video/webm'
    '.pdf'='application/pdf'; '.zip'='application/zip'; '.rtf'='application/rtf'
    '.doc'='application/msword'; '.xls'='application/vnd.ms-excel'; '.ppt'='application/vnd.ms-powerpoint'
    '.docx'='application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    '.xlsx'='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    '.pptx'='application/vnd.openxmlformats-officedocument.presentationml.presentation'
    '.epub'='application/epub+zip'; '.djvu'='image/vnd.djvu'; '.psd'='image/vnd.adobe.photoshop'
    '.txt'='text/plain'; '.csv'='text/csv'; '.htm'='text/html'; '.html'='text/html'
    '.json'='application/json'; '.xml'='application/xml'
  }
  $ext = [System.IO.Path]::GetExtension($name).ToLowerInvariant()
  if ($mime.ContainsKey($ext)) { $mime[$ext] } else { 'application/octet-stream' }
}
# RFC 4180. A cell's newlines collapse to a space: a bare newline inside a block-scalar CSV
# chunk would read as a row break, and OneNote cells wrap for layout, not meaning.
function Csv-Field([string]$s) {
  $s = ($s -replace "`r", '') -replace "`n", ' '
  if ($s -match '[",]' -or $s -ne $s.Trim()) { '"' + ($s -replace '"', '""') + '"' } else { $s }
}
function Short-Hash([byte[]]$b) {
  $sha = [System.Security.Cryptography.SHA1]::Create()
  ($sha.ComputeHash($b)[0..3] | ForEach-Object { $_.ToString('x2') }) -join ''
}
function Table-ToCsv($tbl, $ns) {
  $rows = New-Object System.Collections.Generic.List[string]
  foreach ($row in $tbl.SelectNodes('./one:Row', $ns)) {
    $cells = @()
    foreach ($cell in $row.SelectNodes('./one:Cell', $ns)) {
      $parts = @()
      foreach ($oe in $cell.SelectNodes('.//one:OE', $ns)) { $t = Get-OEText $oe $ns; if ($t -ne '') { $parts += $t } }
      $cells += (Csv-Field ($parts -join ' '))
    }
    $rows.Add(($cells -join ','))
  }
  $rows -join "`n"
}
# Register an asset once per page; content-identical images share a hashed name, so a repeat
# is the same file. Distinct files that collide on name get a ` (2)` suffix.
function Add-Asset($assets, [string]$name, [byte[]]$bytes) {
  foreach ($a in $assets) { if ($a.name -ceq $name) { return $name } }
  $final = $name; $i = 2
  $stem = [System.IO.Path]::GetFileNameWithoutExtension($name)
  $ext = [System.IO.Path]::GetExtension($name)
  while ($assets | Where-Object { $_.name -ceq $final }) { $final = "$stem ($i)$ext"; $i++ }
  $assets.Add(@{ name = $final; bytes = $bytes })
  return $final
}
function Walk-OE($oe, [int]$depth, $lines, $tail, $assets, $ns) {
  $tbl = $oe.SelectSingleNode('./one:Table', $ns)
  if ($tbl) { $tail.Add(@{ kind = 'csv'; text = (Table-ToCsv $tbl $ns) }) }
  $img = $oe.SelectSingleNode('./one:Image', $ns)
  if ($img) {
    $data = $img.SelectSingleNode('./one:Data', $ns)
    if ($data -and -not [string]::IsNullOrWhiteSpace($data.InnerText)) {
      $bytes = [Convert]::FromBase64String($data.InnerText.Trim())
      $name = Add-Asset $assets ('image-' + (Short-Hash $bytes) + (Ext-FromFormat $img.format)) $bytes
      $tail.Add(@{ kind = 'ptr'; file = $name })
    }
    # else: web-content preview / callback-only image -> skipped (adjacent link already a chunk)
  }
  # An attachment (audio recording, pdf, …). OneNote keeps the bytes in its own cache and the
  # original filename in `preferredName`; the page XML never inlines them.
  $ins = $oe.SelectSingleNode('./one:InsertedFile', $ns)
  if ($ins) {
    $src = $ins.pathCache
    if ($src -and (Test-Path -LiteralPath $src)) {
      $bytes = [System.IO.File]::ReadAllBytes($src)
      $pref = if ([string]::IsNullOrWhiteSpace($ins.preferredName)) { 'file-' + (Short-Hash $bytes) + '.bin' } else { $ins.preferredName }
      $name = Add-Asset $assets (Sanitize-Name $pref -KeepExtension) $bytes
      $tail.Add(@{ kind = 'ptr'; file = $name })
    } else {
      Write-Warning ("InsertedFile bytes missing, skipped: '{0}' (pathCache={1})" -f $ins.preferredName, $src)
    }
  }
  $txt = Get-OEText $oe $ns
  if ($txt -ne '') {
    $prefix = if ($depth -le 0) { '' } else { ('  ' * ($depth - 1)) + '- ' }
    $lines.Add($prefix + $txt)
  }
  foreach ($child in $oe.SelectNodes('./one:OEChildren/one:OE', $ns)) { Walk-OE $child ($depth + 1) $lines $tail $assets $ns }
}
function Convert-Page([string]$pageId) {
  $basic = Get-PageXml $pageId $false
  $hasImg = $basic -match '<one:Image'
  $xmlStr = if ($hasImg) { Get-PageXml $pageId $true } else { $basic }
  [xml]$doc = $xmlStr
  $ns = New-Ns $doc
  $chunks = New-Object System.Collections.Generic.List[object]
  $assets = New-Object System.Collections.Generic.List[object]
  foreach ($outline in $doc.SelectNodes('//one:Outline', $ns)) {
    foreach ($oe in $outline.SelectNodes('./one:OEChildren/one:OE', $ns)) {
      $lines = New-Object System.Collections.Generic.List[string]
      $tail = New-Object System.Collections.Generic.List[object]
      Walk-OE $oe 0 $lines $tail $assets $ns
      if ($lines.Count -gt 0) { $chunks.Add(@{ kind = 'text'; text = ($lines -join "`n") }) }
      foreach ($t in $tail) { $chunks.Add($t) }
    }
  }
  return @{ chunks = $chunks; assets = $assets }
}

# --------------------------------------------------------------- serialization ---
# One positional body: chunks, then subchapter pointers. OneNote subpages always follow
# their parent page's own content, so appending them preserves the author's order.
# The `- *: <name>` pointers are what override the engine's alphabetical directory scan.
function Serialize-Chapter([string]$title, $chunks, $childNames) {
  $sb = New-Object System.Collections.Generic.List[string]
  $sb.Add('!!<*yamlover: $defs: chapter>')
  # the title is the chapter root's scalar SELF-VALUE line (fully-omni, CHAPTER.md) - no `title:` key
  $sb.Add((Yaml-Scalar $title))
  # the .Count guards are load-bearing: in PS 5.1 `foreach ($x in $null)` runs one iteration
  if ($chunks -and $chunks.Count -gt 0) {
    foreach ($c in $chunks) {
      switch ($c.kind) {
        'ptr' { $sb.Add('- *: ' + (Escape-Ptr $c.file)) }
        'csv' {
          $sb.Add('- !!<format: text/csv> |')
          foreach ($ln in ($c.text -split "`n")) { $sb.Add('  ' + $ln) }
        }
        default {
          $sb.Add('- |')
          foreach ($ln in ($c.text -split "`n")) { $sb.Add('  ' + $ln) }
        }
      }
    }
  }
  if ($childNames -and $childNames.Count -gt 0) {
    foreach ($n in $childNames) { $sb.Add('- *: ' + (Escape-Ptr $n)) }
  }
  ($sb -join "`n") + "`n"
}
# `.yamlover/meta.yamlover` declares each asset's (type, format), so the engine serves it with
# the right Content-Type instead of sniffing it as application/octet-stream (examples/65).
function Serialize-Meta($assets) {
  if (-not $assets -or $assets.Count -eq 0) { return $null }
  $sb = New-Object System.Collections.Generic.List[string]
  $sb.Add('properties:')
  foreach ($a in $assets) {
    $sb.Add('  ' + (Yaml-Scalar $a.name) + ': { type: binary, format: ' + (Mime-FromName $a.name) + ' }')
  }
  ($sb -join "`n") + "`n"
}

# --------------------------------------------------------------- materialize ---
function Reconstruct-Pages($sec, $ns) {
  $result = New-Object System.Collections.Generic.List[object]
  $stack = @{}
  foreach ($pg in $sec.SelectNodes('./one:Page', $ns)) {
    if ($pg.isInRecycleBin -eq 'true') { continue }
    $lvl = [int]$pg.pageLevel; if ($lvl -lt 1) { $lvl = 1 }
    $obj = [pscustomobject]@{ Node = $pg; Sub = (New-Object System.Collections.Generic.List[object]) }
    if ($lvl -le 1) { $result.Add($obj); $stack = @{ 1 = $obj } }
    else {
      $parent = $stack[$lvl - 1]
      if ($parent) { $parent.Sub.Add($obj) } else { $result.Add($obj) }
      $stack[$lvl] = $obj
    }
  }
  $result
}
function Materialize-Page($pobj, [string]$parentDir, $usedSet) {
  $node = $pobj.Node
  $title = $node.name
  $conv = Convert-Page $node.ID
  $needsDir = ($conv.assets.Count -gt 0) -or ($pobj.Sub.Count -gt 0)
  $base = Sanitize-Name $title
  if ($needsDir) {
    $dirName = Get-UniqueName $usedSet $base ''
    $dir = Join-Path $parentDir $dirName
    New-Dir (Join-Path $dir '.yamlover')
    foreach ($a in $conv.assets) { Write-BinFile (Join-Path $dir $a.name) $a.bytes }
    $meta = Serialize-Meta $conv.assets
    if ($meta) { Write-TextFile (Join-Path $dir '.yamlover\meta.yamlover') $meta }
    $childNames = New-Object System.Collections.Generic.List[string]
    $childUsed = New-Object System.Collections.Generic.HashSet[string]
    foreach ($sp in $pobj.Sub) { $childNames.Add((Materialize-Page $sp $dir $childUsed)) }
    Write-TextFile (Join-Path $dir '.yamlover\body.yamlover') (Serialize-Chapter $title $conv.chunks $childNames)
    return $dirName
  } else {
    $fileName = Get-UniqueName $usedSet $base '.yamlover'
    Write-TextFile (Join-Path $parentDir $fileName) (Serialize-Chapter $title $conv.chunks $null)
    return $fileName
  }
}
function Materialize-Section($sec, [string]$parentDir, $usedSet, $ns) {
  $base = Sanitize-Name $sec.name
  $dirName = Get-UniqueName $usedSet $base ''
  $dir = Join-Path $parentDir $dirName
  New-Dir (Join-Path $dir '.yamlover')
  $pages = Reconstruct-Pages $sec $ns
  $used = New-Object System.Collections.Generic.HashSet[string]
  $childNames = New-Object System.Collections.Generic.List[string]
  $n = 0
  foreach ($p in $pages) { $childNames.Add((Materialize-Page $p $dir $used)); $n++; Write-Host ("    page: {0}" -f $p.Node.name) }
  Write-TextFile (Join-Path $dir '.yamlover\body.yamlover') (Serialize-Chapter $sec.name $null $childNames)
  Write-Host ("  section '{0}' -> {1} top-level pages" -f $sec.name, $n)
  return $dirName
}

# --------------------------------------------------------------- driver ---
$remote = Parse-SshTarget $OutRoot
$localRoot = if ($remote) { $StageDir } else { $OutRoot }
if ($remote) { Write-Host ("remote target: {0}:{1}  (staging in {2})" -f $remote.host, $remote.path, $localRoot) }

if ($RefreshHierarchy -or -not (Test-Path -LiteralPath $HierPath)) {
  New-Dir (Split-Path -Parent $HierPath)
  $hx = $null
  $on.GetHierarchy('', 4, [ref]$hx)   # hsPages: notebooks -> section groups -> sections -> pages
  Write-TextFile $HierPath $hx
  Write-Host "hierarchy refreshed -> $HierPath"
}
$hier = Load-Xml $HierPath
$ns = New-Ns $hier
$nb = $hier.SelectSingleNode("//one:Notebook[@name=""$Notebook""]", $ns)
if (-not $nb) { throw "Notebook '$Notebook' not found in hierarchy" }

$nbBase = Sanitize-Name $nb.name
$nbDir = Join-Path $localRoot $nbBase
# A stale page renamed/deleted in OneNote would otherwise linger; -Clean makes the run a mirror.
if ($Clean -and [System.IO.Directory]::Exists((Long-Path $nbDir))) {
  [System.IO.Directory]::Delete((Long-Path $nbDir), $true)
}
New-Dir (Join-Path $nbDir '.yamlover')

$secUsed = New-Object System.Collections.Generic.HashSet[string]
$secNames = New-Object System.Collections.Generic.List[string]
foreach ($sec in $nb.SelectNodes('./one:Section', $ns)) {
  if ($sec.isInRecycleBin -eq 'true') { continue }
  if ($Section -ne '' -and $sec.name -ne $Section) { continue }
  $secNames.Add((Materialize-Section $sec $nbDir $secUsed $ns))
}
Write-TextFile (Join-Path $nbDir '.yamlover\body.yamlover') (Serialize-Chapter $nb.name $null $secNames)
Write-Host ("DONE: notebook '{0}' -> {1} sections at {2}" -f $nb.name, $secNames.Count, $nbDir)

if ($remote) { Push-Remote $localRoot $remote ([bool]$Clean) }
