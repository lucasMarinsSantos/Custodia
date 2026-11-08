#!/usr/bin/env bash
# Prepara ANDROID_HOME / JAVA_HOME / PATH no Linux (usado pelos outros scripts).
if [ -z "${ANDROID_HOME:-}" ]; then
  if [ -n "${ANDROID_SDK_ROOT:-}" ]; then export ANDROID_HOME="$ANDROID_SDK_ROOT";
  elif [ -d "$HOME/Android/Sdk" ]; then export ANDROID_HOME="$HOME/Android/Sdk"; fi
fi
if [ -z "${JAVA_HOME:-}" ]; then
  for d in /opt/android-studio/jbr /usr/local/android-studio/jbr "$HOME/android-studio/jbr" /snap/android-studio/current/jbr; do
    if [ -x "$d/bin/java" ]; then export JAVA_HOME="$d"; break; fi
  done
fi
[ -n "${JAVA_HOME:-}" ] && export PATH="$JAVA_HOME/bin:$PATH"
[ -n "${ANDROID_HOME:-}" ] && export PATH="$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$PATH"
true
