@echo off
echo ========================================
echo       Wolf Language Bot - Windows
echo ========================================
echo.

node --version >nul 2>&1
if %errorlevel% neq 0 (
    echo [خطأ] Node.js غير مثبت!
    echo حمّله من: https://nodejs.org
    pause
    exit /b 1
)

if not exist ".env" (
    echo [تنبيه] ملف .env غير موجود!
    echo انسخ .env.example الى .env وضع مفتاح Gemini API
    pause
    exit /b 1
)

if not exist "node_modules" (
    echo [*] جاري تثبيت الحزم...
    npm install
)

echo [*] جاري تشغيل البوت...
echo.
node bot.js
pause
