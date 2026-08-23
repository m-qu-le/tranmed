@echo off
setlocal
call "%~dp0Import StudyMed Local.cmd" %*
exit /b %ERRORLEVEL%
