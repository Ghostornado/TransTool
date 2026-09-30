$ErrorActionPreference = 'Stop'
$src   = 'D:\TransTool'
$stage = 'D:\TransTool_stage'
$zip   = 'D:\TransTool-v1.1.zip'

# 清理旧 staging 和旧包
Remove-Item -Recurse -Force $stage -ErrorAction SilentlyContinue
Remove-Item -Force $zip -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path $stage | Out-Null

# 程序本体
Copy-Item "$src\server.js"       $stage
Copy-Item "$src\start.bat"       $stage
Copy-Item "$src\package.json"    $stage
Copy-Item "$src\node.exe"        $stage
Copy-Item "$src\public"          $stage\public -Recurse
Copy-Item "$src\node_modules"    $stage\node_modules -Recurse

# 使用说明
Copy-Item "$src\使用说明.txt"    $stage

# 空的数据目录（不含个人传输记录）
New-Item -ItemType Directory -Path $stage\data    | Out-Null
New-Item -ItemType Directory -Path $stage\uploads | Out-Null

Compress-Archive -Path "$stage\*" -DestinationPath $zip -Force
Remove-Item -Recurse -Force $stage

Write-Output "OK $zip"
