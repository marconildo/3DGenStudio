@echo off
:: Start the 3D Gen Studio video-to-motion micro-service (mocap_server.py).
::
:: On first run this uses `uv` to provision a pinned standalone Python (3.13),
:: create a local virtual environment, and install this folder's
:: requirements.txt, a CUDA-matched torch and the model checkpoint (~460 MB).
::
:: Python 3.13 is not arbitrary: `bpy` (Blender as an importable module, which
:: the per-rig bake needs) publishes wheels for CPython 3.11 and 3.13 ONLY --
:: there is no 3.12 wheel. 3.13 also matches the rigging service, so the two can
:: share an environment if you ever want them to.
::
:: The model code itself is vendored under MocapAnything\ -- nothing is cloned.
::
:: Env overrides:
::   MOCAP_PORT=8401            bind port (also MOCAP_HOST)
::   MOCAP_CUDA=12.8            force the CUDA build to target (skip nvidia-smi)
::   MOCAP_CKPT_DIR=...         where the checkpoint is kept (default: under MOCAP_DATA_DIR)
::   MOCAP_DATA_DIR=...         where per-rig bakes are cached (default %LOCALAPPDATA%)
::   MOCAP_SKIP_MODEL=1         don't download the checkpoint
::   MOCAP_SKIP_BPY=1           don't install bpy (use a Blender executable instead)
::   BLENDER=C:\...\blender.exe use this Blender instead of the bpy module

setlocal enabledelayedexpansion
cd /d "%~dp0"
set "PYVER=3.13"

call :ensure_uv || goto :error

if not exist ".venv\Scripts\python.exe" (
  call :setup || goto :error
) else (
  call ".venv\Scripts\activate.bat"
)

python mocap_server.py
goto :eof


:ensure_uv
set "UV="
where uv >nul 2>nul && set "UV=uv"
if not defined UV if exist "%USERPROFILE%\.local\bin\uv.exe" set "UV=%USERPROFILE%\.local\bin\uv.exe"
if not defined UV (
  echo Installing uv ^(Python toolchain manager^)...
  powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://astral.sh/uv/install.ps1 | iex" || exit /b 1
  set "UV=%USERPROFILE%\.local\bin\uv.exe"
)
exit /b 0


:setup
echo Provisioning Python %PYVER% via uv...
"%UV%" python install %PYVER% || exit /b 1

echo Creating virtual environment ^(Python %PYVER%^)...
"%UV%" venv .venv --python %PYVER% || exit /b 1
call ".venv\Scripts\activate.bat"

echo.
echo Installing video-to-motion requirements ^(includes bpy, ~323 MB^)...
"%UV%" pip install -r requirements.txt || exit /b 1
if defined MOCAP_SKIP_BPY (
  echo MOCAP_SKIP_BPY set -- removing bpy; a Blender executable will be needed.
  "%UV%" pip uninstall bpy >nul 2>nul
)

:: --- torch ------------------------------------------------------------------
:: Installed after requirements so nothing in that list can drag it off-version.
:: TORCHARGS covers torch AND torchvision: the bake imports torchvision.transforms.
:: --reinstall-package torch is required for the same reason as in the Kimodo
:: launcher: a CPU torch may already satisfy the version, local +cuXXX tag and
:: all, so uv would otherwise "audit" it and leave the service on the CPU.
echo.
echo Detecting CUDA to select a torch build...
set "TORCHARGS="
for /f "delims=" %%a in ('python select_torch.py') do set "TORCHARGS=%%a"
if defined TORCHARGS (
  echo Installing torch: !TORCHARGS!
  "%UV%" pip install --reinstall-package torch --reinstall-package torchvision !TORCHARGS! || exit /b 1
) else (
  echo [warn] No NVIDIA GPU detected -- installing CPU torch.
  echo        Video-to-motion will be unusably slow without a CUDA GPU.
  "%UV%" pip install torch torchvision || exit /b 1
)

python -c "import torch,sys; sys.exit(0 if torch.cuda.is_available() else 1)" 2>nul
if errorlevel 1 (
  echo.
  echo [warn] torch cannot see a CUDA GPU. Capturing will run on the CPU and be
  echo        very slow. Check 'nvidia-smi', then reinstall torch with:
  echo          .venv\Scripts\activate ^&^& uv pip install --reinstall-package torch --reinstall-package torchvision !TORCHARGS!
)

:: --- Blender ----------------------------------------------------------------
:: Preparing a rig needs Blender. `bpy` from requirements.txt is the normal path;
:: this only reports which one will be used, so a missing Blender is discovered
:: now rather than minutes into the first bake.
echo.
python -c "import bpy,sys; print('Blender (bpy module):', bpy.app.version_string)" 2>nul
if errorlevel 1 (
  python -c "import sys; sys.path.insert(0,'.'); import mocap_paths as p; b=p.find_blender(); print('Blender executable:', b) if b else sys.exit(1)" 2>nul
  if errorlevel 1 (
    echo [warn] No bpy module and no Blender executable found. Capturing motion will
    echo        work, but PREPARING a rig will fail. Install Blender 3.6+ and set
    echo        BLENDER, or reinstall without MOCAP_SKIP_BPY.
  )
)

:: --- weights ----------------------------------------------------------------
echo.
if defined MOCAP_SKIP_MODEL (
  echo MOCAP_SKIP_MODEL set -- skipping checkpoint download.
) else (
  echo Downloading the MoCapAnything checkpoint ^(~460 MB; first run only^)...
  python download.py || echo [warn] checkpoint download failed; run "python download.py" manually.
)

echo.
echo Setup complete.
exit /b 0


:error
echo.
echo Setup failed. See the messages above.
exit /b 1
