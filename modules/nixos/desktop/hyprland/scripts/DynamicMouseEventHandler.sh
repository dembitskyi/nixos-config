#!/usr/bin/env bash
#exec >> /tmp/dynamic-mouse.log 2>&1
#set -x
TYPE=$1

windowInfo=$(hyprctl activewindow -j)
if echo $windowInfo | jq -e '.initialClass == "chromium-browser"' > /dev/null; then
  if [ "$TYPE" == "mouse_down" ]; then
    hyprctl dispatch workspace e+1
  fi
elif echo $windowInfo | jq -e '.initialClass == "org.qutebrowser.qutebrowser"' > /dev/null; then
  if [ "$TYPE" == "mouse_left" ]; then
    qutebrowser :tab-next
  elif [ "$TYPE" == "mouse_press_down" ]; then
    qutebrowser :tab-close
  elif [ "$TYPE" == "mouse_right" ]; then
    qutebrowser :tab-prev
  elif [ "$TYPE" == "mouse_down" ]; then
    qutebrowser :back
  elif [ "$TYPE" == "mouse_up" ]; then
    qutebrowser :forward
  fi
fi
