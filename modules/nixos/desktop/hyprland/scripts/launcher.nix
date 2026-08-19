{
  lib,
  pkgs,
  ...
}:
let
  fuzzel = "${pkgs.fuzzel}/bin/fuzzel";
  sudoRun = pkgs.writeShellScriptBin "sudo-run" ''
    [ "$#" -gt 0 ] || exit 0
    bin=$(command -v "$1") || exit 1
    shift
    case "$WAYLAND_DISPLAY" in
      /*) wl=$WAYLAND_DISPLAY ;;
      *) wl="$XDG_RUNTIME_DIR/$WAYLAND_DISPLAY" ;;
    esac
    exec run0 \
      --setenv=WAYLAND_DISPLAY="$wl" \
      --setenv=XDG_RUNTIME_DIR="$XDG_RUNTIME_DIR" \
      --setenv=PATH="$PATH" \
      "$bin" "$@"
  '';
in
pkgs.writeShellScriptBin "launcher" ''
  if pidof fuzzel >/dev/null; then
    pkill fuzzel
    exit 0
  fi

  bins() {
    find -L ''${PATH//:/ } -maxdepth 1 -type f -executable -printf '%f\n' 2>/dev/null | sort -u
  }

  case $1 in
  drun-sudo)
    exec ${fuzzel} --prompt "root  " --launch-prefix "${lib.getExe sudoRun}"
    ;;
  run)
    bin=$(bins | ${fuzzel} --dmenu --prompt "run  ") || exit 0
    [ -n "$bin" ] && setsid -f $bin >/dev/null 2>&1
    ;;
  run-sudo)
    bin=$(bins | ${fuzzel} --dmenu --prompt "root  ") || exit 0
    [ -n "$bin" ] && setsid -f ${lib.getExe sudoRun} $bin >/dev/null 2>&1
    ;;
  *)
    exec ${fuzzel}
    ;;
  esac
''
