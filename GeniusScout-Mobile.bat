@echo off
setlocal
title Genius Scout - Acces telephone
cd /d "%~dp0"

echo.
echo  ================================================
echo   GENIUS SCOUT - Acces depuis ton iPhone
echo  ================================================
echo.

REM --- Regle pare-feu (une seule fois, necessite admin) -----------------
netsh advfirewall firewall show rule name="Genius Scout 3033" >nul 2>&1
if errorlevel 1 (
    echo  Ouverture du port 3033 dans le pare-feu...
    netsh advfirewall firewall add rule name="Genius Scout 3033" dir=in action=allow protocol=TCP localport=3033 >nul 2>&1
    if errorlevel 1 (
        echo.
        echo  [!] Impossible d'ajouter la regle pare-feu.
        echo      Le telephone ne pourra PAS se connecter.
        echo      Fais un clic droit sur ce fichier -^> "Executer en tant
        echo      qu'administrateur" UNE SEULE FOIS, puis relance normalement.
        echo.
        pause
    ) else (
        echo  Port 3033 autorise.
    )
) else (
    echo  Pare-feu deja configure.
)

REM --- IP locale --------------------------------------------------------
set "LANIP="
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /c:"IPv4"') do (
    if not defined LANIP (
        for /f "tokens=1" %%b in ("%%a") do set "LANIP=%%b"
    )
)
if not defined LANIP set "LANIP=<IP introuvable>"

echo.
echo  ------------------------------------------------
echo   SUR TON IPHONE (meme WiFi que ce PC) :
echo.
echo        http://%LANIP%:3033/contacts
echo.
echo   Puis : Partager -^> "Sur l'ecran d'accueil"
echo  ------------------------------------------------
echo.
echo  Laisse cette fenetre ouverte pendant l'utilisation.
echo.

REM 0.0.0.0 = ecoute sur toutes les interfaces (sinon localhost seulement,
REM et le telephone ne voit rien).
npx next dev --hostname 0.0.0.0 --port 3033

echo.
echo  Le serveur s'est arrete. Code : %ERRORLEVEL%
pause >nul
