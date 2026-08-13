# setup_windows.ps1
# Windows PowerShell 환경에서 Python 백엔드를 설정하는 스크립트입니다.
# 실행 방법: PowerShell에서  .\setup_windows.ps1

Write-Host "=== MediSeg Python Backend 설정 ===" -ForegroundColor Cyan

# ── 1. Python 설치 확인 ─────────────────────────────────────────────────────
$pythonCmd = $null
foreach ($cmd in @("python", "python3", "py")) {
    try {
        $ver = & $cmd --version 2>&1
        if ($ver -match "Python (\d+\.\d+)") {
            $pythonCmd = $cmd
            Write-Host "[OK] Python 발견: $ver ($cmd)" -ForegroundColor Green
            break
        }
    } catch { }
}

if (-not $pythonCmd) {
    Write-Host "[ERROR] Python을 찾을 수 없습니다." -ForegroundColor Red
    Write-Host ""
    Write-Host "Python 3.9+ 설치 방법:" -ForegroundColor Yellow
    Write-Host "  1. https://www.python.org/downloads/ 에서 다운로드"
    Write-Host "     설치 시 'Add Python to PATH' 체크 필수!"
    Write-Host "  2. 또는 Microsoft Store에서 'Python 3.11' 검색 후 설치"
    Write-Host "  3. 설치 후 PowerShell을 재시작하고 다시 실행하세요."
    exit 1
}

# Python 버전 확인 (3.9 이상 필요)
$verStr = (& $pythonCmd --version 2>&1) -replace "Python ", ""
$verParts = $verStr.Split(".")
if ([int]$verParts[0] -lt 3 -or ([int]$verParts[0] -eq 3 -and [int]$verParts[1] -lt 9)) {
    Write-Host "[WARNING] Python $verStr 감지. Python 3.9+ 권장합니다." -ForegroundColor Yellow
}

# ── 2. 가상환경 생성 ──────────────────────────────────────────────────────────
$venvDir = Join-Path $PSScriptRoot ".venv"
if (-not (Test-Path $venvDir)) {
    Write-Host "[...] 가상환경 생성 중: $venvDir" -ForegroundColor Yellow
    & $pythonCmd -m venv $venvDir
    Write-Host "[OK] 가상환경 생성 완료" -ForegroundColor Green
} else {
    Write-Host "[OK] 가상환경 이미 존재: $venvDir" -ForegroundColor Green
}

# ── 3. pip 업그레이드 및 패키지 설치 ─────────────────────────────────────────
$pipExe = Join-Path $venvDir "Scripts\pip.exe"
$pythonExe = Join-Path $venvDir "Scripts\python.exe"

Write-Host "[...] pip 업그레이드 중..." -ForegroundColor Yellow
& $pythonExe -m pip install --upgrade pip --quiet

Write-Host "[...] 패키지 설치 중 (시간이 걸릴 수 있습니다)..." -ForegroundColor Yellow
& $pipExe install -r (Join-Path $PSScriptRoot "requirements.txt")

if ($LASTEXITCODE -eq 0) {
    Write-Host "[OK] 모든 패키지 설치 완료!" -ForegroundColor Green
} else {
    Write-Host "[ERROR] 패키지 설치 실패. 오류를 확인하세요." -ForegroundColor Red
    exit 1
}

# ── 4. 실행 방법 안내 (Windows PowerShell 전용) ────────────────────────────
$activateScript = Join-Path $venvDir "Scripts\Activate.ps1"
Write-Host ""
Write-Host "=== 실행 방법 ===" -ForegroundColor Cyan
Write-Host "# 먼저 가상환경 활성화:" -ForegroundColor White
Write-Host "  . '$activateScript'" -ForegroundColor Yellow
Write-Host ""
Write-Host "# 단일 케이스 실행:" -ForegroundColor White
Write-Host "  python pipeline.py --input ..\data\input\patient_001 --case-id patient_001" -ForegroundColor Yellow
Write-Host ""
Write-Host "# CPU 강제 사용 (PowerShell 방식):" -ForegroundColor White
Write-Host "  `$env:DEVICE='cpu'; python pipeline.py --input ..\data\input\patient_001" -ForegroundColor Yellow
Write-Host ""
Write-Host "# 배치 처리:" -ForegroundColor White
Write-Host "  python pipeline.py --input ..\data\input --batch" -ForegroundColor Yellow
Write-Host ""
Write-Host "=== 설정 완료 ===" -ForegroundColor Cyan
