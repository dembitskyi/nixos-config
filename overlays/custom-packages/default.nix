# keep-sorted start skip_lines=1
(final: prev: {
  browser-use = import ../pkgs/browser-use.nix { pkgs = final; };
  # Patched docling (docling-parse disabled). The library lives in
  # pythonPackagesExtensions below; expose the CLI the nixpkgs way.
  docling = final.python3Packages.toPythonApplication final.python3Packages.docling;
  greasemonkeyUserscripts = import ../pkgs/greasemonkey-userscripts/default.nix { pkgs = final; };
  lnav = prev.lnav.overrideAttrs (old: {
    postPatch = (old.postPatch or "") + ''
      # Make Ctrl-C a no-op so it cannot accidentally quit lnav.
      # Use :q / :quit to exit.
      substituteInPlace src/lnav.cc \
        --replace-fail \
          '(void) signal(SIGINT, sigint);' \
          '(void) signal(SIGINT, SIG_IGN);'
    '';
  });
  opencode = prev.opencode.overrideAttrs (old: {
    postPatch = (old.postPatch or "") + ''
      # Bump TUI message fetch limit from 100 to 1000.
      substituteInPlace packages/tui/src/context/sync.tsx \
        --replace-fail 'limit: 100' 'limit: 1000'
    '';
  });
  otterwiki = final.callPackage ../pkgs/otterwiki.nix { };

  # Patched docling as an importable library (across Python sets); the
  # top-level `docling` above wraps this as the CLI.
  pythonPackagesExtensions = (prev.pythonPackagesExtensions or [ ]) ++ [
    (python-final: _python-prev: {
      docling = python-final.callPackage ../pkgs/docling { };
    })
  ];
})
# keep-sorted end
