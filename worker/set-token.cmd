@echo off
rem Saves a new Mood AI worker token into worker\.env (git-ignored, never committed).
rem 1) Mood AI Control Center > Laptop server > New token (needs your authenticator code) > copy the token shown once.
rem 2) Double-click this file, paste the token (right-click pastes), press Enter.
title Mood AI - set worker token
cd /d "%~dp0"
echo.
echo Paste the new worker token from the Mood AI Control Center (starts with mw_), then press Enter:
set /p TOKEN=Token:
node -e "const fs=require('fs');const t=(process.env.TOKEN||'').trim();if(!/^mw_[0-9a-f]{64}$/.test(t)){console.log('That is not a worker token (mw_ + 64 characters). Nothing changed.');process.exit(1)}const f='.env';let s=fs.existsSync(f)?fs.readFileSync(f,'utf8'):'';s=/^MOOD_AI_WORKER_TOKEN=.*$/m.test(s)?s.replace(/^MOOD_AI_WORKER_TOKEN=.*$/m,'MOOD_AI_WORKER_TOKEN='+t):s+(s.endsWith('\n')||!s?'':'\n')+'MOOD_AI_WORKER_TOKEN='+t+'\n';fs.writeFileSync(f,s);console.log('Saved (token ends ...'+t.slice(-4)+'). Now start start-worker.cmd.')"
set TOKEN=
echo.
pause
