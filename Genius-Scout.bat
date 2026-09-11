@echo off
setlocal
title Genius Scout
cd /d "%~dp0"

REM ============================================================
REM  Genius Scout - lanceur unique (raccourci bureau)
REM
REM  Structure en goto, PAS en blocs parentheses : dans un bloc
REM  (...) cmd developpe %VAR% au moment du PARSE, avant les
REM  "set" internes (Chrome ne se lancait jamais apres un boot).
REM
REM  Donnees et profil Chrome sous %USERPROFILE%\GeniusScoutData :
REM  l'ancien emplacement AppData\Local a ete purge deux fois par
REM  un nettoyeur (base vide + sessions perdues a chaque fois).
REM ============================================================

set "PORT=3033"
set "URL=http://localhost:%PORT%"
set "PS=powershell -NoProfile -ExecutionPolicy Bypass -Command"
set "GSDATA=%USERPROFILE%\GeniusScoutData"
set "PROFILE=%GSDATA%\ChromeProfile"

REM --- Localisation de Chrome (niveau racine, jamais dans un bloc) ---
set "CHROME="
if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" set "CHROME=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" set "CHROME=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if exist "%LocalAppData%\Google\Chrome\Application\chrome.exe" set "CHROME=%LocalAppData%\Google\Chrome\Application\chrome.exe"

echo.
echo  ================================================
echo    GENIUS SCOUT
echo  ================================================
echo.

if exist node_modules goto :chrome
echo  [1/4] Installation des dependances...
call npm install
if errorlevel 1 (
  echo  Echec de npm install
  pause
  exit /b 1
)

:chrome
REM --- Chrome dedie (reduit) : sessions Spotify + Instagram ---
%PS% "$c=New-Object Net.Sockets.TcpClient; try{[void]$c.ConnectAsync('127.0.0.1',9333).Wait(500)}catch{}; if($c.Connected){exit 0}else{exit 1}"
if not errorlevel 1 (
  echo  [2/4] Chrome dedie deja ouvert.
  goto :server
)
if not defined CHROME (
  echo  [2/4] ATTENTION : Chrome introuvable sur ce PC.
  goto :server
)
echo  [2/4] Ouverture du Chrome dedie - credits Spotify...
REM Recupere les sessions de l'ancien emplacement, une seule fois.
if not exist "%PROFILE%" if exist "%LocalAppData%\GeniusScoutChrome" robocopy "%LocalAppData%\GeniusScoutChrome" "%PROFILE%" /E /NFL /NDL /NJH /NJS >nul
if not exist "%PROFILE%" mkdir "%PROFILE%"
REM Port 9333 : le 9222 est squatte par Adobe UXP. /min : la fenetre
REM reste dans la barre des taches, l'app s'ouvre dans TON Chrome normal.
start /min "" "%CHROME%" --remote-debugging-port=9333 --user-data-dir="%PROFILE%" "https://open.spotify.com"
%PS% "for($i=0;$i -lt 20;$i++){$c=New-Object Net.Sockets.TcpClient; try{[void]$c.ConnectAsync('127.0.0.1',9333).Wait(500)}catch{}; if($c.Connected){exit 0}; Start-Sleep -Milliseconds 700}; exit 1"
if errorlevel 1 (
  echo         ATTENTION : le Chrome dedie n'a pas repondu sur le port 9333.
)

:server
%PS% "$c=New-Object Net.Sockets.TcpClient; try{[void]$c.ConnectAsync('127.0.0.1',%PORT%).Wait(500)}catch{}; if($c.Connected){exit 0}else{exit 1}"
if not errorlevel 1 (
  echo  [3/4] Serveur deja en cours sur le port %PORT%.
  goto :attente
)
echo  [3/4] Demarrage du serveur sur le port %PORT%...
start "Genius Scout - Serveur (ne pas fermer)" cmd /k "cd /d "%~dp0" && npx next dev -p %PORT%"

:attente
echo  [4/4] Attente du serveur...
%PS% "for($i=0;$i -lt 90;$i++){try{$r=Invoke-WebRequest -Uri '%URL%' -UseBasicParsing -TimeoutSec 3; if($r.StatusCode -ge 200){exit 0}}catch{}; Start-Sleep -Milliseconds 700}; exit 1"
if errorlevel 1 (
  echo.
  echo  Le serveur n'a pas repondu. Regarde la fenetre
  echo  "Genius Scout - Serveur" pour le message d'erreur.
  pause
  exit /b 1
)

start "" "%URL%"

echo.
echo  ================================================
echo    Genius Scout est ouvert : %URL%
echo    Pour arreter : ferme la fenetre du serveur.
echo  ================================================
timeout /t 3 /nobreak >nul
exit /b 0
