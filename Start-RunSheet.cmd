@echo off
title Meeting Run Sheet
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0MeetingRunSheet.ps1" %*
