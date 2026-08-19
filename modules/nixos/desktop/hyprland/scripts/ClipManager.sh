#!/usr/bin/env bash

tmp_dir="/tmp/cliphist_previews"

trap 'rm -rf "$tmp_dir"' EXIT

mkdir -p "$tmp_dir"

read -r -d '' gawk_prog <<EOF
/^[0-9]+\s<meta http-equiv=/ { next }
/^[0-9]+\s<img/ { next }
match(\$0, /^([0-9]+)\s(\[\[\s)?binary.*(jpg|jpeg|png|bmp)/, grp) {
    system("cliphist decode " grp[1] " > " tmp_dir "/" grp[1] "." grp[3])
    print \$0"\0icon\x1f"tmp_dir"/"grp[1]"."grp[3]
    next
}
1
EOF

result=$(cliphist list | gawk -v tmp_dir="$tmp_dir" "$gawk_prog" | fuzzel --dmenu)

[ -n "$result" ] && cliphist decode <<<"$result" | wl-copy
