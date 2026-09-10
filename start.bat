@echo off
chcp 65001 >nul
title Luxora API (порт 2222)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-server.ps1"
pause
