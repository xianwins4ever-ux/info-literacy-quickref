# ============================================================
# DSpace 机构库速查 —— 一次调用出答案
#
# 用途：MIT Theses / 各高校机构知识库（DSpace 7 平台）
# 用法：
#   pwsh -File dspace.ps1 -Query "Managing maintenance costs of pharmaceutical research and development"
#   pwsh -File dspace.ps1 -Query "..." -Server dspace.mit.edu -Size 3
#
# 设计原则（比赛用，30秒/题）：
#   1. 只发 1 次 HTTP 请求 —— discover 接口的返回里已含完整元数据
#   2. 优先输出元数据字段（页数/年份/学位），不下载任何文件
#   3. 需要 PDF 时再取 bitstream（见 -WithPdf 开关）
# ============================================================
param(
  [Parameter(Mandatory = $true)][string]$Query,
  [string]$Server = "dspace.mit.edu",
  [int]$Size = 5,
  [switch]$WithPdf
)

$ProgressPreference = 'SilentlyContinue'

# ⚠️ 必须显式启用 TLS 1.2。
# 本机 PowerShell 是 5.1，默认只协商 TLS 1.0 —— 直连 dspace.mit.edu 会报
#   「基础连接已经关闭: 发送时发生错误。」
# 加上这一行后正常（实测 total=98983）。
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Get-MdValue($md, [string]$key) {
  if ($null -ne $md.$key) { ($md.$key | ForEach-Object { $_.value }) -join ' ; ' } else { '-' }
}

$q   = [uri]::EscapeDataString($Query)
$url = "https://$Server/server/api/discover/search/objects?query=$q&size=$Size"

try {
  $r = Invoke-RestMethod -Uri $url -TimeoutSec 25
} catch {
  $msg = $_.Exception.Message
  Write-Host "ERR [$Server] $msg"
  # ⚠️ 2026-10-17：MIT 的 DSpace API 有**频率限制**，短时间内多次调用会返回
  #    `(429) Too Many Requests`。这不是脚本坏了，等 1~5 分钟即可恢复。
  #    比赛时如果时间紧，改用替代源：
  #      · 论文页数 → 万方/知网查同名学位论文
  #      · 或直接用 webq.mjs 抓论文详情页
  if ($msg -match '429|Too Many Requests') {
    Write-Host ""
    Write-Host "⚠️ MIT DSpace 触发了频率限制（429），不是脚本问题。"
    Write-Host "   对策：等 1~5 分钟再试；或换源（万方/知网查同名学位论文）。"
    exit 429
  }
  exit 1
}

$sr = $r._embedded.searchResult
Write-Host "=== $Server | hit=$($sr.page.totalElements) ==="

$i = 0
foreach ($o in $sr._embedded.objects) {
  $i++
  if ($i -gt $Size) { break }
  $ind = $o._embedded.indexableObject
  $md  = $ind.metadata

  Write-Host ("[{0}] {1}" -f $i, (Get-MdValue $md 'dc.title'))
  Write-Host ("    PAGES : " + (Get-MdValue $md 'dc.format.extent'))
  Write-Host ("    YEAR  : " + (Get-MdValue $md 'dc.date.issued') + "    DEGREE: " + (Get-MdValue $md 'dc.description.degree'))
  Write-Host ("    AUTHOR: " + (Get-MdValue $md 'dc.contributor.author'))
  Write-Host ("    UUID  : " + $ind.uuid)

  if ($WithPdf) {
    try {
      $b = Invoke-RestMethod -Uri "https://$Server/server/api/core/items/$($ind.uuid)/bundles" -TimeoutSec 25
      foreach ($bd in $b._embedded.bundles) {
        if ($bd.name -eq 'ORIGINAL') {
          $u2 = $bd._links.bitstreams.href
          if ($u2 -notmatch '^https?://') { $u2 = "https://$Server$u2" }
          $bs = Invoke-RestMethod -Uri ($u2 + '?size=20') -TimeoutSec 25
          foreach ($bb in $bs._embedded.bitstreams) {
            Write-Host ("    PDF   : " + $bb.name + "  " + [math]::Round($bb.sizeBytes / 1MB, 1) + " MB")
            Write-Host ("            " + $bb._links.content.href)
          }
        }
      }
    } catch { Write-Host "    PDF   : (bindstream err)" }
  }
}
