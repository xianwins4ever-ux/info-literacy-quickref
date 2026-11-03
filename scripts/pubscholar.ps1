# ============================================================
# PubScholar 公益学术平台 速查 —— CLI 直连（无浏览器）
#
# 逆向要点（2026-10-09 实测）：
#   1. 接口前缀是 /hky + /open/resources/api/v1|v2（不是裸 /open/...，写错返回 SPA 首页）
#   2. 每个请求都要签名头：
#        nonce     = 6 位随机 [0-9a-z]
#        timestamp = 毫秒时间戳
#        signature = SHA1( sort([secret, timestamp, nonce]).join('') )
#        secret    = 6m6pingbinwaktg227gngifoocrfbo95
#        x-finger  = 任意 32 位指纹（客户端 indexdb 值，服务端不校验内容）
#        X-XSRF-TOKEN = 先 GET /hky/welcome 拿到的 XSRF-TOKEN Cookie（缺了必 403）
#   3. 详情接口的 token = base64( base64( AES-128-CBC(文章ID) ) )
#        key = eRtYuIoPaSdFgHqW   iv = Nmc09JkLzX8765Vb
#        页面 URL 里的 96 位十六进制串 = hex( AES-128-CBC(文章ID) )，可互相换算
#
# 用法：
#   pwsh -File pubscholar.ps1 -Query "salt substitution blood pressure"      # 检索列表
#   pwsh -File pubscholar.ps1 -Suggest "Effects of salt substitution on cumulative blood pressure"
#   pwsh -File pubscholar.ps1 -Id  daa102490f17232a2fa83f8a00b7f4cb          # 详情 + 全文获取渠道
#   pwsh -File pubscholar.ps1 -Url "https://pubscholar.cn/articles/c74337a1...8d6a"
# ============================================================
param(
  [string]$Query,
  [string]$Suggest,
  [string]$Id,
  [string]$Url,
  [int]$Size = 10,
  [switch]$Json
)

$ProgressPreference = 'SilentlyContinue'
$ErrorActionPreference = 'Stop'

$SCRIPT:Secret = '6m6pingbinwaktg227gngifoocrfbo95'
$SCRIPT:Finger = '892a7b10be668a178125929c112bbb1b'   # 任意 32 位串即可
$SCRIPT:UA     = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36 Edg/154.0.0.0'
$SCRIPT:Base   = 'https://pubscholar.cn'
$SCRIPT:AesKey = 'eRtYuIoPaSdFgHqW'
$SCRIPT:AesIv  = 'Nmc09JkLzX8765Vb'

function Get-Sha1([string]$s) {
  $h = [System.Security.Cryptography.SHA1]::Create()
  (($h.ComputeHash([Text.Encoding]::UTF8.GetBytes($s)) | ForEach-Object { $_.ToString('x2') }) -join '')
}

function New-Session {
  $sess = New-Object Microsoft.PowerShell.Commands.WebRequestSession
  Invoke-WebRequest -Uri "$SCRIPT:Base/hky/welcome" -WebSession $sess -UserAgent $SCRIPT:UA -TimeoutSec 30 -UseBasicParsing | Out-Null
  $xsrf = ($sess.Cookies.GetCookies($SCRIPT:Base) | Where-Object { $_.Name -eq 'XSRF-TOKEN' }).Value
  [pscustomobject]@{ Session = $sess; Xsrf = $xsrf }
}

function Invoke-Pub($Method, $Path, $BodyObj, $Sess) {
  $ts = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds().ToString()
  $nonce = -join ((1..6) | ForEach-Object { '0123456789abcdefghijklmnopqrstuvwxyz'[(Get-Random -Max 36)] })
  $sig = Get-Sha1 ((@($SCRIPT:Secret, $ts, $nonce) | Sort-Object) -join '')
  $headers = @{ nonce = $nonce; timestamp = $ts; signature = $sig; 'x-finger' = $SCRIPT:Finger; 'X-XSRF-TOKEN' = $Sess.Xsrf }
  $req = @{ Uri = "$SCRIPT:Base$Path"; Method = $Method; Headers = $headers; WebSession = $Sess.Session; UserAgent = $SCRIPT:UA; TimeoutSec = 40; UseBasicParsing = $true }
  if ($null -ne $BodyObj) { $req.Body = ($BodyObj | ConvertTo-Json -Compress -Depth 10); $req.ContentType = 'application/json' }
  $r = Invoke-WebRequest @req
  $txt = if ($r.Content -is [byte[]]) { [Text.Encoding]::UTF8.GetString($r.Content) } else { $r.Content }
  $txt | ConvertFrom-Json
}

function Get-Aes([bool]$Encrypt) {
  $a = [System.Security.Cryptography.Aes]::Create()
  $a.Mode = 'CBC'; $a.Padding = 'PKCS7'
  $a.Key = [Text.Encoding]::UTF8.GetBytes($SCRIPT:AesKey)
  $a.IV = [Text.Encoding]::UTF8.GetBytes($SCRIPT:AesIv)
  $a
}

function Get-DetailToken([string]$ArticleId) {
  $aes = Get-Aes $true
  $pt = [Text.Encoding]::UTF8.GetBytes($ArticleId)
  $cipher = $aes.CreateEncryptor().TransformFinalBlock($pt, 0, $pt.Length)
  [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes([Convert]::ToBase64String($cipher)))
}

function Get-IdFromUrl([string]$u) {
  $tok = ($u.Trim().TrimEnd('/') -split '/')[-1]
  if ($tok -match '^[0-9a-fA-F]{32}$') { return $tok }
  if ($tok -match '^[0-9a-fA-F]+$' -and $tok.Length % 2 -eq 0) {
    $bytes = for ($i = 0; $i -lt $tok.Length; $i += 2) { [Convert]::ToByte($tok.Substring($i, 2), 16) }
    $aes = Get-Aes $false
    $dec = $aes.CreateDecryptor().TransformFinalBlock($bytes, 0, $bytes.Length)
    return (-join ($dec | ForEach-Object { [char]$_ }))
  }
  throw "无法从 URL 解析文章 ID: $u"
}

$sw = [Diagnostics.Stopwatch]::StartNew()
$Sess = New-Session

# ---------- 详情：全文获取渠道 ----------
if ($Id -or $Url) {
  if (-not $Id) { $Id = Get-IdFromUrl $Url }
  $token = Get-DetailToken $Id
  $d = Invoke-Pub 'GET' "/hky/open/resources/api/v2/article/$token`?uid=$SCRIPT:Finger&type=article" $null $Sess
  if ($Json) { $d | ConvertTo-Json -Depth 4; exit 0 }
  Write-Host "=== $($d.title) ==="
  Write-Host "SOURCE : $($d.source)  $($d.date)  vol.$($d.volume) no.$($d.issue) p.$($d.first_page)-$($d.last_page)"
  Write-Host "DOI    : $($d.doi)"
  Write-Host "FREE   : $($d.is_free)"
  Write-Host "全文获取渠道:"
  if ($d.links) { foreach ($l in $d.links) { Write-Host ("   - {0,-12} {1}" -f $l.name, $l.url) } } else { Write-Host '   - (无 links 字段)' }
  if ($d.local_links) { foreach ($l in $d.local_links) { Write-Host "   - 本平台全文  $l" } }
  if ($d.extendEntity.extend.fulltext_url) { Write-Host "   - 平台全文URL $($d.extendEntity.extend.fulltext_url)" }
  Write-Host ("ELAPSED = {0:N1} s" -f $sw.Elapsed.TotalSeconds)
  exit 0
}

# ---------- 精确题名：suggestions ----------
if ($Suggest) {
  $s = Invoke-Pub 'POST' '/hky/open/resources/api/v1/article/suggestions' @{ query = $Suggest } $Sess
  if ($Json) { $s | ConvertTo-Json -Depth 6; exit 0 }
  if (-not $s -or $s.Count -eq 0) { Write-Host "(无建议结果)"; exit 1 }
  foreach ($it in $s) { Write-Host ("ID={0}`n    {1}  [{2}]" -f $it.id, $it.title, $it.type) }
  Write-Host ("ELAPSED = {0:N1} s" -f $sw.Elapsed.TotalSeconds)
  exit 0
}

# ---------- 检索列表 ----------
if ($Query) {
  $body = @{
    page = 1; size = $Size; order_field = 'default'; order_direction = 'desc'
    user_id = $SCRIPT:Finger; lang = 'zh'; query = $Query; strategy = $null
  }
  $r = Invoke-Pub 'POST' '/hky/open/resources/api/v1/articles' $body $Sess
  if ($Json) { $r | ConvertTo-Json -Depth 6; exit 0 }
  Write-Host "=== hit=$($r.total) ==="
  $i = 0
  foreach ($a in $r.content) {
    $i++
    Write-Host ("[{0}] {1}" -f $i, ($a.title -replace '<[^>]+>', ''))
    Write-Host ("     ID={0}  {1} {2}  DOI={3}  FREE={4}" -f $a.id, $a.source, $a.date, $a.doi, $a.is_free)
    if ($a.links) { Write-Host ("     渠道: " + (($a.links | ForEach-Object { "$($_.name)" }) -join ', ')) }
  }
  Write-Host ("ELAPSED = {0:N1} s" -f $sw.Elapsed.TotalSeconds)
  exit 0
}

Write-Host "用法: -Query <检索词> | -Suggest <题名> | -Id <文章ID> | -Url <详情页URL>  [-Json]"
