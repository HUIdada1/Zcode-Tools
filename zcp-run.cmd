@echo off
rem zcode-toolkit one-click entry point for Windows.
rem
rem Finds a usable Python and forwards all arguments to zcp_pipeline.py.
rem
rem Usage:
rem   zcp-run.cmd                 full automated run
rem   zcp-run.cmd --no-deploy     build + test only, do not touch the client
rem   zcp-run.cmd --unattended    unattended mode (for CI)
rem
rem NOTE 1: this file is deliberately pure ASCII. cmd.exe parses .cmd/.bat files
rem using the OEM code page (936/GBK on Chinese Windows), so UTF-8 comments with
rem non-ASCII characters corrupt the parser and every subsequent line errors out
rem with "is not recognized as an internal or external command".
rem Keep it ASCII-only.
rem
rem NOTE 2: this file is kept CRLF via .gitattributes ("*.cmd text eol=crlf").
rem LF-only happens to work with today's cmd.exe, so that rule is a defensive
rem convention rather than a fix for an observed failure: batch labels, goto and
rem multi-line blocks have historically misparsed under pure LF.
rem
rem NOTE 3 (this one IS a real fix): the Windows Python launcher `py` resolves a
rem script's shebang line. Our scripts start with `#!/usr/bin/env python3`, so a
rem bare `py script.py` makes the launcher try to exec the Unix path
rem /usr/bin/env and die with rc=9009 and NO output at all -- the one-click
rem entry point was silently broken on every machine that has `py`. Verified:
rem   py    _t_shebang.py   -> rc=9009, no output
rem   py -3 _t_shebang.py   -> rc=0
rem `py -3 script.py` skips shebang handling, which is why the probe below
rem registers the two-token form "py -3" instead of a bare "py".

setlocal
set "SCRIPT_DIR=%~dp0"
cd /d "%SCRIPT_DIR%"

set "PY="
rem Probe candidates in order; the first one that answers wins.
rem The probe is deliberately `-c` based and each candidate is registered in a
rem form that is safe for our shebang-carrying scripts.
py -3 -c "import sys" >nul 2>&1 && set "PY=py -3"
if not defined PY python -c "import sys" >nul 2>&1 && set "PY=python"
if not defined PY python3 -c "import sys" >nul 2>&1 && set "PY=python3"

if not defined PY (
    echo [x] No usable Python found.
    echo     Windows: winget install -e --id Python.Python.3.12
    echo     Or download from https://www.python.org/downloads/windows/
    echo     and make sure to tick "Add python.exe to PATH".
    rem Do not let the window vanish when double-clicked
    pause
    exit /b 2
)

set "PYTHONIOENCODING=utf-8"
%PY% "%SCRIPT_DIR%zcp_pipeline.py" %*
set "RC=%ERRORLEVEL%"

rem Pause only when double-clicked (no arguments and parent cmd line contains this script name),
rem not when invoked from an existing console or scripted with arguments.
if "%~1"=="" (
    echo %cmdcmdline% | find /i "%~nx0" >nul
    if not errorlevel 1 pause
)

exit /b %RC%
