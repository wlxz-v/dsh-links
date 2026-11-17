@echo off
setlocal
set "TMP_DIR=D:\DSH\android-tools\tmp"
if not exist "%TMP_DIR%" mkdir "%TMP_DIR%"
set "TEMP=%TMP_DIR%"
set "TMP=%TMP_DIR%"
set "USERPROFILE=%TMP_DIR%"
set "ANDROID_USER_HOME=D:\DSH\android-tools\android-home"
set "JAVA_HOME=D:\DSH\android-tools\jdk-21.0.13"
set "ANDROID_HOME=D:\DSH\android-tools\sdk"
set "ANDROID_SDK_ROOT=D:\DSH\android-tools\sdk"
set "GRADLE_USER_HOME=D:\DSH\android-tools\gradle-home9"
set "PATH=%JAVA_HOME%\bin;C:\Windows\System32;C:\Windows;C:\Windows\System32\Wbem"

pushd "%~dp0..\apps\android"
"%JAVA_HOME%\bin\java.exe" -Xmx2048m -Dfile.encoding=UTF-8 -Djava.io.tmpdir=D:/DSH/android-tools/tmp -Duser.home=D:/DSH/android-tools/tmp -Dorg.gradle.appname=gradle ^
  -classpath "D:\DSH\android-tools\gradle-9.5.0\gradle-9.5.0\lib\gradle-launcher-9.5.0.jar" ^
  org.gradle.launcher.GradleMain :app:assembleDebug :app:testDebugUnitTest :app:lintDebug ^
  -Dorg.gradle.jvmargs="-Xmx2048m -Dfile.encoding=UTF-8 -Djava.io.tmpdir=D:/DSH/android-tools/tmp -Duser.home=D:/DSH/android-tools/tmp" ^
  --offline --console=plain --no-daemon -Pkotlin.compiler.execution.strategy=in-process
set "ERR=%ERRORLEVEL%"
popd
exit /b %ERR%
