# 打包并把 tarball 放进 profile —— README 里的建议安装方式。
#
# 用途：让 profile 与源码目录解耦（发布、复现、验证安装链路本身）。
#
# 流程：
#   1) 改源码，并把 package.json 的 version bump 一位
#   2) 跑本脚本：pnpm pack 出 tarball → 复制进 profile → 改写 profile 的 dependencies
#   3) 在 profile 目录里 pnpm install
#   4) 重启 DSH
$ErrorActionPreference = 'Stop'

$work = $PSScriptRoot
$profileDir = if ($env:DSH_PROFILE_DIR) { $env:DSH_PROFILE_DIR } else { Join-Path $env:USERPROFILE '.dsh\profiles\desktop' }
$manifestPath = Join-Path $profileDir 'package.json'
$name = (Get-Content (Join-Path $work 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json).name

# 1) 打包
Push-Location $work
try {
    $runtime = Join-Path $env:USERPROFILE '.dsh\dsh-runtimes\dsh-primary-runtime\dependencies'
    $nodeExe = Join-Path $runtime 'node\bin\node.exe'
    $pnpmJs = Join-Path $runtime 'pnpm\bin\pnpm.mjs'
    if ((Test-Path $nodeExe) -and (Test-Path $pnpmJs)) { & $nodeExe $pnpmJs pack } else { & pnpm pack }
    if ($LASTEXITCODE -ne 0) { throw "pack 失败（exit $LASTEXITCODE）" }
} finally { Pop-Location }

# 2) 取最新 tarball 放进 profile
$tgz = Get-ChildItem $work -Filter "$name-*.tgz" | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $tgz) { throw '没有找到 tarball' }
Copy-Item $tgz.FullName $profileDir -Force
Write-Output "tarball -> $(Join-Path $profileDir $tgz.Name)"

# 3) 把 profile 的 dependencies 指向这个 tarball
$manifest = Get-Content $manifestPath -Raw -Encoding UTF8
$pattern = '"' + [regex]::Escape($name) + '"\s*:\s*"[^"]*"'
if ($manifest -notmatch $pattern) { throw "$name 不在 profile 的 dependencies 里 —— 先补上这一行再跑本脚本" }
$next = [regex]::Replace($manifest, $pattern, '"' + $name + '": "file:' + $tgz.Name + '"', 1)
if ($next -ne $manifest) {
    [System.IO.File]::WriteAllText($manifestPath, $next, (New-Object System.Text.UTF8Encoding($false)))
    Write-Output "dependencies.$name = file:$($tgz.Name)"
} else {
    Write-Output "dependencies.$name 已经指向 $($tgz.Name)"
}

# 4) 旧 tarball 清掉，免得目录里堆一串
Get-ChildItem $profileDir -Filter "$name-*.tgz" | Where-Object { $_.Name -ne $tgz.Name } | Remove-Item -Force

Write-Output ''
Write-Output "接下来在 $profileDir 里跑： pnpm install"
Write-Output '然后重启 DSH。'
