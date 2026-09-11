@echo off
title Genius Scout - Chrome Spotify (session credits)

echo.
echo  ================================================
echo   CHROME SPOTIFY - Session pour les credits
echo  ================================================
echo.
echo  Les credits producteurs de Spotify ne sont
echo  visibles QUE si tu es connecte a ton compte.
echo.
echo  Cette fenetre ouvre un Chrome dedie a Genius
echo  Scout. Connecte-toi a Spotify dedans, puis
echo  LAISSE-LE OUVERT pendant tes scans.
echo.

set "CHROME="
if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" set "CHROME=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" set "CHROME=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if exist "%LocalAppData%\Google\Chrome\Application\chrome.exe" set "CHROME=%LocalAppData%\Google\Chrome\Application\chrome.exe"

if "%CHROME%"=="" (
    echo  [ERREUR] Chrome introuvable.
    echo  Installe Google Chrome puis relance ce fichier.
    pause
    exit /b 1
)

REM Dedicated profile so it never clashes with your normal Chrome windows.
set "PROFILE=%USERPROFILE%\GeniusScoutData\ChromeProfile"
if not exist "%PROFILE%" mkdir "%PROFILE%"

REM Port 9333: 9222 is squatted by Adobe UXP on this machine.
echo  Lancement de Chrome (port de debug 9333)...
echo.
start "" "%CHROME%" --remote-debugging-port=9333 --user-data-dir="%PROFILE%" "https://open.spotify.com"

echo  ------------------------------------------------
echo   1. Connecte-toi a Spotify dans la fenetre qui
echo      vient de s'ouvrir (une seule fois).
echo   2. Laisse ce Chrome ouvert.
echo   3. Lance tes scans dans Genius Scout.
echo  ------------------------------------------------
echo.
echo  Tu peux fermer cette fenetre noire.
timeout /t 8 /nobreak >nul
