# keep-sorted start skip_lines=1
(final: prev: {
  browser-use = import ../pkgs/browser-use.nix { pkgs = final; };
  docling = final.callPackage ../pkgs/docling { };
  greasemonkeyUserscripts = import ../pkgs/greasemonkey-userscripts/default.nix { pkgs = final; };
  otterwiki = final.callPackage ../pkgs/otterwiki.nix { };
})
# keep-sorted end
